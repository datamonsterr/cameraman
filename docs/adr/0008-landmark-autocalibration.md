# ADR-0008: Still-object landmark auto-calibration

**Status:** Accepted · **Date:** 2026-10-25

## Context
A landmark marks where a still object sits (FR-13). Real cameras drift (mounting shifts,
the object is nudged). The landmark box must follow the object automatically (FR-14) and be
readable from Code Block code (FR-15).

## Decision
- A landmark stores: `name`, `camera_id`, the initial `box`/polygon, a `reference_descriptor`
  (appearance embedding / template), and `calibration` history.
- The worker maintains a tracker per landmark. Each cycle it finds the best-matching detection
  near the landmark (IoU + appearance similarity above thresholds). If the matched box has
  drifted beyond `drift_threshold` but similarity stays high (same object), the landmark box
  is **moved** (smoothed, e.g. EMA) to re-center, and a `calibration` event is recorded.
- Sudden low-similarity changes do **not** recalibrate (prevents a passing person stealing the
  box); they may raise an "object moved/left" event instead.
- `landmark.get(name)` returns the current box; `landmark.calibrate(name, box)` lets code
  force-set it.

## Consequences
- The landmark tracks its object without user action (FR-14 acceptance).
- Thresholds are configurable per landmark; defaults tuned for still objects.
- Deterministic unit tests cover the calibration math with synthetic box/similarity sequences.
