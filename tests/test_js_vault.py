import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_vault_lock_and_film_math():
    completed = subprocess.run(
        [
            "node",
            "--test",
            "tests/test_vault.mjs",
            "tests/test_filmmath.mjs",
            "tests/test_pixels.mjs",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    assert completed.returncode == 0, completed.stdout + "\n" + completed.stderr
