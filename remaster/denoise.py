from __future__ import annotations

import cv2
import numpy as np

from remaster.flow import flow_blend


def bilateral(frame: np.ndarray, strength: float) -> np.ndarray:
    """Edge-preserving spatial denoise. strength is (0, 1]."""
    sigma_color = 6.0 + 50.0 * strength
    sigma_space = 1.5 + 4.0 * strength
    diameter = 5 if strength < 0.7 else 7
    return cv2.bilateralFilter(frame, diameter, sigma_color, sigma_space)


class Denoiser:
    """Spatial bilateral denoise plus a short motion-compensated blend.

    strength 0 bypasses both and returns a copy of the frame. The blend cap is
    0.35 * strength and uses the same occlusion gate as the later temporal
    stage, so a scene change that the caller flags is not averaged across.
    """

    def __init__(self, strength: float) -> None:
        self.strength = float(strength)
        self.prev_spatial: np.ndarray | None = None
        self.prev_out: np.ndarray | None = None

    def apply(self, frame: np.ndarray, scene_cut: bool) -> np.ndarray:
        if self.strength <= 0:
            out = np.array(frame, copy=True)
            self.prev_spatial = out
            self.prev_out = out
            return out
        spatial = bilateral(frame, self.strength)
        if scene_cut or self.prev_out is None or self.prev_spatial is None:
            out = spatial
        else:
            out = flow_blend(
                self.prev_spatial,
                spatial,
                self.prev_out,
                spatial,
                max_alpha=0.35 * self.strength,
            )
        self.prev_spatial = spatial
        self.prev_out = out
        return out
