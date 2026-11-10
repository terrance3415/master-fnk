from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from remaster.errors import RemasterError


class JobState:
    def __init__(self) -> None:
        self.frame: bytes | None = None
        self.width = 0
        self.height = 0
        self.result: bytes | None = None


class LoopbackServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True

    def __init__(self, handler, ort_dist: Path, model_path: Path, worker_dir: Path, max_post: int) -> None:
        super().__init__(("127.0.0.1", 0), handler)
        host = self.server_address[0]
        if host != "127.0.0.1":
            self.server_close()
            raise RemasterError(f"refusing to listen on {host}; only 127.0.0.1 is allowed", exit_code=2)
        self.ort_dist = ort_dist.resolve()
        self.model_path = model_path.resolve()
        self.worker_dir = worker_dir.resolve()
        self.max_post = max_post
        self.state = JobState()


class WorkerHandler(BaseHTTPRequestHandler):
    server: LoopbackServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        return

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0].strip("[]")
        return host in {"127.0.0.1", "localhost"}

    def _send(self, code: int, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra:
            for key, value in extra.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _path(self) -> str | None:
        parts = urlsplit(self.path)
        if parts.query or parts.fragment:
            return None
        path = unquote(parts.path)
        if "\\" in path or ".." in path.split("/"):
            return None
        return path

    def _file_inside(self, root: Path, name: str) -> Path | None:
        if not name or name != Path(name).name or name.startswith("."):
            return None
        candidate = (root / name).resolve()
        if root.resolve() not in candidate.parents or not candidate.is_file():
            return None
        return candidate

    def do_GET(self) -> None:
        if not self._host_ok():
            self._send(403, b"forbidden host", "text/plain")
            return
        path = self._path()
        if path is None:
            self._send(404, b"not found", "text/plain")
            return
        if path == "/":
            page = self.server.worker_dir / "index.html"
            self._send(200, page.read_bytes(), "text/html; charset=utf-8")
            return
        if path == "/infer.js":
            script = self.server.worker_dir / "infer.js"
            self._send(200, script.read_bytes(), "text/javascript; charset=utf-8")
            return
        if path == "/model.onnx":
            self._send(200, self.server.model_path.read_bytes(), "application/octet-stream")
            return
        if path == "/frame.bin":
            frame = self.server.state.frame
            if frame is None:
                self._send(404, b"no frame", "text/plain")
                return
            self._send(
                200,
                frame,
                "application/octet-stream",
                {"X-Width": str(self.server.state.width), "X-Height": str(self.server.state.height)},
            )
            return
        if path.startswith("/ort/"):
            asset = self._file_inside(self.server.ort_dist, path[len("/ort/") :])
            if asset is None:
                self._send(404, b"not found", "text/plain")
                return
            content_type = "application/wasm" if asset.suffix == ".wasm" else "text/javascript; charset=utf-8"
            self._send(200, asset.read_bytes(), content_type)
            return
        self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:
        if not self._host_ok():
            self._send(403, b"forbidden host", "text/plain")
            return
        path = self._path()
        if path != "/result.bin":
            self._send(404, b"not found", "text/plain")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send(400, b"bad length", "text/plain")
            return
        if length < 0 or length > self.server.max_post:
            self._send(413, b"frame too large", "text/plain")
            return
        body = self.rfile.read(length) if length else b""
        if len(body) != length:
            self._send(400, b"short body", "text/plain")
            return
        self.server.state.result = body
        self._send(204, b"", "application/octet-stream")


def serve_worker(ort_dist: Path, model_path: Path, worker_dir: Path, max_post: int) -> tuple[LoopbackServer, threading.Thread]:
    server = LoopbackServer(WorkerHandler, ort_dist, model_path, worker_dir, max_post)
    thread = threading.Thread(target=server.serve_forever, name="remaster-loopback", daemon=True)
    thread.start()
    return server, thread
