from __future__ import annotations

import subprocess
import threading
from collections.abc import Iterable
from pathlib import Path

import numpy as np

from remaster.errors import RemasterError
from remaster.preflight import expected_svt_cores, svt_logical_cores


def build_encode_command(
    *,
    ffmpeg: str,
    output: Path,
    width: int,
    height: int,
    fps_num: int,
    fps_den: int,
    encoder: str,
    preset: int,
    crf: int,
    threads: int,
    audio_path: Path | None,
    color_args: list[str],
    duration_sec: float,
    overwrite_placeholder: bool,
) -> list[str]:
    if encoder not in {"libsvtav1", "libaom-av1"}:
        raise RemasterError(
            f"refusing encoder {encoder}. Use libsvtav1 or libaom-av1. H.264 and HEVC are not used.",
            exit_code=2,
        )
    rate = f"{fps_num}/{fps_den}"
    command = [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
    ]
    if overwrite_placeholder:
        command.append("-y")
    command += [
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{width}x{height}",
        "-r",
        rate,
        "-i",
        "pipe:0",
    ]
    if audio_path is not None:
        command += ["-i", str(audio_path)]
    command += ["-map", "0:v:0"]
    if audio_path is not None:
        command += ["-map", "1:a:0", "-c:a", "copy"]
    if encoder == "libsvtav1":
        command += [
            "-c:v",
            "libsvtav1",
            "-preset",
            str(preset),
            "-crf",
            str(crf),
            "-pix_fmt",
            "yuv420p",
            "-svtav1-params",
            f"lp={threads}",
        ]
    else:
        command += [
            "-c:v",
            "libaom-av1",
            "-cpu-used",
            str(preset),
            "-crf",
            str(crf),
            "-b:v",
            "0",
            "-threads",
            str(threads),
            "-row-mt",
            "1",
            "-pix_fmt",
            "yuv420p",
        ]
    command += color_args
    command += ["-t", f"{duration_sec:.9f}", str(output)]
    return command


def encode_frames(
    *,
    ffmpeg: str,
    frames: Iterable[np.ndarray],
    output: Path,
    width: int,
    height: int,
    fps_num: int,
    fps_den: int,
    encoder: str,
    preset: int,
    crf: int,
    threads: int,
    audio_path: Path | None,
    color_args: list[str],
    duration_sec: float,
    overwrite_placeholder: bool,
) -> dict:
    command = build_encode_command(
        ffmpeg=ffmpeg,
        output=output,
        width=width,
        height=height,
        fps_num=fps_num,
        fps_den=fps_den,
        encoder=encoder,
        preset=preset,
        crf=crf,
        threads=threads,
        audio_path=audio_path,
        color_args=color_args,
        duration_sec=duration_sec,
        overwrite_placeholder=overwrite_placeholder,
    )
    proc = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    stderr = bytearray()

    def _drain() -> None:
        assert proc.stderr is not None
        stderr.extend(proc.stderr.read())

    thread = threading.Thread(target=_drain, daemon=True)
    thread.start()
    assert proc.stdin is not None
    written = 0
    try:
        for frame in frames:
            if frame.shape != (height, width, 3):
                raise RemasterError(f"encoder got frame shape {frame.shape}, expected {(height, width, 3)}")
            if frame.dtype != np.uint8:
                raise RemasterError("encoder frames must be uint8")
            try:
                proc.stdin.write(np.ascontiguousarray(frame).tobytes())
            except BrokenPipeError as exc:
                raise RemasterError(f"encoder closed the pipe early. {stderr.decode('utf-8', errors='replace')[-2000:]}") from exc
            written += 1
        proc.stdin.close()
    except Exception:
        if proc.poll() is None:
            proc.kill()
        thread.join(timeout=5)
        raise
    code = proc.wait(timeout=600)
    thread.join(timeout=5)
    log = stderr.decode("utf-8", errors="replace")
    if code != 0:
        raise RemasterError(f"{encoder} encode failed (exit {code}) after {written} frames.\n{log[-2500:]}")
    report = {"frames_written": written, "stderr_tail": log[-1500:], "svt_logical_cores": None}
    if encoder == "libsvtav1":
        reported = svt_logical_cores(log)
        expected = expected_svt_cores(threads)
        if reported != expected:
            raise RemasterError(
                f"encode finished but SVT-AV1 reported {reported} logical cores, expected {expected} "
                f"for lp={threads}. Output is rejected.\n{log[-1500:]}"
            )
        report["svt_logical_cores"] = reported
    return report
