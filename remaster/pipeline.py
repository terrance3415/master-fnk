from __future__ import annotations

from collections.abc import Callable

import numpy as np

from remaster.denoise import Denoiser
from remaster.flow import is_scene_cut
from remaster.sharpen import additional_unsharp
from remaster.temporal import TemporalStabilizer

Upscaler = Callable[[np.ndarray], np.ndarray]


def pipeline_order(denoise: float, sharpen: float, encoder: str) -> list[str]:
    return [
        "technical-validate",
        "denoise" if denoise > 0 else "denoise-bypass",
        "realesrgan-compact-ort-web",
        "unsharp-additional" if sharpen > 0 else "unsharp-bypass",
        "basicvsr-style-temporal",
        encoder,
    ]


class FrameProcessor:
    """Denoise, upscale, optional unsharp, then temporal stabilization, one frame at a time."""

    def __init__(
        self,
        upscaler: Upscaler,
        denoise: float,
        sharpen: float,
        temporal_strength: float,
        scene_threshold: float,
    ) -> None:
        self.upscaler = upscaler
        self.sharpen = float(sharpen)
        self.scene_threshold = float(scene_threshold)
        self.denoiser = Denoiser(denoise)
        self.stabilizer = TemporalStabilizer(temporal_strength)
        self.previous: np.ndarray | None = None
        self.scene_cuts: list[int] = []
        self.frames_in = 0

    def push(self, frame: np.ndarray) -> np.ndarray:
        cut = self.previous is not None and is_scene_cut(self.previous, frame, self.scene_threshold)
        index = self.frames_in
        self.frames_in += 1
        if cut:
            self.scene_cuts.append(index)
        denoised = self.denoiser.apply(frame, scene_cut=cut)
        upscaled = self.upscaler(denoised)
        if self.sharpen > 0:
            sharpened = additional_unsharp(upscaled, self.sharpen)
        else:
            sharpened = upscaled
        stabilized = self.stabilizer.apply(denoised, sharpened, scene_cut=cut)
        self.previous = np.array(frame, copy=True)
        return stabilized
