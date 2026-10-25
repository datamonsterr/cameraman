"""Pure box math. Boxes are normalized (x, y, w, h) tuples in [0, 1]."""

from __future__ import annotations

from collections.abc import Sequence

Box = tuple[float, float, float, float]


def as_box(b: Sequence[float]) -> Box:
    x, y, w, h = (float(v) for v in b)
    return (x, y, w, h)


def _inter(a: Box, b: Box) -> float:
    iw = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    ih = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return max(0.0, iw) * max(0.0, ih)


def iou(a: Sequence[float], b: Sequence[float]) -> float:
    a, b = as_box(a), as_box(b)
    inter = _inter(a, b)
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def overlap_ratio(a: Sequence[float], b: Sequence[float]) -> float:
    """Intersection area over the smaller box's area."""
    a, b = as_box(a), as_box(b)
    smaller = min(a[2] * a[3], b[2] * b[3])
    return _inter(a, b) / smaller if smaller > 0 else 0.0


def center(b: Box) -> tuple[float, float]:
    return (b[0] + b[2] / 2, b[1] + b[3] / 2)


def to_xyxy_px(b: Sequence[float], width: int, height: int) -> tuple[int, int, int, int]:
    x, y, w, h = as_box(b)
    return (round(x * width), round(y * height), round((x + w) * width), round((y + h) * height))
