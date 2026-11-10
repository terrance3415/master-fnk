from __future__ import annotations

import argparse
import json
import math
import os
import sys
import traceback

from remaster import __version__
from remaster.amounts import parse_amount
from remaster.errors import RemasterError
from remaster.job import check_deps, remaster_file, run_model_check, write_diagnostics


def _amount(name: str):
    def parse(text: str) -> float:
        try:
            return parse_amount(text, name)
        except RemasterError as exc:
            raise argparse.ArgumentTypeError(str(exc)) from exc

    return parse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="remaster",
        description=(
            "Local video remaster. FFmpeg decodes, a loopback Chrome worker runs the compact "
            "Real-ESRGAN model in ONNX Runtime Web, a BasicVSR-style stabilizer reduces flicker, "
            "and FFmpeg libsvtav1 writes AV1. No content filter and no cloud upload."
        ),
    )
    parser.add_argument("--input", help="source video (left untouched)")
    parser.add_argument("--output", help="new .mkv, .mp4, or .webm path; must not already exist")
    parser.add_argument("--scale", type=int, choices=(2, 4), default=2, help="output scale. The model is x4; 2 box-downsamples")
    parser.add_argument("--model", help="local ONNX file. Default: models/realesr-general-x4v3.onnx")
    parser.add_argument("--tile", type=int, default=192, help="input tile size (default 192)")
    parser.add_argument("--overlap", type=int, default=16, help="tile overlap in input pixels (default 16)")
    parser.add_argument(
        "--denoise",
        type=_amount("--denoise"),
        default=0.25,
        help="before upscale: off/low/medium/high or 0..1. Default low (0.25). 0 and off skip the filters",
    )
    parser.add_argument(
        "--sharpen",
        type=_amount("--sharpen"),
        default=0.0,
        help="additional unsharp after upscale: off/low/medium/high or 0..1. Default off. 0 does not undo the model",
    )
    parser.add_argument("--temporal-strength", type=float, default=0.35, help="0..1 BasicVSR-style blend cap scale. Default 0.35")
    parser.add_argument("--scene-threshold", type=float, default=0.30, help="0..1 mean RGB change that resets temporal state")
    parser.add_argument("--crf", type=int, default=32, help="AV1 CRF 0..63. Default 32. Lower is higher bitrate")
    parser.add_argument("--preset", type=int, default=8, help="SVT preset 0..13 or libaom cpu-used 0..8. Default 8")
    parser.add_argument("--threads", type=int, default=0, help="SVT lp cap, or libaom -threads. 0 means min(8, CPU count)")
    parser.add_argument("--encoder", choices=("libsvtav1", "libaom-av1"), default="libsvtav1")
    parser.add_argument("--backend", choices=("webgpu", "wasm"), default="webgpu", help="ORT Web provider. Default webgpu. wasm is explicit")
    parser.add_argument("--limit-frames", type=int, default=0, help="process only the first N frames. 0 means all")
    parser.add_argument("--diagnostics", help="write a JSON report to this path")
    parser.add_argument("--ffmpeg", help="ffmpeg executable")
    parser.add_argument("--ffprobe", help="ffprobe executable")
    parser.add_argument("--chrome", help="Chrome executable")
    parser.add_argument("--ort-dist", help="directory with local onnxruntime-web dist files")
    parser.add_argument("--frame-timeout", type=float, default=600, help="seconds allowed per browser inference")
    parser.add_argument("--max-input-pixels", type=int, default=4_194_304, help="reject larger frames. Default 2048*2048")
    parser.add_argument("--allow-slow-wasm", action="store_true", help="allow --backend wasm above 256x256")
    parser.add_argument("--offline-probe", action="store_true", help="abort a deliberate non-loopback fetch, then continue")
    parser.add_argument("--check-deps", action="store_true", help="check ffmpeg, model, Chrome, and local ORT files")
    parser.add_argument("--check", action="store_true", help="check deps and run one local model inference")
    parser.add_argument("--version", action="version", version=f"remaster {__version__}")
    return parser


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def _validate_ranges(args: argparse.Namespace) -> None:
    if not math.isfinite(args.temporal_strength) or not 0.0 <= args.temporal_strength <= 1.0:
        raise RemasterError("--temporal-strength must be from 0 to 1", exit_code=2)
    if not math.isfinite(args.scene_threshold) or not 0.0 <= args.scene_threshold <= 1.0:
        raise RemasterError("--scene-threshold must be from 0 to 1", exit_code=2)
    if args.limit_frames < 0:
        raise RemasterError("--limit-frames must be >= 0", exit_code=2)
    if args.tile < 16 or args.tile > 512:
        raise RemasterError("--tile must be 16..512", exit_code=2)
    if args.overlap < 0 or args.overlap >= args.tile:
        raise RemasterError("--overlap must be >= 0 and < --tile", exit_code=2)
    if args.frame_timeout <= 0:
        raise RemasterError("--frame-timeout must be positive", exit_code=2)
    if args.max_input_pixels < 64:
        raise RemasterError("--max-input-pixels is too small", exit_code=2)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        from remaster.preflight import resolve_threads, validate_encode_knobs

        args.threads = resolve_threads(args.threads)
        validate_encode_knobs(args.encoder, args.preset, args.crf)
        _validate_ranges(args)
        if args.check_deps:
            report = check_deps(args)
            write_diagnostics(args.diagnostics, report)
            print(json.dumps(report, indent=2))
            return 0
        if args.check:
            report = run_model_check(args)
            write_diagnostics(args.diagnostics, report)
            print(json.dumps(report, indent=2))
            return 0
        if not args.input or not args.output:
            raise RemasterError("remaster needs --input and --output. Use --check-deps or --check to only verify setup.", exit_code=2)
        report = remaster_file(args)
        write_diagnostics(args.diagnostics, report)
        print(f"wrote {report['output']}")
        print(
            f"backend={report['backend_used']} webgpu_executed={str(report['webgpu_executed']).lower()} "
            f"encoder={report['encoder']} frames={report['frames_out']} scale={report['scale']} "
            f"denoise={report['denoise']} sharpen={report['sharpen']}"
        )
        return 0
    except RemasterError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code
    except Exception as exc:
        if os.environ.get("REMASTER_DEBUG"):
            traceback.print_exc()
        print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
