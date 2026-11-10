#!/usr/bin/env python3
"""Export official realesr-general-x4v3 weights to ONNX.

The architecture is SRVGGNetCompact from Real-ESRGAN (BSD-3-Clause, Xintao Wang).
PReLU is rewritten as ReLU / Sub / Mul / Add so the graph stays on operators
ONNX Runtime WebGPU implements (PRelu itself is not in that execution provider).
Numerically this is the same function as channel-wise PReLU.

This script is the only component that downloads weights. Runtime never calls it.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
import onnx
import torch
import torch.nn.functional as F
from torch import nn

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models"
CACHE = MODEL_DIR / "cache"
PTH_NAME = "realesr-general-x4v3.pth"
ONNX_NAME = "realesr-general-x4v3.onnx"
SOURCE_URL = (
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/" + PTH_NAME
)
# Published digest for the official v0.2.5.0 asset. Bootstrap refuses other bytes.
EXPECTED_SHA256 = "8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292"

NUM_FEAT = 64
NUM_CONV = 32
UPSCALE = 4
ALLOWED_OPS = {
    "Conv",
    "Relu",
    "Add",
    "Mul",
    "Sub",
    "DepthToSpace",
    "Resize",
    "Constant",
    "Identity",
}


class ExportPReLU(nn.Module):
    """Channel-wise PReLU using only Relu, Sub, Mul, and Add."""

    def __init__(self, num_parameters: int) -> None:
        super().__init__()
        self.weight = nn.Parameter(torch.ones(1, num_parameters, 1, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        positive = torch.relu(x)
        return positive + (x - positive) * self.weight


class SRVGGNetCompact(nn.Module):
    """Compact VGG-style super-resolution network (Real-ESRGAN SRVGGNetCompact).

    Upsampling happens in the last layer. A nearest-neighbor residual is added
    so the convolutions learn the residual, matching the official forward().
    """

    def __init__(
        self,
        num_in_ch: int = 3,
        num_out_ch: int = 3,
        num_feat: int = NUM_FEAT,
        num_conv: int = NUM_CONV,
        upscale: int = UPSCALE,
    ) -> None:
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList()
        self.body.append(nn.Conv2d(num_in_ch, num_feat, 3, 1, 1))
        self.body.append(ExportPReLU(num_feat))
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(ExportPReLU(num_feat))
        self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        base = F.interpolate(x, scale_factor=self.upscale, mode="nearest")
        return out + base


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_weights(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        got = sha256_file(dest)
        if got == EXPECTED_SHA256:
            print(f"using cached {dest} sha256={got}")
            return
        print(f"cached file hash mismatch ({got}); re-downloading")
        dest.unlink()
    print(f"downloading {SOURCE_URL}")
    request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "terrance-video-remaster-bootstrap"})
    with urllib.request.urlopen(request, timeout=120) as response:
        dest.write_bytes(response.read())
    got = sha256_file(dest)
    if got != EXPECTED_SHA256:
        dest.unlink()
        raise SystemExit(
            f"refusing weights: sha256 {got} != expected {EXPECTED_SHA256} from {SOURCE_URL}"
        )
    print(f"verified sha256 {got}")


def load_state_dict(path: Path) -> dict:
    try:
        blob = torch.load(path, map_location="cpu", weights_only=True)
    except Exception:
        blob = torch.load(path, map_location="cpu", weights_only=False)
    if isinstance(blob, dict) and "params_ema" in blob:
        return blob["params_ema"]
    if isinstance(blob, dict) and "params" in blob:
        return blob["params"]
    if isinstance(blob, dict):
        return blob
    raise SystemExit(f"unrecognized checkpoint type: {type(blob)}")


def load_into(model: SRVGGNetCompact, state: dict) -> None:
    mapped = {}
    own = model.state_dict()
    missing = [key for key in own if key not in state]
    if missing:
        raise SystemExit(f"checkpoint missing keys, first ones: {missing[:8]}")
    for key, dest in own.items():
        src = state[key]
        if tuple(src.shape) == tuple(dest.shape):
            mapped[key] = src
            continue
        if src.ndim == 1 and tuple(dest.shape) == (1, src.shape[0], 1, 1):
            mapped[key] = src.view(1, -1, 1, 1)
            continue
        raise SystemExit(f"cannot map {key}: checkpoint {tuple(src.shape)} vs module {tuple(dest.shape)}")
    model.load_state_dict(mapped, strict=True)


def golden_pattern(height: int = 32, width: int = 32) -> np.ndarray:
    image = np.zeros((height, width, 3), dtype=np.uint8)
    ys, xs = np.mgrid[0:height, 0:width]
    image[..., 0] = np.mod(xs * 13 + ys * 3, 256).astype(np.uint8)
    image[..., 1] = np.mod(xs * 5 + 40, 256).astype(np.uint8)
    image[..., 2] = np.mod(ys * 11 + 15, 256).astype(np.uint8)
    image[6:18, 4:16] = (20, 20, 20)
    image[6:18, 16:28] = (235, 235, 235)
    image[20:28, 8:24] = (180, 40, 40)
    return image


def to_nchw(image: np.ndarray) -> torch.Tensor:
    array = image.astype(np.float32) / 255.0
    return torch.from_numpy(array.transpose(2, 0, 1)[None].copy())


def from_nchw(tensor: torch.Tensor) -> np.ndarray:
    array = tensor.detach().float().clamp(0, 1).cpu().numpy()[0]
    return np.rint(array.transpose(1, 2, 0) * 255.0).astype(np.uint8)


def bicubic_x4(image: np.ndarray) -> np.ndarray:
    import cv2

    height, width = image.shape[:2]
    return cv2.resize(image, (width * 4, height * 4), interpolation=cv2.INTER_CUBIC)


def export_onnx(model: nn.Module, dest: Path) -> None:
    model.eval()
    dummy = torch.zeros(1, 3, 32, 32, dtype=torch.float32)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        torch.onnx.export(
            model,
            dummy,
            str(dest),
            dynamo=False,
            opset_version=17,
            input_names=["input"],
            output_names=["output"],
            dynamic_axes={"input": {2: "height", 3: "width"}, "output": {2: "height_x4", 3: "width_x4"}},
            do_constant_folding=True,
        )
    except TypeError:
        torch.onnx.export(
            model,
            dummy,
            str(dest),
            opset_version=17,
            input_names=["input"],
            output_names=["output"],
            dynamic_axes={"input": {2: "height", 3: "width"}, "output": {2: "height_x4", 3: "width_x4"}},
            do_constant_folding=True,
        )


def assert_ops(path: Path) -> list[str]:
    model = onnx.load(str(path))
    onnx.checker.check_model(model)
    ops = sorted({node.op_type for node in model.graph.node})
    unexpected = sorted(set(ops) - ALLOWED_OPS)
    if unexpected:
        raise SystemExit(f"ONNX graph has operators outside the ORT Web allow-list: {unexpected} (all={ops})")
    if "Conv" not in ops:
        raise SystemExit("ONNX graph has no Conv nodes; refusing a non-neural export")
    return ops


def main() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    weights = CACHE / PTH_NAME
    download_weights(weights)
    state = load_state_dict(weights)
    model = SRVGGNetCompact()
    load_into(model, state)
    model.eval()

    pattern = golden_pattern()
    with torch.no_grad():
        reference = from_nchw(model(to_nchw(pattern)))
    bicubic = bicubic_x4(pattern)
    if reference.shape != bicubic.shape:
        raise SystemExit(f"shape mismatch reference {reference.shape} bicubic {bicubic.shape}")
    delta = float(np.mean(np.abs(reference.astype(np.int16) - bicubic.astype(np.int16))))
    print(f"mean abs diff vs bicubic on golden pattern: {delta:.3f}")
    if delta < 3.0:
        raise SystemExit("export output is too close to bicubic; refusing a fake upsample stub")

    onnx_path = MODEL_DIR / ONNX_NAME
    export_onnx(model, onnx_path)
    ops = assert_ops(onnx_path)
    print("onnx ops:", ", ".join(ops))

    golden_path = MODEL_DIR / "golden.npz"
    np.savez_compressed(golden_path, image=pattern, output=reference, bicubic=bicubic)

    manifest = {
        "architecture": "SRVGGNetCompact",
        "variant": "realesr-general-x4v3",
        "num_in_ch": 3,
        "num_out_ch": 3,
        "num_feat": NUM_FEAT,
        "num_conv": NUM_CONV,
        "upscale": UPSCALE,
        "activation": "prelu rewritten as relu/sub/mul/add (same math, WebGPU-safe ops)",
        "source_url": SOURCE_URL,
        "source_sha256": EXPECTED_SHA256,
        "onnx_file": ONNX_NAME,
        "onnx_sha256": sha256_file(onnx_path),
        "opset": 17,
        "ops": ops,
        "input": "input float32 NCHW RGB in [0, 1], dynamic H and W",
        "output": "output float32 NCHW RGB, about [0, 1], H*4 and W*4",
        "golden_mean_abs_diff_vs_bicubic": round(delta, 6),
        "license": "BSD-3-Clause. Weights and architecture by Xintao Wang / Real-ESRGAN.",
        "not_a_bicubic_stub": True,
    }
    (MODEL_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {onnx_path} ({onnx_path.stat().st_size} bytes)")
    print(f"wrote {golden_path}")


if __name__ == "__main__":
    sys.exit(main())
