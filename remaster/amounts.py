from __future__ import annotations

import math

from remaster.errors import RemasterError

PRESETS = {
    "off": 0.0,
    "low": 0.25,
    "medium": 0.5,
    "high": 0.75,
}


def parse_amount(value: str, name: str) -> float:
    """Parse off/low/medium/high or a number in [0, 1]."""
    key = str(value).strip().lower()
    if key in PRESETS:
        return PRESETS[key]
    try:
        number = float(key)
    except ValueError as exc:
        raise RemasterError(
            f"{name} must be off, low, medium, high, or a number from 0 to 1 (got {value!r})",
            exit_code=2,
        ) from exc
    if not math.isfinite(number) or number < 0.0 or number > 1.0:
        raise RemasterError(
            f"{name} must be from 0 to 1 inclusive (got {value!r})",
            exit_code=2,
        )
    return float(number)
