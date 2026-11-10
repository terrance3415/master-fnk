"""Drive the phone UI in Chrome and record real export sizes and times."""
import json
import shutil
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist-web"
ART = Path("/opt/cursor/artifacts")
CHROME = "/usr/bin/google-chrome"


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args], check=True)


def ffprobe(path: Path) -> dict:
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def make_fixtures(folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x360:rate=24:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-shortest",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        str(folder / "clip.mp4"),
    )
    ffmpeg("-f", "lavfi", "-i", "color=c=0x2266cc:s=800x600", "-frames:v", "1", str(folder / "photo.png"))
    ffmpeg("-f", "lavfi", "-i", "sine=frequency=220:duration=4", "-c:a", "pcm_s16le", str(folder / "music.wav"))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def log_message(self, fmt, *args):
        return


def main() -> int:
    ART.mkdir(parents=True, exist_ok=True)
    make_fixtures(DIST / "fixtures")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    import threading

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}/?e2e=1"
    report = {"url": url}
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME,
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.on("pageerror", lambda err: print("PAGEERROR", err, flush=True))
        page.on("console", lambda msg: print("CONSOLE", msg.type, msg.text, flush=True) if msg.type == "error" else None)
        page.goto(url, wait_until="domcontentloaded")
        page.get_by_role("heading", name="Master FNK").wait_for()
        page.screenshot(path=str(ART / "phone-lock.png"))
        manifest = page.evaluate(
            """async () => {
              const data = await (await fetch('./manifest.webmanifest')).json();
              const reg = await navigator.serviceWorker.ready;
              return {
                name: data.name,
                display: data.display,
                start: data.start_url,
                icons: data.icons.map(icon => icon.sizes + ' ' + icon.purpose),
                worker: Boolean(reg.active),
                scope: reg.scope,
              };
            }"""
        )
        report["manifest"] = manifest
        page.locator("#password").fill("phone-password")
        page.locator("#password2").fill("phone-password")
        page.get_by_role("button", name="Create the lock").click()
        page.locator(".words li").first.wait_for()
        page.screenshot(path=str(ART / "phone-recovery.png"))
        words = []
        for item in page.locator(".words li").all():
            words.append(item.inner_text().split()[-1])
        assert len(words) == 12, words
        for box in page.locator("[data-quiz]").all():
            box.fill(words[int(box.get_attribute("data-quiz"))])
        page.get_by_role("button", name="Save the lock").click()
        page.get_by_role("button", name="Make a film").wait_for()
        page.get_by_role("button", name="Make a film").click()
        page.locator("#media-input").set_input_files(
            [str(DIST / "fixtures" / "clip.mp4"), str(DIST / "fixtures" / "photo.png")]
        )
        page.get_by_text("clip.mp4").wait_for(timeout=20000)
        page.get_by_text("photo.png").wait_for()
        page.locator("#film-name").fill("Harbor")
        page.locator("#music-input").set_input_files(str(DIST / "fixtures" / "music.wav"))
        page.get_by_text("music.wav").wait_for()
        page.screenshot(path=str(ART / "phone-editor.png"))
        page.get_by_role("button", name="Create video").click()
        page.locator("video.preview").wait_for(timeout=180000)
        page.screenshot(path=str(ART / "phone-done.png"))
        notes = page.locator(".note").all_inner_texts()
        size_line = page.locator("b").first.inner_text()
        with page.expect_download() as download_info:
            page.get_by_role("button", name="Download").click()
        film = ART / "phone-720.mp4"
        download_info.value.save_as(str(film))
        probed = ffprobe(film)
        report["ui720"] = {
            "on_screen": size_line,
            "notes": notes,
            "probe": probed,
        }
        page.get_by_role("button", name="Films").click()
        page.get_by_role("button", name="Lock").click()
        page.locator("#password").fill("not-the-password")
        page.get_by_role("button", name="Unlock").click()
        page.get_by_text("does not match").wait_for()
        page.screenshot(path=str(ART / "phone-lockout.png"))
        report["lockout"] = page.locator("[data-wait]").inner_text()

        benches = page.evaluate(
            """async () => {
              const videoBlob = await (await fetch('./fixtures/clip.mp4')).blob();
              const imageBlob = await (await fetch('./fixtures/photo.png')).blob();
              const musicBlob = await (await fetch('./fixtures/music.wav')).blob();
              const { renderFilm, sampleCorner, buildTimeline, applyPreset } = window.__FNK;
              const baseClips = [
                { id: 'v', kind: 'video', name: 'clip.mp4', duration: 1, width: 640, height: 360, blob: videoBlob },
                { id: 'p', kind: 'image', name: 'photo.png', duration: 0, width: 800, height: 600, blob: imageBlob },
              ];
              async function run(resolution, enhance, maxFrames) {
                const preset = applyPreset(enhance ? 'clean' : 'movie');
                const project = {
                  ...preset,
                  enhance,
                  resolution,
                  slowMo: 1,
                  openingTitle: 'Harbor',
                  clips: baseClips,
                  music: { name: 'music.wav', blob: musicBlob },
                };
                const timeline = buildTimeline(project.clips, project);
                const started = performance.now();
                const result = await renderFilm(project, timeline, { maxFrames });
                const bytes = new Uint8Array(await result.blob.arrayBuffer());
                let binary = '';
                const chunk = 0x8000;
                for (let i = 0; i < bytes.length; i += chunk) {
                  binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
                }
                return {
                  width: result.width,
                  height: result.height,
                  frames: result.frames,
                  ms: Math.round(performance.now() - started),
                  backend: result.backend,
                  audio: result.audio,
                  enhancedFrames: result.enhancedFrames,
                  enhanceMs: result.enhanceMs,
                  notes: result.notes,
                  workWidth: result.workWidth,
                  workHeight: result.workHeight,
                  b64: btoa(binary),
                };
              }
              async function safe(fn) {
                try { return { ok: true, ...(await fn()) }; }
                catch (err) { return { ok: false, error: String(err && err.stack || err) }; }
              }
              const letterbox = await safe(() => sampleCorner({
                ...applyPreset('movie'),
                resolution: '720',
                openingTitle: '',
                clips: [{ id: 'p', kind: 'image', duration: 0, width: 800, height: 600, blob: imageBlob }],
              }, buildTimeline([{ id: 'p', kind: 'image', duration: 0, width: 800, height: 600 }], { resolution: '720', enhance: false, slowMo: 1 })));
              return {
                letterbox,
                p1080: await safe(() => run('1080', false, 8)),
                p4k: await safe(() => run('2160', false, 6)),
                enhance: await safe(() => run('720', true, 4)),
              };
            }"""
        )
        browser.close()
    import base64

    for key in ("p1080", "p4k", "enhance"):
        item = benches[key]
        if not item.get("ok"):
            print("FAIL", key, item.get("error"), flush=True)
            continue
        target = ART / f"phone-{key}.mp4"
        target.write_bytes(base64.b64decode(item.pop("b64")))
        item["probe"] = ffprobe(target)
    report["benches"] = benches
    (ART / "phone-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "benches"}, indent=2)[:2000])
    print("BENCHES")
    for key, item in benches.items():
        if key == "letterbox" or not item.get("ok", True):
            print(key, item, flush=True)
            continue
        if "probe" not in item:
            print(key, "no probe", item.keys(), flush=True)
            continue
        video = next(stream for stream in item["probe"]["streams"] if stream["codec_type"] == "video")
        print(
            key,
            video.get("codec_name"),
            video.get("width"),
            video.get("height"),
            "ms",
            item["ms"],
            "frames",
            item["frames"],
            "backend",
            item["backend"],
            "audio",
            item["audio"],
            "enhanceMs",
            item.get("enhanceMs"),
            flush=True,
        )
    server.shutdown()
    return 0


if __name__ == "__main__":
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg missing")
    raise SystemExit(main())
