import json
import shutil
from pathlib import Path
from urllib.parse import urlsplit

from tests.helpers import ROOT, ffprobe, run_cli, scene_frames, write_raw_video


def _assert_local_requests(report: dict) -> None:
    assert report["listen_host"] == "127.0.0.1"
    assert report["offline_probe_blocked"] is True
    assert report["blocked_remote_requests"] == []
    assert report["content_filter"] == "none"
    assert report["webgpu_executed"] is False
    assert report["backend_used"] == "wasm"
    assert report["execution_providers"] == ["wasm"]
    wasm_paths = report["wasm_paths"]
    assert wasm_paths.startswith("http://127.0.0.1:")
    assert wasm_paths.endswith("/ort/")
    saw_wasm = False
    saw_model = False
    saw_ort_js = False
    saw_probe = False
    for url in report["requests"]:
        if url.startswith("pageerror:"):
            continue
        parts = urlsplit(url)
        if parts.hostname == "example.com":
            assert "remaster-offline-probe" in url
            saw_probe = True
            continue
        assert parts.scheme in {"http", "data", "blob", "about"}
        if parts.scheme == "http":
            assert parts.hostname in {"127.0.0.1", "localhost"}
        assert "jsdelivr" not in url
        assert "unpkg" not in url
        if ".wasm" in url:
            saw_wasm = True
        if url.endswith("/model.onnx") or "model.onnx" in url:
            saw_model = True
        if "ort.all.min.js" in url:
            saw_ort_js = True
    assert saw_probe
    assert saw_wasm
    assert saw_model
    assert saw_ort_js


def test_model_check_and_full_av1_remaster(tmp_path: Path):
    check = run_cli(["--check", "--backend", "wasm", "--offline-probe", "--threads", "2"], timeout=180)
    assert check.returncode == 0, check.stderr
    check_report = json.loads(check.stdout)
    _assert_local_requests(check_report)
    assert check_report["golden_max_abs"] <= 3
    assert check_report["bicubic_mean_abs"] > 3
    assert check_report["trained_basicvsr"] is False

    folder = tmp_path / "clip dir"
    folder.mkdir()
    source = folder / "input clip.mp4"
    frames = scene_frames()
    write_raw_video(source, frames, fps=10, audio=True)
    before = source.read_bytes()
    output = folder / "remaster out.mkv"
    diagnostics = folder / "diagnostics.json"
    completed = run_cli(
        [
            "--input",
            str(source),
            "--output",
            str(output),
            "--backend",
            "wasm",
            "--scale",
            "2",
            "--denoise",
            "low",
            "--sharpen",
            "low",
            "--temporal-strength",
            "0.35",
            "--scene-threshold",
            "0.30",
            "--crf",
            "32",
            "--preset",
            "8",
            "--threads",
            "2",
            "--encoder",
            "libsvtav1",
            "--offline-probe",
            "--diagnostics",
            str(diagnostics),
        ],
        timeout=240,
    )
    assert completed.returncode == 0, completed.stderr
    assert source.read_bytes() == before
    report = json.loads(diagnostics.read_text(encoding="utf-8"))
    _assert_local_requests(report)
    assert report["encoder"] == "libsvtav1"
    assert report["svt_thread_option"] == "lp=2"
    assert report["svt_logical_cores"] == 2
    assert report["frames_in"] == 4
    assert report["frames_out"] == 4
    assert report["scene_cuts"] == [3]
    assert report["pipeline_order"][1] == "denoise"
    assert report["pipeline_order"].index("denoise") < report["pipeline_order"].index("realesrgan-compact-ort-web")
    assert report["pipeline_order"].index("unsharp-additional") < report["pipeline_order"].index("basicvsr-style-temporal")
    assert report["trained_basicvsr"] is False
    assert report["audio_mode"] == "copy"
    probed = ffprobe(output)
    video = next(stream for stream in probed["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in probed["streams"] if stream["codec_type"] == "audio")
    assert video["codec_name"] == "av1"
    assert int(video["width"]) == 64
    assert int(video["height"]) == 64
    assert int(video["nb_read_frames"]) == 4
    assert video["pix_fmt"] == "yuv420p"
    video_duration = float(video.get("duration") or probed["format"]["duration"])
    audio_duration = float(audio.get("duration") or video_duration)
    assert abs(video_duration - 0.4) <= 0.05
    assert abs(video_duration - audio_duration) <= 0.05
    again = run_cli(
        ["--input", str(source), "--output", str(output), "--backend", "wasm", "--threads", "2"],
        timeout=60,
    )
    assert again.returncode != 0
    assert "already exists" in again.stderr
    one = folder / "one frame.mkv"
    one_run = run_cli(
        [
            "--input",
            str(source),
            "--output",
            str(one),
            "--backend",
            "wasm",
            "--limit-frames",
            "1",
            "--denoise",
            "off",
            "--sharpen",
            "off",
            "--threads",
            "2",
            "--crf",
            "36",
        ],
        timeout=180,
    )
    assert one_run.returncode == 0, one_run.stderr
    one_probe = ffprobe(one)
    one_video = next(stream for stream in one_probe["streams"] if stream["codec_type"] == "video")
    assert one_video["codec_name"] == "av1"
    assert int(one_video["nb_read_frames"]) == 1
    assert int(one_video["width"]) == 64

    artifact_dir = Path("/opt/cursor/artifacts")
    artifact_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(output, artifact_dir / "smoke-sample.mkv")
    (artifact_dir / "smoke-ffprobe.json").write_text(json.dumps(probed, indent=2) + "\n", encoding="utf-8")
    shutil.copyfile(diagnostics, artifact_dir / "smoke-diagnostics.json")
    shutil.copyfile(diagnostics, artifact_dir / "smoke-diagnostics.json")
