import subprocess
from pathlib import Path

import numpy as np
import pytest

from remaster.amounts import PRESETS, parse_amount
from remaster.cli import build_parser, parse_args
from remaster.denoise import Denoiser, bilateral
from remaster.encode import build_encode_command
from remaster.errors import RemasterError
from remaster.flow import flow_blend, is_scene_cut
from remaster.pipeline import FrameProcessor, pipeline_order
from remaster.probe import durations_are_vfr, validate_video_stream
from remaster.sharpen import additional_unsharp
from remaster.temporal import TemporalStabilizer
from remaster.tiles import tile_starts

ROOT = Path(__file__).resolve().parents[1]


def test_amount_presets_and_rejection():
    assert parse_amount("off", "sharpen") == 0.0
    assert parse_amount("LOW", "denoise") == PRESETS["low"]
    assert parse_amount("medium", "denoise") == 0.5
    assert parse_amount("high", "sharpen") == 0.75
    assert parse_amount("0", "sharpen") == 0.0
    assert parse_amount("1", "denoise") == 1.0
    assert parse_amount(" 0.40 ", "denoise") == pytest.approx(0.4)
    for bad in ("1.01", "-0.01", "ultra", "nan", "inf"):
        with pytest.raises(RemasterError):
            parse_amount(bad, "sharpen")


def test_parser_defaults_and_rejected_encoders():
    args = parse_args(["--check-deps"])
    assert args.backend == "webgpu"
    assert args.encoder == "libsvtav1"
    assert args.denoise == pytest.approx(0.25)
    assert args.sharpen == pytest.approx(0.0)
    assert args.preset == 8
    assert args.crf == 32
    chosen = parse_args(["--check-deps", "--denoise", "off", "--sharpen", "high", "--backend", "wasm"])
    assert chosen.denoise == 0.0
    assert chosen.sharpen == pytest.approx(0.75)
    assert chosen.backend == "wasm"
    with pytest.raises(SystemExit):
        parse_args(["--check-deps", "--encoder", "libx264"])
    with pytest.raises(SystemExit):
        parse_args(["--check-deps", "--encoder", "libx265"])
    with pytest.raises(SystemExit):
        parse_args(["--check-deps", "--sharpen", "2"])
    known = set()
    for action in build_parser()._actions:
        known.update(action.option_strings)
    readme = (ROOT / "docs" / "desktop-cli.md").read_text(encoding="utf-8")
    used = []
    for line in readme.splitlines():
        if "remaster" not in line:
            continue
        used.extend(token for token in line.split() if token.startswith("--") and token != "--")
    missing = sorted({token.rstrip(".,)") for token in used if token.rstrip(".,)") not in known})
    assert missing == []
    assert (
        "No content moderation or cloud uploads; files stay local; technical input validation only; "
        "setup may download public dependencies/weights; processing offline thereafter."
    ) in readme


def test_pipeline_order_names():
    order = pipeline_order(0.25, 0.0, "libsvtav1")
    assert order.index("denoise") < order.index("realesrgan-compact-ort-web")
    assert order.index("realesrgan-compact-ort-web") < order.index("unsharp-bypass")
    assert order.index("unsharp-bypass") < order.index("basicvsr-style-temporal")
    assert order[-1] == "libsvtav1"
    sharp = pipeline_order(0.0, 0.5, "libaom-av1")
    assert sharp.index("denoise-bypass") < sharp.index("realesrgan-compact-ort-web")
    assert "unsharp-additional" in sharp
    assert "libx264" not in sharp


def test_denoise_off_is_identity_and_skips_filter(monkeypatch):
    frame = np.full((24, 24, 3), 40, np.uint8)
    frame[2, 2] = (255, 0, 0)

    def boom(*_args, **_kwargs):
        raise AssertionError("bilateralFilter ran")

    monkeypatch.setattr("remaster.denoise.cv2.bilateralFilter", boom)
    out = Denoiser(0.0).apply(frame, scene_cut=False)
    assert np.array_equal(out, frame)


def test_denoise_reduces_flat_noise_and_runs_before_upscale():
    rng = np.random.default_rng(0)
    base = np.full((64, 64, 3), 120, np.uint8)
    noisy = np.clip(base.astype(np.int16) + rng.integers(-30, 31, size=base.shape), 0, 255).astype(np.uint8)
    filtered = bilateral(noisy, 0.8)
    assert filtered.std() < noisy.std() * 0.6
    assert not np.array_equal(filtered, noisy)
    seen = []

    def record(frame):
        seen.append(frame.copy())
        return frame

    processor = FrameProcessor(record, denoise=0.8, sharpen=0.0, temporal_strength=0.0, scene_threshold=0.3)
    processor.push(noisy)
    expected = Denoiser(0.8).apply(noisy, scene_cut=False)
    assert np.array_equal(seen[0], expected)
    assert not np.array_equal(seen[0], noisy)


def _contrast(image: np.ndarray) -> float:
    return float(image[:, 24, 0].mean() - image[:, 23, 0].mean())


def test_sharpen_off_is_identity_and_positive_increases_edge(monkeypatch):
    image = np.full((48, 48, 3), 20, np.uint8)
    image[:, 24:] = 230

    def boom(*_args, **_kwargs):
        raise AssertionError("GaussianBlur ran")

    monkeypatch.setattr("remaster.sharpen.cv2.GaussianBlur", boom)
    assert np.array_equal(additional_unsharp(image, 0.0), image)

    monkeypatch.undo()
    off = FrameProcessor(lambda frame: frame.copy(), 0.0, 0.0, 0.0, 0.3).push(image)
    on = FrameProcessor(lambda frame: frame.copy(), 0.0, 0.5, 0.0, 0.3).push(image)
    assert np.array_equal(off, image)
    assert _contrast(on) > _contrast(off)
    assert not np.array_equal(on, off)


def test_scene_cut_resets_and_strength_zero_does_not_blend():
    red = np.full((32, 32, 3), (220, 10, 10), np.uint8)
    green = np.full((32, 32, 3), (10, 220, 10), np.uint8)
    assert is_scene_cut(red, green, 0.3)
    assert not is_scene_cut(red, red, 0.3)
    assert durations_are_vfr([100, 300, 100])
    assert not durations_are_vfr([100, 100, 101])
    with pytest.raises(RemasterError):
        validate_video_stream(
            {
                "width": 32,
                "height": 32,
                "pix_fmt": "yuv420p10le",
                "r_frame_rate": "10/1",
                "avg_frame_rate": "10/1",
            }
        )
    processor = FrameProcessor(lambda frame: frame.copy(), 0.0, 0.0, 1.0, 0.3)
    first = processor.push(red)
    second = processor.push(green)
    assert np.array_equal(first, red)
    assert processor.scene_cuts == [1]
    assert np.array_equal(second, green)
    assert second[..., 0].mean() < 40
    stable = TemporalStabilizer(0.0)
    stable.apply(red, red, scene_cut=False)
    exact = stable.apply(red, green, scene_cut=False)
    assert np.array_equal(exact, green)


def test_temporal_blend_moves_when_frames_agree():
    gradient = np.zeros((32, 32, 3), np.uint8)
    gradient[..., 1] = np.linspace(40, 80, 32, dtype=np.uint8)[None, :]
    previous = np.full((32, 32, 3), 100, np.uint8)
    current = np.full((32, 32, 3), 160, np.uint8)
    blended = flow_blend(gradient, gradient, previous, current, max_alpha=0.55)
    delta = float(np.mean(np.abs(blended.astype(np.int16) - current.astype(np.int16))))
    assert delta > 0.5
    assert delta < float(np.mean(np.abs(previous.astype(np.int16) - current.astype(np.int16))))


def test_encode_command_is_av1_only_and_uses_lp():
    command = build_encode_command(
        ffmpeg="ffmpeg",
        output=Path("/tmp/out file.mkv"),
        width=64,
        height=64,
        fps_num=10,
        fps_den=1,
        encoder="libsvtav1",
        preset=8,
        crf=32,
        threads=3,
        audio_path=Path("/tmp/audio file.mka"),
        color_args=["-colorspace", "bt709"],
        duration_sec=0.4,
        overwrite_placeholder=False,
    )
    assert isinstance(command, list)
    assert command[command.index("-c:v") + 1] == "libsvtav1"
    assert "lp=3" in command[command.index("-svtav1-params") + 1]
    assert "-y" not in command
    joined = " ".join(command)
    for banned in ("libx264", "libx265", "hevc_nvenc", "h264_nvenc"):
        assert banned not in joined
    assert "/tmp/out file.mkv" in command
    assert "/tmp/audio file.mka" in command


def test_tile_starts_match_node():
    completed = subprocess.run(["node", str(ROOT / "tests" / "tiling.test.cjs")], check=True, capture_output=True, text=True)
    assert "tiling ok" in completed.stdout
    script = r"""
const {tileStarts} = require("./worker/infer.js");
const cases = [[100,40,16],[32,192,16],[48,32,8],[64,48,0],[17,16,4],[192,128,32]];
console.log(JSON.stringify(cases.map(([l,t,o]) => tileStarts(l,t,o))));
"""
    completed = subprocess.run(["node", "-e", script], cwd=ROOT, check=True, capture_output=True, text=True)
    import json

    got = json.loads(completed.stdout)
    cases = [(100, 40, 16), (32, 192, 16), (48, 32, 8), (64, 48, 0), (17, 16, 4), (192, 128, 32)]
    for starts, (length, tile, overlap) in zip(got, cases):
        assert starts == tile_starts(length, tile, overlap)


def test_worker_source_is_local_and_has_both_backends():
    script = (ROOT / "worker" / "infer.js").read_text(encoding="utf-8")
    page = (ROOT / "worker" / "index.html").read_text(encoding="utf-8")
    assert 'executionProviders = ["webgpu"]' in script
    assert 'executionProviders = ["wasm"]' in script
    assert "wasmPaths" in script
    assert "https://" not in script
    assert "https://" not in page
    assert "jsdelivr" not in script
    assert "onnxruntime-gpu" not in script
    runtime = "\n".join(path.read_text(encoding="utf-8") for path in (ROOT / "remaster").glob("*.py"))
    assert "urllib.request" not in runtime
    assert "urlopen" not in runtime
    assert "releases/download" not in runtime
    assert "jsdelivr" not in runtime
    for banned in ("nsfw", "moderation", "openai.com", "content-classification"):
        assert banned not in runtime.lower()
    assert (ROOT / "scripts" / "bootstrap_model.py").is_file() or (ROOT / "scripts" / "export_srvgg.py").is_file()
