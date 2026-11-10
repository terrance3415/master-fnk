#!/usr/bin/env python3
"""Draw the home-screen icons. No third-party image library."""
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "web" / "icons"


def write_png(path: Path, width: int, height: int, pixels: bytes) -> None:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(pixels[y * stride : (y + 1) * stride])

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def paint(size: int, inset: float) -> bytes:
    pixels = bytearray(size * size * 4)
    margin = size * inset
    radius = size * 0.22
    gold = (226, 177, 90, 255)
    ink = (16, 14, 12, 255)
    for y in range(size):
        for x in range(size):
            px = (y * size + x) * 4
            # rounded-rect plate
            nx = min(x - margin, size - 1 - margin - x)
            ny = min(y - margin, size - 1 - margin - y)
            inside = nx >= 0 and ny >= 0 and (nx >= radius or ny >= radius or (nx - radius) ** 2 + (ny - radius) ** 2 <= radius ** 2)
            if not inside:
                pixels[px : px + 4] = b"\x00\x00\x00\x00" if inset > 0.12 else bytes(ink)
                if inset <= 0.12:
                    pixels[px : px + 4] = bytes((12, 10, 9, 255))
                continue
            pixels[px : px + 4] = bytes((28, 24, 20, 255))
            cx = size / 2
            cy = size / 2
            # film gate
            gate_w = size * 0.46
            gate_h = size * 0.34
            if abs(x - cx) < gate_w / 2 and abs(y - cy) < gate_h / 2:
                pixels[px : px + 4] = bytes(gold)
            hole = size * 0.055
            for hy in (-1, 1):
                for i in range(-2, 3):
                    hx = cx + i * size * 0.11
                    yy = cy + hy * (gate_h / 2 + size * 0.07)
                    if (x - hx) ** 2 + (y - yy) ** 2 <= hole ** 2:
                        pixels[px : px + 4] = bytes(gold)
    return bytes(pixels)


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    write_png(ROOT / "icon-192.png", 192, 192, paint(192, 0.0))
    write_png(ROOT / "icon-512.png", 512, 512, paint(512, 0.0))
    write_png(ROOT / "apple-touch-icon.png", 180, 180, paint(180, 0.0))
    write_png(ROOT / "icon-maskable.png", 512, 512, paint(512, 0.18))


if __name__ == "__main__":
    main()
