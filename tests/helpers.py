from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def run_cli(args: list[str], timeout: float = 240) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "remaster", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def ffprobe(path: Path) -> dict:
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-count_frames",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(completed.stdout)


def write_raw_video(path: Path, frames: list[np.ndarray], fps: int, audio: bool) -> None:
    height, width = frames[0].shape[:2]
    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{width}x{height}",
        "-r",
        str(fps),
        "-i",
        "pipe:0",
    ]
    if audio:
        duration = len(frames) / fps
        command += ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}"]
    command += [
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "0",
        "-preset",
        "ultrafast",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
    ]
    if audio:
        command += ["-c:a", "aac", "-b:a", "128k", "-shortest"]
    command.append(str(path))
    payload = b"".join(np.ascontiguousarray(frame).tobytes() for frame in frames)
    completed = subprocess.run(command, input=payload, capture_output=True, timeout=60, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.decode("utf-8", errors="replace"))


def scene_frames() -> list[np.ndarray]:
    frames = []
    for index in range(3):
        image = np.zeros((32, 32, 3), np.uint8)
        image[..., 0] = 180
        x = 4 + index * 6
        image[10:18, x : x + 8] = 255
        frames.append(image)
    blue = np.zeros((32, 32, 3), np.uint8)
    blue[..., 2] = 210
    frames.append(blue)
    return frames
