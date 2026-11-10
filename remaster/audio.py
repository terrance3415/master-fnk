from __future__ import annotations

import subprocess
from pathlib import Path

from remaster.errors import RemasterError

_MP4_COPY = {"aac", "mp3", "ac3", "alac", "mp2"}
_WEBM_COPY = {"opus", "vorbis"}


def extract_audio(
    ffmpeg: str,
    source: Path,
    work_dir: Path,
    duration_sec: float,
    container_suffix: str,
    audio_codec: str,
) -> tuple[Path, str]:
    """Copy audio when the output container can hold it. Otherwise transcode.

    The clip is trimmed to the video duration so a limited frame count stays in sync.
    """
    codec = (audio_codec or "").lower()
    if container_suffix == ".mp4":
        copy_ok = codec in _MP4_COPY
        dest = work_dir / ("audio-copy.m4a" if copy_ok else "audio-aac.m4a")
        transcode = ["-c:a", "aac", "-b:a", "192k"]
        mode = "copy" if copy_ok else "transcode-aac"
    elif container_suffix == ".webm":
        copy_ok = codec in _WEBM_COPY
        dest = work_dir / ("audio-copy.mkv" if copy_ok else "audio-opus.mkv")
        transcode = ["-c:a", "libopus", "-b:a", "128k"]
        mode = "copy" if copy_ok else "transcode-opus"
    else:
        copy_ok = True
        dest = work_dir / "audio-copy.mka"
        transcode = ["-c:a", "libopus", "-b:a", "128k"]
        mode = "copy"

    def _run(target: Path, audio_args: list[str]) -> subprocess.CompletedProcess[str]:
        command = [
            ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-t",
            f"{duration_sec:.9f}",
            *audio_args,
            str(target),
        ]
        return subprocess.run(command, capture_output=True, text=True)

    if copy_ok:
        completed = _run(dest, ["-c:a", "copy"])
        if completed.returncode == 0 and dest.is_file() and dest.stat().st_size > 0:
            return dest, "copy"
        mode = "transcode-aac" if container_suffix == ".mp4" else "transcode-opus"
        dest = work_dir / ("audio-aac.m4a" if container_suffix == ".mp4" else "audio-opus.mka")
    completed = _run(dest, transcode)
    if completed.returncode != 0 or not dest.is_file() or dest.stat().st_size == 0:
        detail = (completed.stderr or "")[-1500:]
        raise RemasterError(f"could not extract audio for muxing.\n{detail}")
    return dest, mode
