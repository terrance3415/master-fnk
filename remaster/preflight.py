from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from remaster.errors import RemasterError
from remaster.paths import repo_root

INSTALL_HELP = """
FFmpeg on PATH is not enough unless that binary was built with libsvtav1.
pip does not install FFmpeg or SVT-AV1. The encoder has to be linked into FFmpeg
(--enable-libsvtav1). There is no H.264 or HEVC fallback in this tool.

Check:
  ffmpeg -hide_banner -encoders | grep libsvtav1
On Windows:
  ffmpeg -hide_banner -encoders | findstr libsvtav1

Linux, when the package is missing libsvtav1 (Ubuntu 24.04's ffmpeg package already
enables it; older or minimal builds often do not):
  sudo apt-get install -y build-essential cmake git nasm pkg-config
  git clone --depth 1 --branch v2.1.2 https://gitlab.com/AOMediaCodec/SVT-AV1.git
  cmake -S SVT-AV1 -B SVT-AV1/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON
  cmake --build SVT-AV1/build -j
  sudo cmake --install SVT-AV1/build
  sudo ldconfig
  git clone --depth 1 --branch n7.1 https://github.com/FFmpeg/FFmpeg.git
  cd FFmpeg
  ./configure --prefix=/usr/local --enable-gpl --enable-libsvtav1 --enable-libaom --enable-libopus
  make -j
  sudo make install

Windows:
  Download a current GPL zip from https://github.com/BtbN/FFmpeg-Builds/releases
  (asset name like ffmpeg-master-latest-win64-gpl.zip). Those builds link libsvtav1.
  Unzip it and add the bin directory to PATH. Open a new terminal and rerun the
  encoder check above. libaom-av1 in the list is only the optional slower AV1 encoder.

The default encoder is libsvtav1. The thread cap is the SVT option lp, passed as
  -svtav1-params lp=N
Preflight runs a two-frame encode and reads "Number of logical cores available".
An unknown SVT key is not a successful cap: this build of FFmpeg can ignore a bad
key and still exit 0, so the log line is the check that actually matters.
""".strip()


def resolve_tool(explicit: str | None, env_name: str, executable: str) -> str:
    candidate = explicit or os.environ.get(env_name)
    if candidate:
        path = Path(candidate)
        if path.is_file():
            return str(path)
        found = shutil.which(candidate)
        if found:
            return found
        raise RemasterError(f"{executable} not found at {candidate}\n\n{INSTALL_HELP}", exit_code=2)
    found = shutil.which(executable)
    if not found:
        raise RemasterError(f"{executable} is not on PATH.\n\n{INSTALL_HELP}", exit_code=2)
    return found


def _run(command: list[str], timeout: float = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout)


def assert_ffmpeg_binary(ffmpeg: str) -> str:
    try:
        completed = _run([ffmpeg, "-hide_banner", "-version"], timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RemasterError(f"could not run ffmpeg ({ffmpeg}): {exc}\n\n{INSTALL_HELP}", exit_code=2) from exc
    text = f"{completed.stdout}\n{completed.stderr}"
    if completed.returncode != 0 or "ffmpeg" not in text.lower():
        raise RemasterError(
            f"{ffmpeg} did not answer as ffmpeg.\n{text.strip()}\n\n{INSTALL_HELP}",
            exit_code=2,
        )
    first = text.strip().splitlines()[0] if text.strip() else ffmpeg
    return first


def encoder_list(ffmpeg: str) -> str:
    completed = _run([ffmpeg, "-hide_banner", "-encoders"], timeout=30)
    if completed.returncode != 0:
        raise RemasterError(
            f"could not list ffmpeg encoders.\n{completed.stderr.strip()}\n\n{INSTALL_HELP}",
            exit_code=2,
        )
    return completed.stdout


def assert_encoder_available(ffmpeg: str, encoder: str) -> None:
    listing = encoder_list(ffmpeg)
    if not re.search(rf"\b{re.escape(encoder)}\b", listing):
        raise RemasterError(
            f"ffmpeg has no {encoder} encoder.\n\n{INSTALL_HELP}",
            exit_code=2,
        )


def svt_logical_cores(log: str) -> int | None:
    # SVT-AV1 2.x renamed the line to "Level of Parallelism"
    match = re.search(r"(?:Number of logical cores available|Level of Parallelism):\s*(\d+)", log)
    if not match:
        return None
    return int(match.group(1))


def expected_svt_cores(threads: int) -> int:
    cpus = os.cpu_count() or threads
    return max(1, min(threads, cpus))


def assert_svt_lp(ffmpeg: str, threads: int) -> int:
    """Prove this FFmpeg honors SVT lp. A bad key can still exit 0 on FFmpeg 6.1."""
    command = [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:r=10:d=0.2",
        "-frames:v",
        "2",
        "-c:v",
        "libsvtav1",
        "-preset",
        "8",
        "-crf",
        "40",
        "-pix_fmt",
        "yuv420p",
        "-svtav1-params",
        f"lp={threads}",
        "-f",
        "null",
        "-",
    ]
    try:
        completed = _run(command, timeout=120)
    except subprocess.TimeoutExpired as exc:
        raise RemasterError(f"libsvtav1 preflight timed out: {exc}", exit_code=2) from exc
    log = f"{completed.stderr}\n{completed.stdout}"
    if completed.returncode != 0 or "Error parsing option lp" in log:
        raise RemasterError(
            "libsvtav1 rejected the lp thread cap.\n"
            f"exit {completed.returncode}\n{log[-2000:]}\n\n{INSTALL_HELP}",
            exit_code=2,
        )
    reported = svt_logical_cores(log)
    expected = expected_svt_cores(threads)
    if reported != expected:
        raise RemasterError(
            f"SVT-AV1 reported {reported} logical cores; expected {expected} for lp={threads}. "
            "The encode would not be using the requested thread cap, so it was stopped.\n"
            f"{log[-1500:]}\n\n{INSTALL_HELP}",
            exit_code=2,
        )
    return reported


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def default_model_path() -> Path:
    return repo_root() / "models" / "realesr-general-x4v3.onnx"


def load_manifest() -> dict | None:
    path = repo_root() / "models" / "manifest.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_model(explicit: str | None) -> tuple[Path, dict]:
    path = Path(explicit).expanduser().resolve() if explicit else default_model_path()
    if not path.is_file():
        raise RemasterError(
            f"model file is missing: {path}\n"
            "Runtime does not download weights. From the project directory, with bootstrap "
            "dependencies installed, run:\n"
            "  python scripts/bootstrap_model.py\n"
            "The shipped zip already contains models/realesr-general-x4v3.onnx. "
            "If that file is missing, the bootstrap command re-downloads the official "
            "realesr-general-x4v3.pth and exports ONNX locally.",
            exit_code=2,
        )
    size = path.stat().st_size
    if size < 1_000_000:
        raise RemasterError(
            f"model file {path} is only {size} bytes. The compact Real-ESRGAN ONNX is about 5 MB. "
            "Refusing a placeholder model.",
            exit_code=2,
        )
    digest = sha256_file(path)
    manifest = load_manifest() or {}
    info = {
        "path": str(path),
        "sha256": digest,
        "bytes": size,
        "official_hash_match": False,
        "architecture": manifest.get("architecture", "SRVGGNetCompact"),
        "upscale": int(manifest.get("upscale", 4)),
        "variant": manifest.get("variant", "custom"),
    }
    if manifest.get("onnx_sha256") == digest:
        info["official_hash_match"] = True
        info["variant"] = manifest.get("variant", "realesr-general-x4v3")
        info["upscale"] = int(manifest.get("upscale", 4))
    elif explicit is None:
        raise RemasterError(
            f"models/realesr-general-x4v3.onnx sha256 {digest} does not match models/manifest.json. "
            "Refusing to run a swapped model file. Re-run python scripts/bootstrap_model.py "
            "or restore the shipped model.",
            exit_code=2,
        )
    return path, info


def ort_dist_dir(explicit: str | None) -> Path:
    path = Path(explicit).expanduser().resolve() if explicit else repo_root() / "node_modules" / "onnxruntime-web" / "dist"
    script = path / "ort.all.min.js"
    wasm = path / "ort-wasm-simd-threaded.wasm"
    if not script.is_file() or not wasm.is_file():
        raise RemasterError(
            f"local ONNX Runtime Web assets are missing under {path}. "
            "Run npm ci in the project directory. The worker loads ort.all.min.js and the "
            ".wasm files from this folder over 127.0.0.1. It does not fall back to a CDN.",
            exit_code=2,
        )
    return path


def find_chrome(explicit: str | None) -> str:
    candidate = explicit or os.environ.get("REMASTER_CHROME")
    if candidate:
        path = Path(candidate)
        if path.is_file():
            return str(path)
        found = shutil.which(candidate)
        if found:
            return found
        raise RemasterError(f"Chrome not found at {candidate}", exit_code=2)
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    windows = [
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    ]
    for path in windows:
        if path.is_file():
            return str(path)
    raise RemasterError(
        "Google Chrome was not found. Install Chrome 113 or newer, or set REMASTER_CHROME "
        "to the chrome executable. The neural stage runs in Chrome via ONNX Runtime Web. "
        "On Linux without a GPU, use --backend wasm. WebGPU needs a working GPU adapter "
        "(Vulkan on Linux, a current driver on Windows). chrome://gpu should show WebGPU "
        "as available. This tool does not switch to WASM when WebGPU is missing.",
        exit_code=2,
    )


def chrome_version(chrome: str) -> str:
    try:
        completed = _run([chrome, "--version"], timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RemasterError(f"could not run Chrome ({chrome}): {exc}", exit_code=2) from exc
    text = (completed.stdout or completed.stderr or "").strip()
    if completed.returncode != 0 or not text:
        raise RemasterError(f"Chrome did not report a version: {text}", exit_code=2)
    return text.splitlines()[0]


def resolve_threads(requested: int) -> int:
    if requested == 0:
        return max(1, min(8, os.cpu_count() or 1))
    if requested < 1 or requested > 64:
        raise RemasterError("--threads must be 0 (auto, capped at 8) or 1..64", exit_code=2)
    return requested


def validate_encode_knobs(encoder: str, preset: int, crf: int) -> None:
    if encoder not in {"libsvtav1", "libaom-av1"}:
        raise RemasterError(
            f"encoder {encoder} is not available. Use libsvtav1 (default) or libaom-av1. "
            "H.264 and HEVC are not fallbacks.",
            exit_code=2,
        )
    if crf < 0 or crf > 63:
        raise RemasterError("--crf must be 0..63", exit_code=2)
    if encoder == "libsvtav1":
        if preset < 0 or preset > 13:
            raise RemasterError("libsvtav1 --preset must be 0..13 (higher is faster; default 8)", exit_code=2)
    elif preset < 0 or preset > 8:
        raise RemasterError(
            "libaom-av1 --preset is -cpu-used and must be 0..8 (higher is faster). "
            "It is not the same scale as an SVT preset.",
            exit_code=2,
        )
