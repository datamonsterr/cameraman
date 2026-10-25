"""Appearance similarity for landmark auto-calibration: HSV histogram + correlation."""

from __future__ import annotations

from collections.abc import Sequence

import cv2
import numpy as np

BINS = (8, 8, 4)


def hsv_histogram(frame: np.ndarray, box: Sequence[float]) -> np.ndarray | None:
    """Normalized HSV histogram of the crop at a normalized (x, y, w, h) box; None if empty."""
    h, w = frame.shape[:2]
    x, y, bw, bh = (float(v) for v in box)
    x0, y0 = max(0, int(round(x * w))), max(0, int(round(y * h)))
    x1, y1 = min(w, int(round((x + bw) * w))), min(h, int(round((y + bh) * h)))
    if x1 <= x0 or y1 <= y0:
        return None
    hsv = cv2.cvtColor(np.ascontiguousarray(frame[y0:y1, x0:x1]), cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, list(BINS), [0, 180, 0, 256, 0, 256])
    cv2.normalize(hist, hist, 1.0, 0.0, cv2.NORM_L1)
    return hist


def similarity(a: np.ndarray | None, b: np.ndarray | None) -> float:
    """Histogram correlation clamped to [0, 1]; 0 if either is missing."""
    if a is None or b is None:
        return 0.0
    c = float(cv2.compareHist(a, b, cv2.HISTCMP_CORREL))
    return min(1.0, max(0.0, c)) if c == c else 0.0
