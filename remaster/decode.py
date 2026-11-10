from __future__ import annotations

import subprocess
import threading
from pathlib import Path

from remaster.errors import RemasterError


class FrameDecoder:
    """Stream rgb24 frames from ffmpeg. One frame is read at a time."""

    def __init__(self, ffmpeg: str, path: Path, width: int, height: int, limit_frames: int) -> None:
        self.width = width
        self.height = height
        self.frame_bytes = width * height * 3
        command = [
            ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-pix_fmt",
            "rgb24",
        ]
        if limit_frames > 0:
            command += ["-frames:v", str(limit_frames)]
        command += ["-f", "rawvideo", "pipe:1"]
        self.proc = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._stderr = bytearray()
        self._thread = threading.Thread(target=self._drain, daemon=True)
        self._thread.start()

    def _drain(self) -> None:
        assert self.proc.stderr is not None
        self._stderr.extend(self.proc.stderr.read())

    def __iter__(self):
        assert self.proc.stdout is not None
        while True:
            chunk = self.proc.stdout.read(self.frame_bytes)
            if not chunk:
                break
            if len(chunk) != self.frame_bytes:
                self.close()
                raise RemasterError(
                    f"decoder ended mid-frame ({len(chunk)} of {self.frame_bytes} bytes). {self.stderr_text()}"
                )
            yield chunk
        code = self.proc.wait(timeout=60)
        self._thread.join(timeout=5)
        if code != 0:
            raise RemasterError(f"ffmpeg decode failed (exit {code}). {self.stderr_text()}")

    def stderr_text(self) -> str:
        return self._stderr.decode("utf-8", errors="replace")[-2000:]

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        if self._thread.is_alive():
            self._thread.join(timeout=5)
