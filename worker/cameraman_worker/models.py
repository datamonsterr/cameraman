"""Model abstraction: cached get_model(name), lazy ultralytics, injectable FakeModel."""

from __future__ import annotations

import os
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass

from .boxes import Box, to_xyxy_px


@dataclass(frozen=True)
class Detection:
    label: str
    confidence: float
    box: Box  # normalized x, y, w, h
    xyxy: tuple[int, int, int, int]  # pixel coordinates
    cls: int = 0


class FakeModel:
    """Deterministic model returning canned detections (normalized xywh boxes)."""

    def __init__(self, detections: Iterable[dict] | None = None):
        self.detections = list(detections or [])

    def __call__(self, frame, conf: float = 0.25, classes: Sequence[int] | None = None, **_):
        h, w = frame.shape[:2]
        out = []
        for d in self.detections:
            c = d.get("cls", 0)
            if d["confidence"] < conf or (classes is not None and c not in classes):
                continue
            box = tuple(float(v) for v in d["box"])
            out.append(
                Detection(
                    d.get("label", "person"),
                    float(d["confidence"]),
                    box,  # type: ignore[arg-type]
                    to_xyxy_px(box, w, h),
                    c,
                )
            )
        return out


class UltralyticsModel:
    def __init__(self, name: str):
        try:
            from ultralytics import YOLO
        except ImportError as e:
            raise RuntimeError(
                "ultralytics is not installed; install the 'ml' extra (uv sync --extra ml)"
            ) from e
        self._yolo = YOLO(name if "." in name else f"{name}.pt")
        self.names = getattr(self._yolo, "names", {})

    def __call__(self, frame, conf: float = 0.25, classes: Sequence[int] | None = None, **_):
        h, w = frame.shape[:2]
        dets = []
        for r in self._yolo(frame, conf=conf, classes=classes, verbose=False):
            for b in r.boxes:
                x1, y1, x2, y2 = b.xyxy[0].tolist()
                c = int(b.cls[0])
                dets.append(
                    Detection(
                        str(self.names.get(c, c)),
                        float(b.conf[0]),
                        (x1 / w, y1 / h, (x2 - x1) / w, (y2 - y1) / h),
                        (round(x1), round(y1), round(x2), round(y2)),
                        c,
                    )
                )
        return dets


_cache: dict[str, object] = {}
_factory: Callable[[str], object] | None = None


def register_model(factory: Callable[[str], object] | None) -> None:
    """Inject a model factory (tests); None restores default resolution."""
    global _factory
    _factory = factory


def clear_cache() -> None:
    _cache.clear()


def get_model(name: str):
    if name in _cache:
        return _cache[name]
    if _factory is not None:
        model = _factory(name)
    elif os.environ.get("WORKER_FAKE_MODEL") == "1":
        model = FakeModel([])
    else:
        model = UltralyticsModel(name)
    _cache[name] = model
    return model
