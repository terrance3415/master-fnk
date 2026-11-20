import json
import subprocess
from pathlib import Path

import pytest

pytest.importorskip("cryptography")

import nitrate_crypto as nc

ROOT = Path(__file__).resolve().parents[1]


def test_python_nenc_opens_in_the_browser_writer(tmp_path: Path):
    src = tmp_path / "plain.bin"
    enc = tmp_path / "clip.nenc"
    src.write_bytes(b"cross-check-video")
    nc.encrypt_file(
        src,
        enc,
        password="correct horse",
        kdf="scrypt",
        kdf_params={"n": 2**10, "r": 8, "p": 1},
        chunk_size=8,
    )
    script = r"""
import { readFileSync } from "node:fs";
import { decryptBytes } from "./web/src/nenc.mjs";
const bytes = new Uint8Array(readFileSync(process.argv[1]));
const plain = await decryptBytes(bytes, process.argv[2]);
process.stdout.write(Buffer.from(plain).toString("utf8"));
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script, str(enc), "correct horse"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout == "cross-check-video"
    assert json.dumps({"header": nc.HEADER_SIZE})
    assert nc.HEADER_SIZE == 54
