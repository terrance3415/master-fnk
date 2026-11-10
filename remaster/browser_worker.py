from __future__ import annotations

from urllib.parse import urlsplit

import numpy as np
from playwright.sync_api import sync_playwright

from remaster.errors import RemasterError
from remaster.server import serve_worker

_CHROME_ARGS = [
    "--disable-dev-shm-usage",
    "--disable-gpu-sandbox",
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPU,Vulkan",
    "--disable-background-networking",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    "--no-default-browser-check",
    "--no-first-run",
    "--no-pings",
    "--safebrowsing-disable-auto-update",
]


class BrowserUpscaler:
    """One Chrome page. The ONNX session lives in that page and is released on close."""

    def __init__(
        self,
        *,
        chrome: str,
        ort_dist,
        model_path,
        worker_dir,
        backend: str,
        tile: int,
        overlap: int,
        model_scale: int,
        target_scale: int,
        frame_timeout_s: float,
        offline_probe: bool,
    ) -> None:
        if backend not in {"webgpu", "wasm"}:
            raise RemasterError(f"unsupported backend {backend}", exit_code=2)
        if model_scale % target_scale != 0:
            raise RemasterError(
                f"scale {target_scale} does not divide the x{model_scale} model. Use 2 or 4.",
                exit_code=2,
            )
        self.backend = backend
        self.target_scale = target_scale
        self.requests: list[str] = []
        self.blocked: list[str] = []
        self.probe_blocked = False
        self.sandbox_args: list[str] = []
        max_post = 256 * 1024 * 1024
        self.server, self.thread = serve_worker(ort_dist, model_path, worker_dir, max_post)
        self.port = self.server.server_address[1]
        self._play = None
        self._browser = None
        self._page = None
        self._init_info: dict = {}
        try:
            self._start_browser(chrome, frame_timeout_s)
            self._init_session(tile, overlap, model_scale, target_scale)
            if self.blocked:
                raise RemasterError(
                    "the worker requested a non-loopback URL during startup and it was blocked: "
                    + ", ".join(self.blocked)
                )
            if offline_probe:
                self._run_offline_probe()
        except Exception:
            self.close()
            raise

    def _on_route(self, route) -> None:
        url = route.request.url
        self.requests.append(url)
        parts = urlsplit(url)
        if parts.scheme in {"http", "https"} and parts.hostname not in {"127.0.0.1", "localhost"}:
            self.blocked.append(url)
            route.abort("blockedbyclient")
            return
        route.continue_()

    def _start_browser(self, chrome: str, frame_timeout_s: float) -> None:
        self._play = sync_playwright().start()
        errors: list[str] = []
        browser = None
        for extra in ([], ["--no-sandbox"]):
            try:
                browser = self._play.chromium.launch(
                    executable_path=chrome,
                    headless=True,
                    args=[*_CHROME_ARGS, *extra],
                )
                self.sandbox_args = extra
                break
            except Exception as exc:
                errors.append(str(exc))
        if browser is None:
            raise RemasterError(
                "could not launch Chrome for the local worker.\n" + "\n".join(errors),
                exit_code=2,
            )
        self._browser = browser
        page = browser.new_page()
        page.set_default_timeout(int(frame_timeout_s * 1000))
        page.route("**/*", self._on_route)
        page.on("pageerror", lambda err: self.requests.append(f"pageerror:{err}"))
        self._page = page
        page.goto(f"http://127.0.0.1:{self.port}/", wait_until="load")
        page.wait_for_function("() => window.workerReady === true")

    def _init_session(self, tile: int, overlap: int, model_scale: int, target_scale: int) -> None:
        assert self._page is not None
        info = self._page.evaluate(
            """async (config) => {
                try {
                    const result = await window.initModel(config);
                    return { ok: true, result };
                } catch (err) {
                    return { ok: false, error: String(err && err.stack || err) };
                }
            }""",
            {
                "backend": self.backend,
                "tile": tile,
                "overlap": overlap,
                "modelScale": model_scale,
                "targetScale": target_scale,
            },
        )
        if not info.get("ok"):
            message = info.get("error") or "model init failed"
            code = 2 if self.backend == "webgpu" else 1
            raise RemasterError(message, exit_code=code)
        result = info["result"]
        if result.get("backend") != self.backend:
            raise RemasterError(
                f"worker reported backend {result.get('backend')} after a {self.backend} request. "
                "Refusing a silent backend change."
            )
        if result.get("executionProviders") != [self.backend]:
            raise RemasterError(
                f"worker execution providers {result.get('executionProviders')} do not match {self.backend}"
            )
        wasm_paths = str(result.get("wasmPaths") or "")
        if not wasm_paths.startswith(f"http://127.0.0.1:{self.port}/ort/"):
            raise RemasterError(f"ORT wasm path is not the local worker: {wasm_paths}")
        self._init_info = result

    def _run_offline_probe(self) -> None:
        assert self._page is not None
        before = len(self.blocked)
        self._page.evaluate(
            """async (url) => {
                try {
                    await fetch(url, { mode: "no-cors", cache: "no-store" });
                    return "completed";
                } catch (err) {
                    return "blocked";
                }
            }""",
            "https://example.com/remaster-offline-probe",
        )
        hits = [url for url in self.blocked[before:] if "example.com/remaster-offline-probe" in url]
        if not hits:
            raise RemasterError(
                "offline probe was not intercepted. Refusing to remaster while the page can reach the network."
            )
        self.blocked = [url for url in self.blocked if "example.com/remaster-offline-probe" not in url]
        self.probe_blocked = True

    def infer(self, frame: np.ndarray) -> np.ndarray:
        if self.blocked:
            raise RemasterError("blocked non-loopback requests before inference: " + ", ".join(self.blocked))
        if frame.dtype != np.uint8 or frame.ndim != 3 or frame.shape[2] != 3:
            raise RemasterError(f"upscaler expected HxWx3 uint8, got {frame.dtype} {frame.shape}")
        height, width = frame.shape[:2]
        self.server.state.result = None
        self.server.state.width = width
        self.server.state.height = height
        self.server.state.frame = np.ascontiguousarray(frame).tobytes()
        assert self._page is not None
        try:
            info = self._page.evaluate(
                """async () => {
                    try {
                        const result = await window.processCurrent();
                        return { ok: true, result };
                    } catch (err) {
                        return { ok: false, error: String(err && err.stack || err) };
                    }
                }"""
            )
        except Exception as exc:
            raise RemasterError(f"{self.backend} inference failed: {exc}") from exc
        if not info.get("ok"):
            raise RemasterError(f"{self.backend} inference failed: {info.get('error')}")
        raw = self.server.state.result
        out_h = height * self.target_scale
        out_w = width * self.target_scale
        expected = out_w * out_h * 3
        if raw is None or len(raw) != expected:
            got = 0 if raw is None else len(raw)
            raise RemasterError(f"worker returned {got} bytes, expected {expected} for {out_w}x{out_h}")
        image = np.frombuffer(raw, dtype=np.uint8).reshape(out_h, out_w, 3).copy()
        self.server.state.frame = None
        self.server.state.result = None
        if self.blocked:
            raise RemasterError("blocked non-loopback requests during inference: " + ", ".join(self.blocked))
        return image

    def set_geometry(self, tile: int, overlap: int, target_scale: int) -> None:
        self.target_scale = target_scale
        if self._page is None:
            raise RemasterError("worker page is closed")
        self._page.evaluate(
            "([tile, overlap, scale]) => window.setGeometry(tile, overlap, scale)",
            [tile, overlap, target_scale],
        )

    def close(self) -> None:
        page = self._page
        self._page = None
        if page is not None:
            try:
                page.evaluate("() => window.shutdown && window.shutdown()")
            except Exception:
                pass
        browser = self._browser
        self._browser = None
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        play = self._play
        self._play = None
        if play is not None:
            try:
                play.stop()
            except Exception:
                pass
        server = self.server
        self.server = None
        if server is not None:
            try:
                server.shutdown()
                server.server_close()
            except Exception:
                pass
