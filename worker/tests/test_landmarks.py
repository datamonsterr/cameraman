import pytest

from cameraman_worker.boxes import iou, overlap_ratio
from cameraman_worker.landmarks import LandmarkTracker, decide


def test_iou_identical_and_disjoint():
    assert iou((0.1, 0.1, 0.2, 0.2), (0.1, 0.1, 0.2, 0.2)) == pytest.approx(1.0)
    assert iou((0, 0, 0.1, 0.1), (0.5, 0.5, 0.1, 0.1)) == 0.0


def test_overlap_ratio_uses_smaller_area():
    big = (0.0, 0.0, 0.5, 0.5)
    small = (0.1, 0.1, 0.1, 0.1)
    assert overlap_ratio(big, small) == pytest.approx(1.0)


def test_decide_stable_when_no_drift():
    d = decide((0.4, 0.4, 0.2, 0.2), (0.401, 0.4, 0.2, 0.2), 0.95)
    assert d.action == "none"
    assert d.new_box == (0.4, 0.4, 0.2, 0.2)


def test_decide_recalibrates_on_drift_with_high_similarity():
    old = (0.4, 0.4, 0.2, 0.2)
    cand = (0.45, 0.4, 0.2, 0.2)
    d = decide(old, cand, 0.9, alpha=0.5)
    assert d.action == "recalibrate"
    assert d.new_box[0] == pytest.approx(0.425)
    assert d.new_box[1] == pytest.approx(0.4)


def test_low_similarity_never_recalibrates_and_flags_moved():
    old = (0.4, 0.4, 0.2, 0.2)
    cand = (0.5, 0.4, 0.2, 0.2)  # passing person
    d = decide(old, cand, 0.2)
    assert d.action == "object_moved"
    assert d.new_box == old


def test_low_similarity_without_drift_is_none():
    old = (0.4, 0.4, 0.2, 0.2)
    assert decide(old, old, 0.1).action == "none"


def test_thresholds_are_configurable():
    old = (0.4, 0.4, 0.2, 0.2)
    cand = (0.41, 0.4, 0.2, 0.2)
    assert decide(old, cand, 0.9).action == "none"
    assert decide(old, cand, 0.9, drift_threshold=0.01).action == "recalibrate"
    assert decide(old, cand, 0.6, drift_threshold=0.01, similarity_threshold=0.7).action != (
        "recalibrate"
    )


def test_tracker_follows_nudged_still_object():
    t = LandmarkTracker("door", (0.40, 0.40, 0.2, 0.2), alpha=0.6)
    true_x = 0.40
    for step in range(30):
        if step >= 5:
            true_x = min(0.55, true_x + 0.01)  # nudged across frames
        t.update((true_x, 0.40, 0.2, 0.2), 0.93, ts=float(step))
    assert t.box[0] == pytest.approx(0.55, abs=0.03)
    assert len(t.history) >= 1
    assert t.history[0]["old"] == (0.40, 0.40, 0.2, 0.2)


def test_tracker_ignores_passing_person():
    t = LandmarkTracker("door", (0.4, 0.4, 0.2, 0.2))
    for i in range(10):
        d = t.update((0.4 + 0.05 * i, 0.4, 0.2, 0.2), 0.1, ts=float(i))
        assert d.action in ("none", "object_moved")
    assert t.box == (0.4, 0.4, 0.2, 0.2)
    assert t.history == []


def test_tracker_calibrate_force_set_records_history():
    t = LandmarkTracker("door", (0.1, 0.1, 0.1, 0.1))
    t.calibrate((0.5, 0.5, 0.2, 0.2), ts=1.0)
    assert t.box == (0.5, 0.5, 0.2, 0.2)
    assert t.history[-1]["reason"] == "manual"


def test_tracker_contains():
    t = LandmarkTracker("door", (0.4, 0.4, 0.2, 0.2))
    assert t.contains((0.45, 0.45, 0.1, 0.3))
    assert not t.contains((0.0, 0.0, 0.1, 0.1))
