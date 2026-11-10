from __future__ import annotations

from remaster.errors import RemasterError


def tile_starts(length: int, tile: int, overlap: int) -> list[int]:
    """Start offsets matching worker/infer.js tileStarts."""
    if tile <= 0:
        raise RemasterError("tile must be positive", exit_code=2)
    if overlap < 0 or overlap >= tile:
        raise RemasterError("overlap must be >= 0 and < tile", exit_code=2)
    if length <= tile:
        return [0]
    stride = tile - overlap
    starts: list[int] = []
    pos = 0
    while pos < length:
        start = pos if pos + tile <= length else length - tile
        if starts and starts[-1] == start:
            break
        starts.append(start)
        if start + tile >= length:
            break
        pos += stride
    return starts


def tile_count(width: int, height: int, tile: int, overlap: int) -> int:
    return len(tile_starts(width, tile, overlap)) * len(tile_starts(height, tile, overlap))


def assert_tile_budget(width: int, height: int, tile: int, overlap: int, limit: int = 4096) -> int:
    count = tile_count(width, height, tile, overlap)
    if count > limit:
        raise RemasterError(
            f"{count} tiles for a {width}x{height} frame with tile {tile} overlap {overlap}. "
            "Increase --tile or reduce --overlap so a frame stays under "
            f"{limit} tiles. One tile is resident on the GPU at a time, but too many "
            "tiles make the frame unbounded in time.",
            exit_code=2,
        )
    return count
