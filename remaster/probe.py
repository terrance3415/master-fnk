from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from remaster.errors import RemasterError

_HIGH_BIT = re.compile(r"(10|12|14|16)le|p10|p12|f16|f32|float")
_SDR_MATRIX = {"bt709", "bt470bg", "smpte170m"}
_SDR_TRANSFER = {"bt709", "bt470bg", "smpte170m", "iec61966-2-1"}
_HDR_TRANSFER = {"smpte2084", "arib-std-b67"}


def run_json(ffprobe: str, args: list[str]) -> dict:
    command = [ffprobe, "-v", "error", "-print_format", "json", *args]
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RemasterError(f"ffprobe failed: {detail or 'no output'}", exit_code=2)
    try:
        return json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RemasterError(f"ffprobe returned invalid JSON: {exc}", exit_code=2) from exc


def probe_file(ffprobe: str, path: Path) -> dict:
    if not path.is_file():
        raise RemasterError(f"input is not a readable file: {path}", exit_code=2)
    return run_json(ffprobe, ["-show_format", "-show_streams", str(path)])


def video_stream(info: dict) -> dict:
    streams = [stream for stream in info.get("streams", []) if stream.get("codec_type") == "video"]
    if not streams:
        raise RemasterError("no video stream in input", exit_code=2)
    return streams[0]


def audio_stream(info: dict) -> dict | None:
    streams = [stream for stream in info.get("streams", []) if stream.get("codec_type") == "audio"]
    return streams[0] if streams else None


def parse_rate(text: str | None) -> tuple[int, int] | None:
    if not text or text in {"0/0", "N/A"}:
        return None
    if "/" not in text:
        return None
    num_text, den_text = text.split("/", 1)
    try:
        num = int(num_text)
        den = int(den_text)
    except ValueError:
        return None
    if num <= 0 or den <= 0:
        return None
    return num, den


def frame_durations(ffprobe: str, path: Path) -> list[int]:
    command = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "frame=pkt_duration",
        "-of",
        "csv=p=0",
        str(path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0:
        detail = (completed.stderr or "").strip()
        raise RemasterError(
            "could not read frame timestamps, so constant frame rate cannot be verified. "
            f"Refusing to guess timing. ffprobe said: {detail or 'no output'}",
            exit_code=2,
        )
    durations: list[int] = []
    for line in completed.stdout.splitlines():
        line = line.strip()
        if not line or line == "N/A":
            continue
        try:
            durations.append(int(line.split(",")[0]))
        except ValueError as exc:
            raise RemasterError(f"unexpected frame duration {line!r}", exit_code=2) from exc
    if not durations:
        raise RemasterError("input has no video frames", exit_code=2)
    return durations


def durations_are_vfr(durations: list[int]) -> bool:
    core = [value for value in durations[:-1] if value > 0] if len(durations) > 1 else durations
    if len(core) < 2:
        return False
    low = min(core)
    high = max(core)
    if high == low or high - low <= 1:
        return False
    return (high - low) / float(high) > 0.015


def validate_timing(stream: dict, durations: list[int]) -> tuple[int, int]:
    rate = parse_rate(stream.get("r_frame_rate"))
    if rate is None:
        raise RemasterError(
            f"unsupported or missing frame rate {stream.get('r_frame_rate')!r}. "
            "A constant rational frame rate is required.",
            exit_code=2,
        )
    average = parse_rate(stream.get("avg_frame_rate"))
    num, den = rate
    fps = num / den
    if fps < 1 or fps > 240:
        raise RemasterError(f"frame rate {num}/{den} is outside the supported 1..240 fps range", exit_code=2)
    if average is not None:
        avg_fps = average[0] / average[1]
        if abs(avg_fps - fps) / fps > 0.01:
            raise RemasterError(
                f"variable frame rate is not supported (r_frame_rate {num}/{den}, "
                f"avg_frame_rate {average[0]}/{average[1]}). "
                "Convert to constant frame rate before remastering. "
                "This tool will not drop or duplicate frames to hide the mismatch, because that drifts audio.",
                exit_code=2,
            )
    if durations_are_vfr(durations):
        raise RemasterError(
            "variable frame rate is not supported. Frame durations are not constant. "
            "Convert to a constant frame rate first. Silent frame duplication or dropping is not done.",
            exit_code=2,
        )
    return num, den


def validate_video_stream(stream: dict) -> tuple[int, int]:
    try:
        width = int(stream["width"])
        height = int(stream["height"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RemasterError("video stream is missing width or height", exit_code=2) from exc
    if width < 8 or height < 8:
        raise RemasterError(
            f"frame size {width}x{height} is below the 8x8 minimum required for optical flow",
            exit_code=2,
        )
    pix_fmt = str(stream.get("pix_fmt") or "")
    if _HIGH_BIT.search(pix_fmt):
        raise RemasterError(
            f"pixel format {pix_fmt} is not supported. This tool processes 8-bit SDR and converts it to yuv420p. "
            "10-bit and HDR sources are rejected. There is no PQ/HLG tonemap and no HDR metadata pass-through. "
            "A silent down-conversion would change the picture without saying so.",
            exit_code=2,
        )
    transfer = str(stream.get("color_transfer") or "")
    if transfer in _HDR_TRANSFER:
        raise RemasterError(
            f"color transfer {transfer} is HDR. HDR is not processed. "
            "There is no tone-mapping pass and the AV1 output is 8-bit yuv420p SDR.",
            exit_code=2,
        )
    return width, height


def color_encode_args(stream: dict) -> list[str]:
    matrix = stream.get("color_space") or "bt709"
    primaries = stream.get("color_primaries") or "bt709"
    transfer = stream.get("color_transfer") or "bt709"
    if matrix not in _SDR_MATRIX:
        matrix = "bt709"
    if primaries not in _SDR_MATRIX:
        primaries = "bt709"
    if transfer not in _SDR_TRANSFER:
        transfer = "bt709"
    return [
        "-colorspace",
        matrix,
        "-color_primaries",
        primaries,
        "-color_trc",
        transfer,
    ]


def validate_start_times(video: dict, audio: dict | None, fps_num: int, fps_den: int) -> None:
    period = fps_den / float(fps_num)
    limit = 1.5 * period

    def _start(stream: dict) -> float:
        try:
            return float(stream.get("start_time") or 0.0)
        except (TypeError, ValueError) as exc:
            raise RemasterError("unreadable stream start_time", exit_code=2) from exc

    video_start = _start(video)
    if abs(video_start) > limit:
        raise RemasterError(
            f"video start_time {video_start:.4f}s is more than one frame ({period:.4f}s). "
            "Frames are re-timed from zero at the source frame rate. "
            "A large start offset would move the picture relative to audio, so the file is rejected.",
            exit_code=2,
        )
    if audio is None:
        return
    audio_start = _start(audio)
    if abs(audio_start) > limit:
        raise RemasterError(
            f"audio start_time {audio_start:.4f}s is more than one frame. "
            "Trim the source so audio and video start together. "
            "The mux will not shift audio on its own.",
            exit_code=2,
        )


def output_container(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix not in {".mkv", ".mp4", ".webm"}:
        raise RemasterError(
            f"output extension {suffix or '(none)'} is not supported. Use .mkv, .mp4, or .webm. "
            "The video codec is AV1 either way.",
            exit_code=2,
        )
    return suffix


def count_output_frames(ffprobe: str, path: Path) -> dict:
    info = run_json(
        ffprobe,
        [
            "-count_frames",
            "-show_streams",
            "-show_format",
            str(path),
        ],
    )
    return info
