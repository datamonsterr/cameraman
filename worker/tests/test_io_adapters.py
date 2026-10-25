import json

import httpx

from cameraman_worker import __main__ as entry  # noqa: F401  (import must not connect anything)
from cameraman_worker.bus import CONTROL_KEY, DESIRED_KEY, RedisBus
from cameraman_worker.ingest import HttpIngest


def test_http_ingest_headers_and_bodies():
    seen = []

    def handler(req: httpx.Request):
        seen.append((req.url.path, req.headers["x-worker-token"], json.loads(req.content)))
        return httpx.Response(201, json={})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    ing = HttpIngest("http://b:1/", "tok", client=client)
    ing.post_calibration("cam", "door", [0, 0, 1, 1], [0.1, 0, 1, 1], 0.9, run_id="r")
    ing.post_health("cam", "offline")
    ing.post_notification(["a@b.co"], "S", "B", dedup_key="k")
    (p1, t1, b1), (_, _, b2), (p3, _, b3) = seen
    assert p1 == "/api/v1/ingest/events" and t1 == "tok"
    assert b1["kind"] == "calibration" and b1["camera_id"] == "cam"
    assert b1["payload"] == {
        "landmark": "door",
        "old_box": [0.0, 0.0, 1.0, 1.0],
        "new_box": [0.1, 0.0, 1.0, 1.0],
        "similarity": 0.9,
    }
    assert b2["kind"] == "health" and b2["payload"]["state"] == "offline"
    assert p3 == "/api/v1/ingest/notifications" and b3["dedup_key"] == "k"


class FakeRedis:
    def __init__(self):
        self.lists = {CONTROL_KEY: [json.dumps({"action": "stop", "run_id": "x"}).encode()]}
        self.sets, self.pubs = {}, []

    def rpop(self, k):
        return self.lists[k].pop() if self.lists[k] else None

    def brpop(self, k, timeout):
        v = self.rpop(k)
        return (k.encode(), v) if v else None

    def hgetall(self, k):
        assert k == DESIRED_KEY
        return {b"r1": b'{"action":"start","run_id":"r1"}'}

    def publish(self, ch, d):
        self.pubs.append((ch, d))

    def set(self, k, v, ex=None):
        self.sets[k] = (v, ex)


def test_redis_bus_protocol_names():
    r = FakeRedis()
    bus = RedisBus(client=r)
    assert bus.brpop_control(0) == {"action": "stop", "run_id": "x"}
    assert bus.brpop_control(0) is None
    assert bus.hgetall_desired()["r1"]["run_id"] == "r1"
    bus.publish_frame("c", b"j")
    bus.set_latest("c", b"j", 30)
    assert r.pubs == [("cameraman:camera:c:frames", b"j")]
    assert r.sets["cameraman:camera:c:latest"] == (b"j", 30)
