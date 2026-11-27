#!/usr/bin/env python3
"""Decode handoff payloads into the original PNG/JPG assets.

Supports:
  - payloads/*.manifest  (v17-handoff-manifest v1)
  - loose *.b64 files next to their destination names
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILE_MARK = "-- file: "


def _write(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    print(f"wrote {dest.relative_to(ROOT)} ({dest.stat().st_size} bytes)")


def decode_manifests() -> int:
    count = 0
    for manifest in sorted((ROOT / "payloads").glob("*.manifest")) if (ROOT / "payloads").exists() else []:
        text = manifest.read_text()
        current: str | None = None
        buf: list[str] = []
        def flush() -> None:
            nonlocal current, buf, count
            if current is None:
                return
            data = base64.b64decode("".join(buf))
            _write(ROOT / current, data)
            count += 1
            current, buf = None, []
        for line in text.splitlines():
            if line.startswith(FILE_MARK):
                flush()
                current = line[len(FILE_MARK):].strip()
                continue
            if line.startswith("#") or current is None:
                continue
            buf.append(line.strip())
        flush()
    return count


def decode_loose_b64() -> int:
    count = 0
    for path in sorted(ROOT.rglob("*.b64")):
        dest = path.with_name(path.name[: -len(".b64")])
        _write(dest, base64.b64decode(path.read_text()))
        count += 1
    return count


def main() -> int:
    n = decode_manifests() + decode_loose_b64()
    if n == 0:
        print("No payloads found. Assets may already be materialized as PNG/JPG.")
        return 0
    print(f"decoded {n} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
