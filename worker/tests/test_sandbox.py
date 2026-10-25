import numpy as np
import pytest

from cameraman_worker.sandbox import Limits, Sandbox

FRAME = np.zeros((100, 200, 3), dtype=np.uint8)
CAM = {"id": "c1", "name": "Front"}


@pytest.fixture(scope="module")
def sb():
    return Sandbox(limits=Limits(cpu_seconds=10, mem_mb=1024, wall_seconds=20))


def run(sb, code, **kw):
    kw.setdefault("camera", CAM)
    return sb.run(code, FRAME, **kw)


def test_normal_block_returns_actions_draw_emit_state(sb):
    code = """
draw.box((0.1, 0.1, 0.2, 0.2), color=(0, 255, 0), label="x")
emit("n", int(np.sum(frame) + 3))
notify("sub", "body " + camera.name)
state["k"] = state.get("k", 0) + 1
log("hi", 5)
print("printed")
"""
    r = run(sb, code, state={"k": 4})
    assert r.ok, r.error
    assert r.actions == [{"type": "notify", "subject": "sub", "body": "body Front", "to": None}]
    assert r.emits == {"n": 3}
    assert r.state == {"k": 5}
    assert r.draw_ops[0]["op"] == "box"
    assert any("hi 5" in line for line in r.logs) and any("printed" in line for line in r.logs)


def test_frame_is_passed_intact(sb):
    f = np.random.default_rng(0).integers(0, 255, (50, 60, 3), dtype=np.uint8)
    r = sb.run("emit('s', int(frame.sum())); emit('shape', list(frame.shape))", f, camera=CAM)
    assert r.emits["s"] == int(f.sum()) and r.emits["shape"] == [50, 60, 3]


def test_frame_mutation_does_not_leak(sb):
    f = np.zeros((10, 10, 3), dtype=np.uint8)
    sb.run("frame[:] = 255", f, camera=CAM)
    assert not f.any()


def test_exception_captured(sb):
    r = run(sb, "x = 1\nraise ValueError('boom')")
    assert not r.ok
    assert r.error["kind"] == "exception"
    assert r.error["type"] == "ValueError" and "boom" in r.error["message"]
    assert r.actions == []


def test_syntax_error_captured(sb):
    r = run(sb, "def (:")
    assert not r.ok and r.error["type"] == "SyntaxError"


def test_state_unchanged_on_failure(sb):
    r = run(sb, "state['a'] = 2\nraise RuntimeError('x')", state={"a": 1})
    assert not r.ok and r.state == {"a": 1}


def test_infinite_loop_killed_by_timeout():
    s = Sandbox(limits=Limits(cpu_seconds=30, mem_mb=1024, wall_seconds=2))
    r = s.run("while True:\n    pass", FRAME, camera=CAM)
    assert not r.ok and r.error["kind"] == "timeout"
    assert r.duration < 6


def test_cpu_limit_enforced():
    s = Sandbox(limits=Limits(cpu_seconds=1, mem_mb=1024, wall_seconds=15))
    r = s.run("while True:\n    pass", FRAME, camera=CAM)
    assert not r.ok and r.error["kind"] in ("cpu_limit", "timeout")


def test_memory_bomb_capped():
    s = Sandbox(limits=Limits(cpu_seconds=10, mem_mb=512, wall_seconds=20))
    r = s.run("x = bytearray(3 * 1024 ** 3)\nemit('ok', 1)", FRAME, camera=CAM)
    assert not r.ok and r.error["kind"] in ("memory", "crash")


def test_output_size_capped():
    s = Sandbox(
        limits=Limits(cpu_seconds=10, mem_mb=1024, wall_seconds=20, max_output_bytes=10_000)
    )
    r = s.run("emit('big', 'x' * 1_000_000)", FRAME, camera=CAM)
    assert not r.ok and r.error["kind"] == "output_too_large"


def test_hard_exit_does_not_crash_worker(sb):
    r = run(sb, "import os\nos._exit(3)")
    assert not r.ok and r.error["kind"] == "crash"


def test_state_persists_across_calls_for_same_node():
    s = Sandbox(limits=Limits(cpu_seconds=10, mem_mb=1024, wall_seconds=20))
    code = "state['n'] = state.get('n', 0) + 1\nemit('n', state['n'])"
    assert s.run(code, FRAME, camera=CAM, node_id="a").emits["n"] == 1
    assert s.run(code, FRAME, camera=CAM, node_id="a").emits["n"] == 2
    assert s.run(code, FRAME, camera=CAM, node_id="b").emits["n"] == 1


def test_unserializable_state_is_error(sb):
    r = run(sb, "state['f'] = object()")
    assert not r.ok


def test_landmark_api_and_updates(sb):
    code = """
emit("g", landmark.get("door"))
emit("none", landmark.get("nope"))
emit("hit", landmark.contains("door", (0.45, 0.45, 0.1, 0.1)))
emit("miss", landmark.contains("door", (0.0, 0.0, 0.05, 0.05)))
landmark.calibrate("door", (0.5, 0.5, 0.2, 0.2))
emit("after", landmark.get("door"))
"""
    r = run(sb, code, landmarks={"door": (0.4, 0.4, 0.2, 0.2)})
    assert r.ok, r.error
    assert r.emits["g"] == [0.4, 0.4, 0.2, 0.2] and r.emits["none"] is None
    assert r.emits["hit"] is True and r.emits["miss"] is False
    assert r.emits["after"] == [0.5, 0.5, 0.2, 0.2]
    assert r.landmark_updates == {"door": [0.5, 0.5, 0.2, 0.2]}


def test_model_call_with_fake_detections(sb):
    code = """
m = get_model(config.get("model", "yolov8n"))
dets = m(frame, conf=0.4, classes=[0])
emit("n", len(list(dets)))
d = list(dets)[0]
emit("box", list(d.box)); emit("label", d.label); emit("xyxy", list(d.xyxy))
"""
    fake = [{"label": "person", "confidence": 0.9, "box": [0.1, 0.2, 0.3, 0.4], "cls": 0}]
    r = run(sb, code, config={"model": "yolov8n"}, fake_detections=fake)
    assert r.ok, r.error
    assert r.emits["n"] == 1 and r.emits["label"] == "person"
    assert r.emits["xyxy"] == [20, 20, 80, 60]


def test_now_ts_helpers(sb):
    r = run(sb, "emit('now', now()); emit('ts', ts())", now=1000.0)
    assert r.emits["now"] == 1000.0 and isinstance(r.emits["ts"], str)


def test_network_blocked(sb):
    r = run(sb, "import socket\ns = socket.socket()\ns.connect(('127.0.0.1', 9))")
    assert not r.ok and r.error["type"] in ("PermissionError", "OSError")
