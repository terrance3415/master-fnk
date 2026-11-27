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
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
