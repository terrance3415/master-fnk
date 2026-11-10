from __future__ import annotations

import cv2
import numpy as np


def is_scene_cut(previous: np.ndarray, current: np.ndarray, threshold: float) -> bool:
    """True when mean absolute RGB change, scaled to 0..1, reaches the threshold."""
    if threshold <= 0:
        return True
    delta = float(np.mean(np.abs(previous.astype(np.float32) - current.astype(np.float32)))) / 255.0
    return delta >= threshold


def _gray(image: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)


def _flow(source: np.ndarray, dest: np.ndarray) -> np.ndarray:
    flow = cv2.calcOpticalFlowFarneback(
        source,
        dest,
        None,
        0.5,
        3,
        15,
        3,
        5,
        1.2,
        0,
    )
    return np.nan_to_num(flow, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)


def _resize_flow(flow: np.ndarray, width: int, height: int, scale_x: float, scale_y: float) -> np.ndarray:
    resized = cv2.resize(flow, (width, height), interpolation=cv2.INTER_LINEAR).astype(np.float32)
    resized[..., 0] *= scale_x
    resized[..., 1] *= scale_y
    return resized


def _sample(field: np.ndarray, map_x: np.ndarray, map_y: np.ndarray) -> np.ndarray:
    return cv2.remap(field, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def flow_blend(
    previous_lr: np.ndarray,
    current_lr: np.ndarray,
    previous_image: np.ndarray,
    current_image: np.ndarray,
    max_alpha: float,
) -> np.ndarray:
    """Warp previous_image onto current_image with occlusion-aware confidence.

    Optical flow is estimated on the low-resolution pair and scaled onto the
    image pair. Forward-backward inconsistency and a photometric residual both
    drive the blend weight toward zero, so a bad warp keeps the current frame.
    max_alpha is the ceiling. The current frame always keeps weight 1 - alpha.
    """
    if max_alpha <= 0:
        return np.array(current_image, copy=True)
    if previous_lr.shape[:2] != current_lr.shape[:2]:
        raise ValueError("low-resolution pair sizes differ")
    if previous_image.shape != current_image.shape:
        raise ValueError("blend image sizes differ")

    flow_backward = _flow(_gray(current_lr), _gray(previous_lr))
    flow_forward = _flow(_gray(previous_lr), _gray(current_lr))
    out_h, out_w = current_image.shape[:2]
    lr_h, lr_w = current_lr.shape[:2]
    scale_x = out_w / float(lr_w)
    scale_y = out_h / float(lr_h)
    backward = _resize_flow(flow_backward, out_w, out_h, scale_x, scale_y)
    forward = _resize_flow(flow_forward, out_w, out_h, scale_x, scale_y)

    grid_x, grid_y = np.meshgrid(
        np.arange(out_w, dtype=np.float32),
        np.arange(out_h, dtype=np.float32),
    )
    source_x = (grid_x + backward[..., 0]).astype(np.float32)
    source_y = (grid_y + backward[..., 1]).astype(np.float32)
    warped = cv2.remap(
        previous_image,
        source_x,
        source_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )
    forward_x = _sample(forward[..., 0], source_x, source_y)
    forward_y = _sample(forward[..., 1], source_x, source_y)
    error = np.sqrt((backward[..., 0] + forward_x) ** 2 + (backward[..., 1] + forward_y) ** 2)
    sigma = 0.9 * max(scale_x, scale_y) + 0.75
    consistency = np.exp(-error / sigma)
    residual = np.mean(np.abs(warped.astype(np.float32) - current_image.astype(np.float32)), axis=2)
    photometric = np.exp(-residual / 28.0)
    alpha = np.clip(max_alpha * consistency * photometric, 0.0, max_alpha).astype(np.float32)
    mixed = alpha[..., None] * warped.astype(np.float32) + (1.0 - alpha[..., None]) * current_image.astype(np.float32)
    return np.clip(np.rint(mixed), 0, 255).astype(np.uint8)
