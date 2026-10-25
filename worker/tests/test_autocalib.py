import numpy as np
import pytest
from conftest import CAM_ID, make_graph

from cameraman_worker.bus import FakeBus
from cameraman_worker.capture import FakeCapture
from cameraman_worker.ingest import FakeIngest
from cameraman_worker.models import FakeModel
from cameraman_worker.runtime import Supervisor
from cameraman_worker.sandbox import Limits, Sandbox

H, W = 200, 300
LANDMARK = [0.40, 0.40, 0.20, 0.20]
RED, BLUE = (0, 0, 255), (255, 0, 0)


@pytest.fixture(scope="module")
def sandbox():
    return Sandbox(Limits(cpu_seconds=10, mem_mb=1024, wall_seconds=20))


def frame_with(box, color):
    f = np.full((H, W, 3), 40, np.uint8)
    x, y, w, h = box
    f[round(y * H) : round((y + h) * H), round(x * W) : round((x + w) * W)] = color
    return f


class SeqDetector:
    """Returns the scripted detections for each successive frame."""

    def __init__(self, seq):
        self.seq, self.i = seq, 0

    def __call__(self, frame):
        boxes = self.seq[min(self.i, len(self.seq) - 1)]
        self.i += 1
        return FakeModel(
            [{"label": "obj", "confidence": 0.9, "box": b} for b in boxes]
        )(frame)


LM_PROBE = "emit('door', landmark.get('door'))"


def run_scene(registry, sandbox, frames, boxes_seq):
    bus, ingest = FakeBus(), FakeIngest()
    sup = Supervisor(
        bus,
        ingest,
        registry,
        capture_factory=lambda u: FakeCapture(frames),
        detector=SeqDetector(boxes_seq),
        sandbox=sandbox,
    )
    bus.push_control(
        {
            "action": "start",
            "run_id": "r1",
            "workflow_id": "w1",
            "graph": make_graph(LM_PROBE),
            "cameras": [{"id": CAM_ID, "name": "F", "rtsp_url": "rtsp://x", "fps": 10}],
            "landmarks": [
                {"name": "door", "camera_id": CAM_ID, "box": LANDMARK, "drift_threshold": 0.02}
            ],
        }
    )
    sup.run_frames(len(frames) + 1, start=1000.0)
    eng = sup.runs["r1"].cameras[0].engine
    return sup, ingest, eng


def test_landmark_follows_drifting_object(registry, sandbox):
    boxes = [[LANDMARK[0] + 0.03 * i, LANDMARK[1], 0.2, 0.2] for i in range(8)]
    frames = [frame_with(b, RED) for b in boxes]
    sup, ingest, eng = run_scene(registry, sandbox, frames, [[b] for b in boxes])
    final = eng.landmarks["door"].box
    assert final[0] > LANDMARK[0] + 0.08  # followed to the right
    assert abs(final[0] - boxes[-1][0]) < 0.08
    cals = ingest.of_kind("calibration")
    assert len(cals) >= 3
    p = cals[0]["payload"]
    assert p["landmark"] == "door" and p["old_box"] == LANDMARK and p["similarity"] >= 0.7
    assert p["new_box"][0] > p["old_box"][0]
    assert cals[0]["camera_id"] == CAM_ID
    # the box the Code Block API sees moved too (last emitted value)
    assert eng.node_state is not None
    emitted = eng.run_frame(frames[-1], now=2000.0).emits["code"]["door"]
    assert emitted[0] == pytest.approx(final[0])


def test_dissimilar_box_does_not_recalibrate(registry, sandbox):
    other = [LANDMARK[0] + 0.1, LANDMARK[1], 0.2, 0.2]
    frames = [frame_with(LANDMARK, RED)] + [frame_with(other, BLUE) for _ in range(5)]
    # object (red) is gone; a blue lookalike-shaped box appears nearby
    sup, ingest, eng = run_scene(registry, sandbox, frames, [[LANDMARK]] + [[other]] * 5)
    assert eng.landmarks["door"].box == tuple(LANDMARK)
    assert ingest.of_kind("calibration") == []
