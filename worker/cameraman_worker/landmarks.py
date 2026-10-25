"""Landmark auto-calibration (ADR-0008). Pure, deterministic math."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

from .boxes import Box, as_box, center, overlap_ratio

DEFAULT_DRIFT_THRESHOLD = 0.02  # normalized frame units
DEFAULT_SIMILARITY_THRESHOLD = 0.7
DEFAULT_ALPHA = 0.5  # EMA weight of the new observation
DEFAULT_MIN_OVERLAP = 0.3


@dataclass(frozen=True)
class Decision:
    action: str  # "none" | "recalibrate" | "object_moved"
    new_box: Box
    drift: float
    similarity: float


def drift_between(a: Box, b: Box) -> float:
    ca, cb = center(a), center(b)
    return max(math.hypot(ca[0] - cb[0], ca[1] - cb[1]), abs(a[2] - b[2]), abs(a[3] - b[3]))


def ema_box(old: Box, new: Box, alpha: float) -> Box:
    return tuple(o + alpha * (n - o) for o, n in zip(old, new, strict=True))  # type: ignore[return-value]


def decide(
    landmark_box: Sequence[float],
    candidate_box: Sequence[float],
    similarity: float,
    *,
    drift_threshold: float = DEFAULT_DRIFT_THRESHOLD,
    similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
    alpha: float = DEFAULT_ALPHA,
) -> Decision:
    old, cand = as_box(landmark_box), as_box(candidate_box)
    drift = drift_between(old, cand)
    if drift <= drift_threshold:
        return Decision("none", old, drift, similarity)
    if similarity >= similarity_threshold:
        return Decision("recalibrate", ema_box(old, cand, alpha), drift, similarity)
    return Decision("object_moved", old, drift, similarity)


@dataclass
class LandmarkTracker:
    name: str
    box: Box
    drift_threshold: float = DEFAULT_DRIFT_THRESHOLD
    similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD
    alpha: float = DEFAULT_ALPHA
    history: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.box = as_box(self.box)

    def update(
        self, candidate_box: Sequence[float], similarity: float, ts: float = 0.0
    ) -> Decision:
        d = decide(
            self.box,
            candidate_box,
            similarity,
            drift_threshold=self.drift_threshold,
            similarity_threshold=self.similarity_threshold,
            alpha=self.alpha,
        )
        if d.action == "recalibrate":
            self._record(d.new_box, ts, "auto", d.drift)
        return d

    def calibrate(self, box: Sequence[float], ts: float = 0.0) -> None:
        self._record(as_box(box), ts, "manual", drift_between(self.box, as_box(box)))

    def _record(self, new: Box, ts: float, reason: str, drift: float) -> None:
        self.history.append(
            {"ts": ts, "old": self.box, "new": new, "reason": reason, "drift": drift}
        )
        self.box = new

    def contains(self, box: Sequence[float], min_overlap: float = DEFAULT_MIN_OVERLAP) -> bool:
        return overlap_ratio(self.box, box) >= min_overlap
