import cv2
import numpy as np
import pytest
from conftest import CAM_ID, EXAMPLES, make_graph

from cameraman_worker.bus import FakeBus, frames_channel, latest_key
from cameraman_worker.capture import FakeCapture
from cameraman_worker.ingest import FakeIngest
from cameraman_worker.models import FakeModel
from cameraman_worker.runtime import Supervisor
from cameraman_worker.sandbox import Limits, Sandbox

H, W = 100, 200
PERSON = {"label": "person", "confidence": 0.9, "box": [0.45, 0.45, 0.1, 0.3], "cls": 0}


@pytest.fixture(scope="module")
def sandbox():
    return Sandbox(Limits(cpu_seconds=10, mem_mb=1024, wall_seconds=20))


def bg():
    return np.full((H, W, 3), 40, np.uint8)


class Env:
    def __init__(self, registry, sandbox, frames=None, factory=None, detector=None, fake=None):
        self.bus, self.ingest = FakeBus(), FakeIngest()
        self.caps: list[FakeCapture] = []
        frames = frames if frames is not None else [bg()]

        def default_factory(url):
            c = FakeCapture(frames, loop=True)
            self.caps.append(c)
            return c

        self.sup = Supervisor(
            self.bus,
            self.ingest,
            registry,
            capture_factory=factory or default_factory,
            detector=detector,
            sandbox=sandbox,
            fake_detections=fake,
        )


def start_cmd(code="pass", run_id="r1", landmarks=None, fps=10, **kw):
    return {
        "action": "start",
        "run_id": run_id,
        "workflow_id": "w1",
        "version_id": "v1",
        "graph": make_graph(code),
        "cameras": [
            {"id": CAM_ID, "name": "Front", "rtsp_url": "rtsp://x/y", "fps": fps}
        ],
        "landmarks": landmarks or [],
        **kw,
    }


def test_start_update_stop(registry, sandbox):
    e = Env(registry, sandbox)
    e.bus.push_control(start_cmd())
    e.sup.tick(0)
    assert set(e.sup.runs) == {"r1"} and len(e.caps) == 1 and e.caps[0].is_open
    first = e.sup.runs["r1"]
    e.bus.push_control(start_cmd())  # start for known id == update
    e.sup.tick(1)
    assert e.sup.runs["r1"] is not first and not e.caps[0].is_open
    e.bus.push_control({**start_cmd(), "action": "update"})
    e.sup.tick(2)
    assert len(e.sup.runs) == 1
    e.bus.push_control({"action": "stop", "run_id": "nope"})
    e.sup.tick(3)
    assert len(e.sup.runs) == 1
    e.bus.push_control({"action": "stop", "run_id": "r1"})
    e.sup.tick(4)
    assert e.sup.runs == {} and all(not c.is_open for c in e.caps)


def test_resync_from_desired(registry, sandbox):
    e = Env(registry, sandbox)
    e.bus.desired = {"r1": start_cmd(), "r2": start_cmd(run_id="r2")}
    e.sup.resync()
    assert set(e.sup.runs) == {"r1", "r2"}


def test_invalid_graph_posts_system_event(registry, sandbox):
    e = Env(registry, sandbox)
    cmd = start_cmd()
    cmd["graph"]["edges"] = []
    e.bus.push_control(cmd)
    e.sup.tick(0)
    assert e.sup.runs == {}
    assert e.ingest.of_kind("system")[0]["severity"] == "warn"


def test_frames_published_and_latest_set_throttled(registry, sandbox):
    e = Env(registry, sandbox)
    e.bus.push_control(start_cmd(fps=30))
    e.sup.run_frames(30, dt=0.05)  # 1.5s of ticks
    ch = frames_channel(CAM_ID)
    pubs = [p for p in e.bus.published if p[0] == ch]
    assert 1 <= len(pubs) <= 8  # <= 5 fps
    jpeg, ttl = e.bus.kv[latest_key(CAM_ID)]
    assert jpeg[:2] == b"\xff\xd8" and ttl == 30 and len(jpeg) <= 100_000
    assert cv2.imdecode(np.frombuffer(jpeg, np.uint8), 1).shape == (H, W, 3)
    assert e.ingest.of_kind("health")[0]["payload"]["state"] == "online"
    assert any(k.startswith("cameraman:worker:") for k in e.bus.kv)


def test_notify_action_posts_notification(registry, sandbox):
    code = (EXAMPLES / "human_detection.py").read_text()
    e = Env(registry, sandbox, fake=[PERSON])
    e.bus.push_control(start_cmd(code))
    e.sup.run_frames(3, start=1000.0, dt=0.1)
    assert len(e.ingest.notifications) == 1  # cooldown suppresses the rest
    n = e.ingest.notifications[0]
    assert n["recipients"] == ["a@b.co"] and "Front" in n["subject"]
    assert e.ingest.of_kind("detection")
    # person box was drawn in the published frame (green)
    jpeg, _ = e.bus.kv[latest_key(CAM_ID)]
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), 1)
    assert img[45, 95, 1] > 150 and img[45, 95, 0] < 100


def test_door_example_overlap_triggers_notification(registry, sandbox):
    code = (EXAMPLES / "human_near_door.py").read_text()
    lm = [{"name": "door", "camera_id": CAM_ID, "box": [0.4, 0.4, 0.3, 0.5]}]
    e = Env(registry, sandbox, fake=[PERSON], detector=lambda f: [])
    e.bus.push_control(start_cmd(code, landmarks=lm))
    e.sup.run_frames(2, start=1000.0)
    assert len(e.ingest.notifications) == 1
    assert "door" in e.ingest.notifications[0]["body"]

    far = {**PERSON, "box": [0.0, 0.0, 0.1, 0.2]}
    e2 = Env(registry, sandbox, fake=[far], detector=lambda f: [])
    e2.bus.push_control(start_cmd(code, landmarks=lm))
    e2.sup.run_frames(2, start=1000.0)
    assert e2.ingest.notifications == []


def test_capture_failure_offline_backoff_no_crash(registry, sandbox):
    attempts = []

    class Bad:
        is_open = False

        def open(self):
            attempts.append(1)
            raise ConnectionError("down")

        def release(self):
            pass

    e = Env(registry, sandbox, factory=lambda url: Bad())
    e.bus.push_control(start_cmd())
    e.sup.run_frames(50, dt=0.1)  # 5s
    health = e.ingest.of_kind("health")
    assert len(health) == 1 and health[0]["payload"]["state"] == "offline"
    assert 2 <= len(attempts) <= 4  # exponential backoff, not every tick
    assert e.sup.runs  # supervisor alive


def test_capture_recovers_online(registry, sandbox):
    state = {"n": 0}

    def factory(url):
        state["n"] += 1
        if state["n"] == 1:
            return FakeCapture([bg()])  # 1 frame then stream ends
        return FakeCapture([bg()], loop=True)

    e = Env(registry, sandbox, factory=factory)
    e.bus.push_control(start_cmd())
    e.sup.run_frames(40, dt=0.1)
    states = [h["payload"]["state"] for h in e.ingest.of_kind("health")]
    assert states[:3] == ["online", "offline", "online"]


def test_user_code_error_is_warn_event_and_loop_continues(registry, sandbox):
    e = Env(registry, sandbox)
    e.bus.push_control(start_cmd("raise ValueError('boom')"))
    e.sup.run_frames(5, start=1000.0)
    sysev = e.ingest.of_kind("system")
    assert len(sysev) == 1 and sysev[0]["severity"] == "warn"
    assert "boom" in str(sysev[0])
    assert e.bus.published  # frames still flowing
    assert e.sup.runs


def test_ingest_failure_never_crashes(registry, sandbox):
    class Boom(FakeIngest):
        def post_event(self, kind, **kw):
            raise RuntimeError("backend down")

    e = Env(registry, sandbox)
    e.sup.ingest = Boom()
    e.bus.push_control(start_cmd())
    e.sup.run_frames(3)
    assert e.sup.runs


def test_fakemodel_import_sanity():
    assert FakeModel([]) is not None
