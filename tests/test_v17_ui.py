import functools
import http.server
import shutil
import subprocess
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def test_v17_vault_and_home():
    subprocess.run(["node", "scripts/build_web.mjs"], cwd=ROOT, check=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "dist-web"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=shutil.which("google-chrome") or shutil.which("chromium"),
                headless=True,
                args=["--no-sandbox"],
            )
            try:
                page = browser.new_page(viewport={"width": 390, "height": 844}, reduced_motion="reduce")
                page.goto(f"http://127.0.0.1:{server.server_port}/")
                page.locator("#password").fill("primary-password")
                page.locator("#password2").fill("primary-password")
                page.locator("#second").fill("decoy-password")
                page.locator("#second2").fill("decoy-password")
                page.get_by_role("button", name="Create the lock").click()
                page.locator(".words li").first.wait_for()
                words = [item.inner_text().split()[-1] for item in page.locator(".words li").all()]
                for box in page.locator("[data-quiz]").all():
                    box.fill(words[int(box.get_attribute("data-quiz"))])
                page.get_by_role("button", name="Save the lock").click()
                page.get_by_role("button", name="Make a film").wait_for()
                for theme in ("Jean", "Rogue", "Storm"):
                    button = page.get_by_role("button", name=theme)
                    button.click()
                    assert button.get_attribute("aria-pressed") == "true"
                    assert page.locator(f".home-{theme.lower()}").count() == 1
                library_iv = """() => new Promise((resolve, reject) => {
                    const open = indexedDB.open("master-fnk");
                    open.onerror = () => reject(open.error);
                    open.onsuccess = () => {
                        const db = open.result;
                        const store = db.transaction("kv").objectStore("kv");
                        const keys = store.getAllKeys();
                        keys.onsuccess = () => {
                            const key = keys.result.find(k => k === "library" || k.startsWith("lib:"));
                            const request = store.get(key);
                            request.onsuccess = () => { resolve(JSON.stringify(request.result.iv)); db.close(); };
                        };
                    };
                })"""
                initial_iv = page.evaluate(library_iv)
                page.get_by_role("button", name="Make a film").click()
                page.locator('.mode-btn.export').click()
                page.wait_for_function(f"async previous => (await ({library_iv})()) !== previous", arg=initial_iv)
                initial_iv = page.evaluate(library_iv)
                page.locator("#film-name").fill("Primary draft")
                page.locator('.mode-btn.music').click()
                page.wait_for_function(f"async previous => (await ({library_iv})()) !== previous", arg=initial_iv)
                page.get_by_role("button", name="Back", exact=True).click()
                assert page.get_by_text("Primary draft").is_visible()
                page.evaluate("""() => new Promise((resolve, reject) => {
                    const open = indexedDB.open("master-fnk");
                    open.onerror = () => reject(open.error);
                    open.onsuccess = () => {
                        const db = open.result;
                        const tx = db.transaction("kv", "readwrite");
                        const store = tx.objectStore("kv");
                        const keys = store.getAllKeys();
                        keys.onsuccess = () => {
                            const key = keys.result.find(k => k.startsWith("lib:"));
                            if (!key) { tx.abort(); return; }
                            const request = store.get(key);
                            request.onsuccess = () => { store.put(request.result, "library"); store.delete(key); };
                        };
                        tx.oncomplete = () => { db.close(); resolve(); };
                        tx.onabort = () => { db.close(); reject(new Error("Missing primary slot")); };
                    };
                })""")
                page.get_by_role("button", name="Lock", exact=True).click()
                page.get_by_role("button", name="Open decoy vault").click()
                assert page.get_by_text("Enter the second password", exact=False).is_visible()
                page.locator("#password").fill("decoy-password")
                page.get_by_role("button", name="Unlock", exact=True).click()
                page.get_by_role("button", name="Make a film").wait_for()
                assert page.get_by_text("No films yet.").is_visible()
                page.get_by_role("button", name="Lock", exact=True).click()
                page.locator("#password").fill("primary-password")
                page.get_by_role("button", name="Unlock", exact=True).click()
                page.get_by_role("button", name="Make a film").wait_for()
                assert page.get_by_text("Primary draft").is_visible()
                page.get_by_role("button", name="Make a film").click()
                for mode in ("video", "music", "captured"):
                    page.locator(f'[data-studio="{mode}"]').click()
                    assert page.locator(f'.mode-btn.{mode} img').count() == 1
                page.locator('.mode-btn.export').click()
                assert page.locator(".stage-bg").get_attribute("src").endswith("bg_export_trio.jpg")
                assert page.locator(".stage-fig, .mode-btn img").count() == 0
                for category in ("video", "music", "captured"):
                    assert page.locator(f".export-row.{category}").count() == 1
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
