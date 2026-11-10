from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

from remaster.audio import extract_audio
from remaster.browser_worker import BrowserUpscaler
from remaster.decode import FrameDecoder
from remaster.encode import encode_frames
from remaster.errors import RemasterError
from remaster.paths import repo_root
from remaster.pipeline import FrameProcessor, pipeline_order
from remaster.preflight import (
    assert_encoder_available,
    assert_ffmpeg_binary,
    assert_svt_lp,
    chrome_version,
    encoder_list,
    find_chrome,
    ort_dist_dir,
    resolve_model,
    resolve_tool,
)
from remaster.probe import (
    audio_stream,
    color_encode_args,
    count_output_frames,
    frame_durations,
    output_container,
    parse_rate,
    probe_file,
    validate_start_times,
    validate_timing,
    validate_video_stream,
    video_stream,
)
from remaster.tiles import assert_tile_budget


def _public_requests(urls: list[str]) -> list[str]:
    return [url for url in urls if not url.startswith("pageerror:")]


def _environment(args) -> dict:
    ffmpeg = resolve_tool(args.ffmpeg, "REMASTER_FFMPEG", "ffmpeg")
    ffprobe = resolve_tool(args.ffprobe, "REMASTER_FFPROBE", "ffprobe")
    ffmpeg_version = assert_ffmpeg_binary(ffmpeg)
    assert_encoder_available(ffmpeg, "libsvtav1")
    if args.encoder != "libsvtav1":
        assert_encoder_available(ffmpeg, args.encoder)
    svt_cores = assert_svt_lp(ffmpeg, args.threads)
    listing = encoder_list(ffmpeg)
    model_path, model_info = resolve_model(args.model)
    dist = ort_dist_dir(args.ort_dist)
    chrome = find_chrome(args.chrome)
    return {
        "ffmpeg": ffmpeg,
        "ffprobe": ffprobe,
        "ffmpeg_version": ffmpeg_version,
        "svt_preflight_cores": svt_cores,
        "libaom_available": "libaom-av1" in listing,
        "model_path": model_path,
        "model_info": model_info,
        "ort_dist": dist,
        "chrome": chrome,
        "chrome_version": chrome_version(chrome),
    }


def check_deps(args) -> dict:
    env = _environment(args)
    return {
        "ffmpeg": env["ffmpeg"],
        "ffmpeg_version": env["ffmpeg_version"],
        "ffprobe": env["ffprobe"],
        "encoder": args.encoder,
        "svt_preflight_cores": env["svt_preflight_cores"],
        "libaom_available": env["libaom_available"],
        "model": env["model_info"],
        "ort_dist": str(env["ort_dist"]),
        "chrome": env["chrome"],
        "chrome_version": env["chrome_version"],
        "content_filter": "none",
        "runtime_downloads": False,
    }


def _listen_host(upscaler: BrowserUpscaler) -> str:
    return str(upscaler.server.server_address[0]) if upscaler.server is not None else ""


def _worker_summary(upscaler: BrowserUpscaler, backend: str) -> dict:
    return {
        "backend_requested": backend,
        "backend_used": backend,
        "webgpu_executed": backend == "webgpu",
        "execution_providers": upscaler._init_info.get("executionProviders"),
        "wasm_paths": upscaler._init_info.get("wasmPaths"),
        "webgpu_adapter": upscaler._init_info.get("adapter"),
        "listen_host": _listen_host(upscaler),
        "listen_port": upscaler.port,
        "chrome_sandbox_args": upscaler.sandbox_args,
        "requests": _public_requests(upscaler.requests),
        "blocked_remote_requests": list(upscaler.blocked),
        "offline_probe_blocked": upscaler.probe_blocked,
        "content_filter": "none",
    }


def run_model_check(args) -> dict:
    env = _environment(args)
    model_scale = int(env["model_info"]["upscale"])
    worker_dir = repo_root() / "worker"
    upscaler = BrowserUpscaler(
        chrome=env["chrome"],
        ort_dist=env["ort_dist"],
        model_path=env["model_path"],
        worker_dir=worker_dir,
        backend=args.backend,
        tile=max(args.tile, 64),
        overlap=min(args.overlap, 16),
        model_scale=model_scale,
        target_scale=model_scale,
        frame_timeout_s=args.frame_timeout,
        offline_probe=args.offline_probe,
    )
    try:
        report = {
            **_worker_summary(upscaler, args.backend),
            "model": env["model_info"],
            "ffmpeg_version": env["ffmpeg_version"],
            "chrome_version": env["chrome_version"],
            "trained_basicvsr": False,
        }
        if not env["model_info"]["official_hash_match"]:
            report["golden"] = "skipped (custom model hash)"
            return report
        golden_path = repo_root() / "models" / "golden.npz"
        if not golden_path.is_file():
            raise RemasterError(f"missing {golden_path}. Re-run python scripts/bootstrap_model.py", exit_code=2)
        golden = np.load(golden_path)
        image = golden["image"]
        reference = golden["output"]
        bicubic = golden["bicubic"]
        upscaler.set_geometry(256, 16, model_scale)
        untiled = upscaler.infer(image)
        max_abs = int(np.max(np.abs(untiled.astype(np.int16) - reference.astype(np.int16))))
        mean_abs = float(np.mean(np.abs(untiled.astype(np.int16) - reference.astype(np.int16))))
        bicubic_mean = float(np.mean(np.abs(reference.astype(np.int16) - bicubic.astype(np.int16))))
        if max_abs > 3:
            raise RemasterError(
                f"WASM/WebGPU output disagrees with the PyTorch export (max abs {max_abs}). "
                "Refusing a mismatched or stub model."
            )
        if bicubic_mean < 3 or float(np.mean(np.abs(untiled.astype(np.int16) - bicubic.astype(np.int16)))) < 3:
            raise RemasterError("model output matches bicubic too closely. Refusing a resize stub.")
        upscaler.set_geometry(20, 8, model_scale)
        tiled = upscaler.infer(image)
        tile_mean = float(np.mean(np.abs(tiled.astype(np.int16) - untiled.astype(np.int16))))
        if tiled.shape != untiled.shape:
            raise RemasterError(f"tiled output shape {tiled.shape} != {untiled.shape}")
        if np.any(tiled.mean(axis=(1, 2)) < 1.0) and float(untiled.mean()) > 10.0:
            raise RemasterError("tiled output has a near-black row; tile coverage is wrong")
        if tile_mean > 30.0:
            raise RemasterError(f"tiled and full-frame outputs differ by mean abs {tile_mean:.2f}")
        report["golden_max_abs"] = max_abs
        report["golden_mean_abs"] = round(mean_abs, 4)
        report["bicubic_mean_abs"] = round(bicubic_mean, 4)
        report["tile_mean_abs_vs_full"] = round(tile_mean, 4)
        report["blocked_remote_requests"] = list(upscaler.blocked)
        report["requests"] = _public_requests(upscaler.requests)
        if upscaler.blocked:
            raise RemasterError("non-loopback requests were blocked during the model check: " + ", ".join(upscaler.blocked))
        return report
    finally:
        upscaler.close()


def _reserve_output(path: Path) -> None:
    if path.exists():
        raise RemasterError(f"output already exists, refusing to overwrite: {path}", exit_code=2)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError as exc:
        raise RemasterError(f"output already exists, refusing to overwrite: {path}", exit_code=2) from exc
    else:
        os.close(fd)


def _duration_of(stream: dict, fmt: dict) -> float | None:
    for source in (stream, fmt):
        raw = source.get("duration")
        if raw not in (None, "N/A", ""):
            try:
                return float(raw)
            except (TypeError, ValueError):
                continue
    return None


def _assert_av1_output(
    ffprobe: str,
    output: Path,
    *,
    width: int,
    height: int,
    frame_count: int,
    fps_num: int,
    fps_den: int,
    duration_sec: float,
    expect_audio: bool,
) -> dict:
    info = count_output_frames(ffprobe, output)
    video = video_stream(info)
    if video.get("codec_name") != "av1":
        raise RemasterError(f"output codec is {video.get('codec_name')}, expected av1. The file was discarded.")
    if int(video["width"]) != width or int(video["height"]) != height:
        raise RemasterError(
            f"output size {video.get('width')}x{video.get('height')} != {width}x{height}. The file was discarded."
        )
    if video.get("pix_fmt") != "yuv420p":
        raise RemasterError(f"output pixel format {video.get('pix_fmt')} is not yuv420p. The file was discarded.")
    got_frames = int(video.get("nb_read_frames") or 0)
    if got_frames != frame_count:
        raise RemasterError(
            f"output has {got_frames} frames, expected {frame_count}. Timing would not match the source. "
            "The file was discarded."
        )
    got_rate = parse_rate(video.get("r_frame_rate")) or parse_rate(video.get("avg_frame_rate"))
    if got_rate is None or abs((got_rate[0] / got_rate[1]) - (fps_num / fps_den)) > 0.01:
        raise RemasterError(f"output frame rate {video.get('r_frame_rate')} does not match {fps_num}/{fps_den}")
    fmt = info.get("format") or {}
    video_duration = _duration_of(video, fmt)
    tol = max(1.5 * fps_den / float(fps_num), 0.05)
    if video_duration is None or abs(video_duration - duration_sec) > tol:
        raise RemasterError(
            f"output duration {video_duration} is not within {tol:.3f}s of {duration_sec:.3f}s. The file was discarded."
        )
    audio = audio_stream(info)
    if expect_audio:
        if audio is None:
            raise RemasterError("output is missing the source audio. The file was discarded.")
        audio_duration = _duration_of(audio, fmt)
        if audio_duration is None or abs(audio_duration - video_duration) > tol:
            raise RemasterError(
                f"audio duration {audio_duration} and video duration {video_duration} differ by more than {tol:.3f}s. "
                "The file was discarded."
            )
    elif audio is not None:
        raise RemasterError("output has an audio stream the source did not have")
    return {
        "codec_name": video.get("codec_name"),
        "width": int(video["width"]),
        "height": int(video["height"]),
        "frames": got_frames,
        "r_frame_rate": video.get("r_frame_rate"),
        "pix_fmt": video.get("pix_fmt"),
        "video_duration": video_duration,
        "audio_codec": None if audio is None else audio.get("codec_name"),
        "audio_duration": None if audio is None else _duration_of(audio, fmt),
    }


def remaster_file(args) -> dict:
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    if not input_path.is_file():
        raise RemasterError(f"input is not a readable file: {input_path}", exit_code=2)
    if input_path == output_path:
        raise RemasterError("input and output are the same path. The source is left untouched.", exit_code=2)
    suffix = output_container(output_path)
    created = False
    failed = True
    upscaler = None
    try:
        _reserve_output(output_path)
        created = True
        env = _environment(args)
        info = probe_file(env["ffprobe"], input_path)
        video = video_stream(info)
        width, height = validate_video_stream(video)
        if width * height > args.max_input_pixels:
            raise RemasterError(
                f"input is {width}x{height} ({width * height} pixels), over --max-input-pixels "
                f"{args.max_input_pixels}. Raise the limit only if you have the RAM. "
                "1080p is about 2.1 million pixels.",
                exit_code=2,
            )
        durations = frame_durations(env["ffprobe"], input_path)
        fps_num, fps_den = validate_timing(video, durations)
        if args.limit_frames < 0:
            raise RemasterError("--limit-frames must be >= 0 (0 means the whole file)", exit_code=2)
        frame_count = len(durations) if args.limit_frames == 0 else min(args.limit_frames, len(durations))
        if frame_count < 1:
            raise RemasterError("no frames selected", exit_code=2)
        audio = audio_stream(info)
        validate_start_times(video, audio, fps_num, fps_den)
        scale = args.scale
        model_scale = int(env["model_info"]["upscale"])
        if model_scale % scale != 0:
            raise RemasterError(
                f"--scale {scale} does not divide the x{model_scale} compact model. "
                "The network runs at its native scale and the worker box-downsamples to --scale. Use 2 or 4.",
                exit_code=2,
            )
        out_w = width * scale
        out_h = height * scale
        if args.encoder == "libsvtav1" and (out_w < 64 or out_h < 64):
            raise RemasterError(
                f"output would be {out_w}x{out_h}. SVT-AV1 refuses width or height below 64. "
                "Use a larger source or --scale 4 when the source is small. "
                "A 32x32 source at --scale 2 is exactly 64x64.",
                exit_code=2,
            )
        if out_w * out_h * 3 > 256 * 1024 * 1024:
            raise RemasterError("one output frame would exceed 256 MB. Lower --scale or the input size.", exit_code=2)
        if args.backend == "wasm" and width * height > 256 * 256 and not args.allow_slow_wasm:
            raise RemasterError(
                f"input is {width}x{height}. --backend wasm is the explicit CPU test path and is very slow "
                "above 256x256 because the compact model is a deep stack of convolutions. "
                "Use --backend webgpu on a GPU machine, or pass --allow-slow-wasm. "
                "WebGPU was not attempted.",
                exit_code=2,
            )
        assert_tile_budget(width, height, args.tile, args.overlap)
        duration_sec = frame_count * fps_den / float(fps_num)
        with tempfile.TemporaryDirectory(prefix="remaster_") as temporary:
            work = Path(temporary)
            audio_path = None
            audio_mode = "none"
            if audio is not None:
                audio_path, audio_mode = extract_audio(
                    env["ffmpeg"],
                    input_path,
                    work,
                    duration_sec,
                    suffix,
                    str(audio.get("codec_name") or ""),
                )
            upscaler = BrowserUpscaler(
                chrome=env["chrome"],
                ort_dist=env["ort_dist"],
                model_path=env["model_path"],
                worker_dir=repo_root() / "worker",
                backend=args.backend,
                tile=args.tile,
                overlap=args.overlap,
                model_scale=model_scale,
                target_scale=scale,
                frame_timeout_s=args.frame_timeout,
                offline_probe=args.offline_probe,
            )
            processor = FrameProcessor(
                upscaler.infer,
                denoise=args.denoise,
                sharpen=args.sharpen,
                temporal_strength=args.temporal_strength,
                scene_threshold=args.scene_threshold,
            )

            def produced_frames():
                decoder = FrameDecoder(env["ffmpeg"], input_path, width, height, frame_count)
                count = 0
                try:
                    for raw in decoder:
                        frame = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3).copy()
                        output_frame = processor.push(frame)
                        if output_frame.shape != (out_h, out_w, 3):
                            raise RemasterError(
                                f"upscaler returned {output_frame.shape}, expected {(out_h, out_w, 3)}"
                            )
                        count += 1
                        print(
                            f"frame {count}/{frame_count} {width}x{height} -> {out_w}x{out_h} "
                            f"backend={args.backend}",
                            file=sys.stderr,
                        )
                        yield output_frame
                finally:
                    decoder.close()
                if count != frame_count:
                    raise RemasterError(f"decoded {count} frames, probe expected {frame_count}")

            encode_report = encode_frames(
                ffmpeg=env["ffmpeg"],
                frames=produced_frames(),
                output=output_path,
                width=out_w,
                height=out_h,
                fps_num=fps_num,
                fps_den=fps_den,
                encoder=args.encoder,
                preset=args.preset,
                crf=args.crf,
                threads=args.threads,
                audio_path=audio_path,
                color_args=color_encode_args(video),
                duration_sec=duration_sec,
                overwrite_placeholder=True,
            )
            verified = _assert_av1_output(
                env["ffprobe"],
                output_path,
                width=out_w,
                height=out_h,
                frame_count=frame_count,
                fps_num=fps_num,
                fps_den=fps_den,
                duration_sec=duration_sec,
                expect_audio=audio is not None,
            )
        if upscaler.blocked:
            raise RemasterError("non-loopback requests were blocked during remaster: " + ", ".join(upscaler.blocked))
        failed = False
        return {
            **_worker_summary(upscaler, args.backend),
            "input": str(input_path),
            "output": str(output_path),
            "encoder": args.encoder,
            "crf": args.crf,
            "preset": args.preset,
            "threads": args.threads,
            "svt_thread_option": None if args.encoder != "libsvtav1" else f"lp={args.threads}",
            "svt_logical_cores": encode_report.get("svt_logical_cores"),
            "scale": scale,
            "model_scale": model_scale,
            "scale_method": f"x{model_scale} SRVGGNetCompact then {model_scale // scale}x box downsample to {scale}x"
            if scale != model_scale
            else f"x{model_scale} SRVGGNetCompact",
            "tile": args.tile,
            "overlap": args.overlap,
            "denoise": args.denoise,
            "sharpen": args.sharpen,
            "sharpen_note": "additional unsharp only; 0 leaves the compact model's own enhancement in place",
            "temporal_strength": args.temporal_strength,
            "temporal_method": "basicvsr-style-recurrent-warp",
            "trained_basicvsr": False,
            "scene_threshold": args.scene_threshold,
            "scene_cuts": processor.scene_cuts,
            "frames_in": frame_count,
            "frames_out": verified["frames"],
            "fps": f"{fps_num}/{fps_den}",
            "audio_mode": audio_mode,
            "audio_codec": verified["audio_codec"],
            "video_duration": verified["video_duration"],
            "audio_duration": verified["audio_duration"],
            "pipeline_order": pipeline_order(args.denoise, args.sharpen, args.encoder),
            "model": env["model_info"],
            "ffmpeg_version": env["ffmpeg_version"],
            "chrome_version": env["chrome_version"],
            "content_filter": "none",
            "runtime_downloads": False,
            "hdr": "rejected; 8-bit SDR yuv420p output only",
        }
    finally:
        if upscaler is not None:
            upscaler.close()
        if failed and created and output_path.exists():
            try:
                output_path.unlink()
            except OSError:
                pass


def write_diagnostics(path: str | None, report: dict) -> None:
    if not path:
        return
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
