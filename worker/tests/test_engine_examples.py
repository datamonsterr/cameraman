import numpy as np
import pytest
from conftest import EXAMPLES, make_graph

from cameraman_worker.engine import GraphEngine, GraphInvalidError
from cameraman_worker.sandbox import Limits, Sandbox

FRAME = np.zeros((100, 200, 3), dtype=np.uint8)
PERSON = {"label": "person", "confidence": 0.9, "box": [0.45, 0.45, 0.1, 0.3], "cls": 0}
FAR = {"label": "person", "confidence": 0.9, "box": [0.0, 0.0, 0.1, 0.2], "cls": 0}


@pytest.fixture(scope="module")
def sandbox():
    return Sandbox(Limits(cpu_seconds=10, mem_mb=1024, wall_seconds=20))


def engine(registry, sandbox, code, dets, **kw):
    return GraphEngine(
        make_graph(code, **kw), registry, sandbox=sandbox, fake_detections=dets, camera_name="Front"
    )


def test_invalid_graph_rejected(registry, sandbox):
    g = make_graph("pass")
    g["edges"] = []
    with pytest.raises(GraphInvalidError):
        GraphEngine(g, registry, sandbox=sandbox)


def test_human_detection_example_end_to_end(registry, sandbox):
    code = (EXAMPLES / "human_detection.py").read_text()
    eng = engine(registry, sandbox, code, [PERSON])
    r = eng.run_frame(FRAME, now=1000.0)
    assert not r.errors, r.errors
    # a green person box was drawn in the expected region
    x0, y0, x1, y1 = 90, 45, 110, 75
    assert r.frame[y0:y1, x0:x1].any()
    assert tuple(r.frame[45, 95]) == (0, 255, 0)
    assert not FRAME.any()
    assert r.emits["code"]["person_count"] == 1
    assert len(r.actions) == 1
    a = r.actions[0]
    assert a["type"] == "email" and a["node_id"] == "mail" and a["to"] == ["a@b.co"]
    assert a["subject"] == "S Front"
    assert "1 person(s) detected on Front" in a["body"]


def test_cooldown_state_persists_between_frames(registry, sandbox):
    code = (EXAMPLES / "human_detection.py").read_text()
    eng = engine(registry, sandbox, code, [PERSON])
    assert len(eng.run_frame(FRAME, now=1000.0).actions) == 1
    assert eng.run_frame(FRAME, now=1010.0).actions == []
    assert len(eng.run_frame(FRAME, now=1100.0).actions) == 1


def test_no_person_no_action(registry, sandbox):
    code = (EXAMPLES / "human_detection.py").read_text()
    r = engine(registry, sandbox, code, []).run_frame(FRAME, now=1.0)
    assert r.actions == [] and r.emits["code"]["person_count"] == 0


def test_near_door_example(registry, sandbox):
    code = (EXAMPLES / "human_near_door.py").read_text()
    eng = engine(registry, sandbox, code, [PERSON])
    eng.set_landmark("door", (0.4, 0.4, 0.2, 0.4))
    r = eng.run_frame(FRAME, now=1.0)
    assert not r.errors, r.errors
    assert r.emits["code"]["persons_at_door"] == 1
    assert len(r.actions) == 1
    assert "near the door" in r.actions[0]["body"]
    assert tuple(r.frame[45, 90]) == (0, 0, 255)  # red person@door box edge (x=0.45*200)


def test_near_door_far_person_no_alert(registry, sandbox):
    code = (EXAMPLES / "human_near_door.py").read_text()
    eng = engine(registry, sandbox, code, [FAR])
    eng.set_landmark("door", (0.4, 0.4, 0.2, 0.4))
    r = eng.run_frame(FRAME, now=1.0)
    assert r.actions == [] and r.emits["code"]["persons_at_door"] == 0


def test_near_door_without_landmark(registry, sandbox):
    code = (EXAMPLES / "human_near_door.py").read_text()
    r = engine(registry, sandbox, code, [PERSON]).run_frame(FRAME, now=1.0)
    assert not r.errors and r.actions == []


def test_codeblock_error_is_reported_not_raised(registry, sandbox):
    r = engine(registry, sandbox, "raise RuntimeError('x')", []).run_frame(FRAME, now=1.0)
    assert r.errors and r.errors[0]["node_id"] == "code"
    assert r.errors[0]["error"]["type"] == "RuntimeError"
    assert r.actions == [] and r.frame.shape == FRAME.shape


def test_notify_to_override_and_template_vars(registry, sandbox):
    code = "emit('n', 7)\nnotify('s', 'b', to='x@y.zz')"
    eng = engine(
        registry,
        sandbox,
        code,
        [],
        email_cfg={"to": ["a@b.co"], "subject": "n={{n}} {{subject}}", "body": "{{missing}}"},
    )
    a = eng.run_frame(FRAME, now=1.0).actions[0]
    assert a["to"] == ["x@y.zz"] and a["subject"] == "n=7 s" and a["body"] == ""


def test_email_node_cooldown(registry, sandbox):
    code = "notify('s', 'b')"
    eng = engine(
        registry,
        sandbox,
        code,
        [],
        email_cfg={"to": ["a@b.co"], "subject": "s", "cooldown_secs": 60},
    )
    assert len(eng.run_frame(FRAME, now=100.0).actions) == 1
    assert eng.run_frame(FRAME, now=120.0).actions == []
    assert len(eng.run_frame(FRAME, now=161.0).actions) == 1


def test_unrouted_notify_returned_as_notify_action(registry, sandbox):
    g = make_graph("notify('s', 'b')")
    g["nodes"] = g["nodes"][:2]
    g["edges"] = g["edges"][:1]
    eng = GraphEngine(g, registry, sandbox=sandbox, camera_name="Front")
    a = eng.run_frame(FRAME, now=1.0).actions[0]
    assert a["type"] == "notify" and a["to"] is None


def test_landmark_calibrate_from_code_updates_tracker(registry, sandbox):
    eng = engine(registry, sandbox, "landmark.calibrate('door', (0.5, 0.5, 0.1, 0.1))", [])
    eng.set_landmark("door", (0.1, 0.1, 0.1, 0.1))
    eng.run_frame(FRAME, now=5.0)
    assert eng.landmarks["door"].box == (0.5, 0.5, 0.1, 0.1)
    assert eng.landmarks["door"].history[-1]["reason"] == "manual"
