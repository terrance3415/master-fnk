import hashlib
import json
import socket
from pathlib import Path

import numpy as np

from remaster.encode import encode_frames
from remaster.paths import repo_root
from remaster.preflight import INSTALL_HELP
from remaster.server import serve_worker
from tests.helpers import ffprobe, run_cli, write_raw_video

ROOT = repo_root()


def test_shipped_model_matches_manifest():
    manifest = json.loads((ROOT / "models" / "manifest.json").read_text(encoding="utf-8"))
    model = ROOT / "models" / manifest["onnx_file"]
    digest = hashlib.sha256(model.read_bytes()).hexdigest()
    assert digest == manifest["onnx_sha256"]
    assert manifest["architecture"] == "SRVGGNetCompact"
    assert manifest["num_conv"] == 32
    assert manifest["upscale"] == 4
    assert "Conv" in manifest["ops"]
    assert "PRelu" not in manifest["ops"]
    assert manifest["golden_mean_abs_diff_vs_bicubic"] > 3
    assert manifest["source_sha256"] == "8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292"


def test_missing_ffmpeg_explains_libsvtav1():
    completed = run_cli(["--check-deps", "--ffmpeg", "/bin/true"], timeout=30)
    assert completed.returncode != 0
    text = completed.stderr
    assert "libsvtav1" in text
    assert "enable-libsvtav1" in text or "BtbN" in text
    assert INSTALL_HELP.splitlines()[0][:20] in text or "pip does not install FFmpeg" in text


def test_refuses_overwrite_and_keeps_bytes(tmp_path: Path):
    source = tmp_path / "in.mp4"
    source.write_bytes(b"not-read")
    output = tmp_path / "already.mkv"
    output.write_bytes(b"keep-me")
    completed = run_cli(["--input", str(source), "--output", str(output), "--backend", "wasm"], timeout=30)
    assert completed.returncode != 0
    assert "already exists" in completed.stderr
    assert output.read_bytes() == b"keep-me"


def test_bad_input_does_not_leave_output(tmp_path: Path):
    source = tmp_path / "bad.mp4"
    source.write_bytes(b"this is not a media file")
    output = tmp_path / "out.mkv"
    completed = run_cli(["--input", str(source), "--output", str(output), "--backend", "wasm"], timeout=60)
    assert completed.returncode != 0
    assert not output.exists()


def test_vfr_is_rejected(tmp_path: Path):
    slow = tmp_path / "slow.mp4"
    fast = tmp_path / "fast.mp4"
    listing = tmp_path / "list.txt"
    vfr = tmp_path / "vfr.mp4"
    write_raw_video(slow, [np.full((32, 32, 3), 20, np.uint8) for _ in range(3)], fps=10, audio=False)
    write_raw_video(fast, [np.full((32, 32, 3), 200, np.uint8) for _ in range(3)], fps=30, audio=False)
    listing.write_text(f"file '{slow}'\nfile '{fast}'\n", encoding="utf-8")
    import subprocess

    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(vfr)],
        check=True,
    )
    output = tmp_path / "out.mkv"
    completed = run_cli(["--input", str(vfr), "--output", str(output), "--backend", "wasm"], timeout=60)
    assert completed.returncode != 0
    assert "variable frame rate" in completed.stderr.lower()
    assert not output.exists()


def test_ten_bit_is_rejected(tmp_path: Path):
    source = tmp_path / "ten.mkv"
    import subprocess

    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=32x32:r=10:d=0.2",
            "-c:v",
            "libx265",
            "-pix_fmt",
            "yuv420p10le",
            "-frames:v",
            "2",
            str(source),
        ],
        check=True,
    )
    output = tmp_path / "out.mkv"
    completed = run_cli(["--input", str(source), "--output", str(output), "--backend", "wasm"], timeout=60)
    assert completed.returncode != 0
    assert "8-bit" in completed.stderr or "pixel format" in completed.stderr
    assert not output.exists()


def test_svt_and_aom_encode_real_av1(tmp_path: Path):
    frame = np.zeros((64, 64, 3), np.uint8)
    frame[..., 1] = 140
    frames = [frame, frame.copy()]
    for encoder in ("libsvtav1", "libaom-av1"):
        output = tmp_path / f"space dir/{encoder} out.mkv"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"")
        # encode_frames is given a path the caller already reserved.
        report = encode_frames(
            ffmpeg="ffmpeg",
            frames=frames,
            output=output,
            width=64,
            height=64,
            fps_num=10,
            fps_den=1,
            encoder=encoder,
            preset=8,
            crf=40,
            threads=2,
            audio_path=None,
            color_args=["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"],
            duration_sec=0.2,
            overwrite_placeholder=True,
        )
        probed = ffprobe(output)
        video = next(stream for stream in probed["streams"] if stream["codec_type"] == "video")
        assert video["codec_name"] == "av1"
        assert int(video["width"]) == 64
        assert int(video["height"]) == 64
        assert int(video["nb_read_frames"]) == 2
        if encoder == "libsvtav1":
            assert report["svt_logical_cores"] == 2


def test_loopback_server_rejects_traversal():
    model = ROOT / "models" / "realesr-general-x4v3.onnx"
    dist = ROOT / "node_modules" / "onnxruntime-web" / "dist"
    server, _thread = serve_worker(dist, model, ROOT / "worker", 1024 * 1024)
    try:
        host, port = server.server_address[:2]
        assert host == "127.0.0.1"
        with socket.create_connection((host, port), timeout=5) as sock:
            sock.sendall(b"GET /ort/../../../../etc/passwd HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            payload = sock.recv(65536)
        assert b"root:" not in payload
        assert b"404" in payload or b"not found" in payload
        with socket.create_connection((host, port), timeout=5) as sock:
            sock.sendall(b"GET /ort/ort-wasm-simd-threaded.wasm HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            header = sock.recv(200)
        assert b"200" in header
        assert b"application/wasm" in header
    finally:
        server.shutdown()
        server.server_close()
