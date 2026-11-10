from __future__ import annotations

import cv2
import numpy as np


def additional_unsharp(frame: np.ndarray, amount: float) -> np.ndarray:
    """Optional unsharp mask on top of the neural result.

    amount 0 returns a copy and does not blur or sharpen. It does not undo
    sharpening that the compact Real-ESRGAN model already applied. The gain is
    capped (1.15 at amount 1) and tiny residuals under a few levels are left
    alone so grain is not turned into shimmer.
    """
    if amount <= 0:
        return np.array(frame, copy=True)
    blurred = cv2.GaussianBlur(frame, (0, 0), sigmaX=1.05, sigmaY=1.05)
    detail = frame.astype(np.float32) - blurred.astype(np.float32)
    magnitude = np.max(np.abs(detail), axis=2, keepdims=True)
    weight = np.clip((magnitude - 3.0) / 8.0, 0.0, 1.0)
    gain = 1.15 * float(amount)
    sharpened = frame.astype(np.float32) + gain * detail * weight
    return np.clip(np.rint(sharpened), 0, 255).astype(np.uint8)
