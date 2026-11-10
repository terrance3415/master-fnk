from __future__ import annotations

import numpy as np

from remaster.flow import flow_blend


class TemporalStabilizer:
    """BasicVSR-style recurrent stabilization. This is not a trained BasicVSR model.

    The previous enhanced frame is warped with optical flow onto the current
    enhanced frame and mixed with a cap of 0.55 * strength. Forward-backward
    flow checks and a photometric residual drop the mix on occlusions and on
    content that does not match, which is what limits ghosting. A scene cut
    passed in by the caller drops the recurrent state.
    """

    def __init__(self, strength: float) -> None:
        self.strength = float(strength)
        self.prev_lr: np.ndarray | None = None
        self.prev_hr: np.ndarray | None = None

    def apply(self, low_res: np.ndarray, high_res: np.ndarray, scene_cut: bool) -> np.ndarray:
        if self.strength <= 0 or scene_cut or self.prev_hr is None or self.prev_lr is None:
            out = np.array(high_res, copy=True)
        else:
            out = flow_blend(
                self.prev_lr,
                low_res,
                self.prev_hr,
                high_res,
                max_alpha=0.55 * self.strength,
            )
        self.prev_lr = np.array(low_res, copy=True)
        self.prev_hr = out
        return out
