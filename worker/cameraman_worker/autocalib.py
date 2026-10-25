"""Landmark auto-calibration wiring (FR-14): candidates -> appearance similarity -> tracker."""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np

from .appearance import hsv_histogram, similarity
from .boxes import Box, center, iou
from .engine import GraphEngine


@dataclass(frozen=True)
class Calibration:
    landmark: str
    old_box: Box
    new_box: Box
    similarity: float


def best_candidate(
    landmark_box: Box, ref_hist, frame: np.ndarray, detections: Sequence, near: float = 1.5
):
    """Detection near the landmark with max(IoU, appearance similarity); (det, sim) or None."""
    lc = center(landmark_box)
    reach = near * max(landmark_box[2], landmark_box[3])
    best, best_score, best_sim = None, -1.0, 0.0
    for d in detections:
        c = center(d.box)
        if math.hypot(c[0] - lc[0], c[1] - lc[1]) > reach:
            continue
        sim = similarity(ref_hist, hsv_histogram(frame, d.box))
        score = max(iou(landmark_box, d.box), sim)
        if score > best_score:
            best, best_score, best_sim = d, score, sim
    return None if best is None else (best, best_sim)


class AutoCalibrator:
    """Per-camera: keeps each landmark's reference histogram and drives LandmarkTracker.update."""

    def __init__(self, engine: GraphEngine, detector: Callable[[np.ndarray], Sequence]):
        self.engine, self.detector = engine, detector
        self.refs: dict[str, np.ndarray | None] = {}

    def step(self, frame: np.ndarray, ts: float) -> list[Calibration]:
        trackers = self.engine.landmarks
        if not trackers:
            return []
        dets = list(self.detector(frame))
        out: list[Calibration] = []
        for name, tr in trackers.items():
            if self.refs.get(name) is None:
                self.refs[name] = hsv_histogram(frame, tr.box)
                continue
            found = best_candidate(tr.box, self.refs[name], frame, dets)
            if found is None:
                continue
            det, sim = found
            old = tr.box
            if tr.update(det.box, sim, ts).action == "recalibrate":
                new_ref = hsv_histogram(frame, tr.box)
                if new_ref is not None:
                    self.refs[name] = new_ref
                out.append(Calibration(name, old, tr.box, sim))
        return out
