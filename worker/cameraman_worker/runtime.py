"""Worker runtime supervisor (docs/runtime-protocol.md).

Deterministic by design: no threads, no sleeping inside. `Supervisor.tick(now)` drains pending
control commands and steps every camera whose frame is due; `serve_forever` is a thin real-time
loop over `tick`. Tests drive `tick` with a fake clock.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from collections.abc import Callable, Sequence

import cv2
import numpy as np

from .autocalib import AutoCalibrator
from .bus import Bus
from .capture import Capture, open_capture
from .engine import GraphEngine, GraphInvalidError
from .ingest import Ingest
from .registry import NodeRegistry
from .sandbox import Sandbox

log = logging.getLogger("cameraman_worker")

FRAME_MIN_INTERVAL = 0.2  # <= 5 fps preview
LATEST_TTL = 30
HEALTH_INTERVAL = 30.0
HEARTBEAT_INTERVAL = 10.0
BACKOFF_START, BACKOFF_MAX = 1.0, 30.0
ERROR_REPORT_INTERVAL = 30.0
MAX_JPEG = 100_000


def encode_jpeg(frame: np.ndarray, max_bytes: int = MAX_JPEG) -> bytes:
    data = b""
    for q in (75, 60, 45, 30):
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, q])
        if not ok:
            raise ValueError("jpeg encode failed")
        data = buf.tobytes()
        if len(data) <= max_bytes:
            break
    return data


class CameraRunner:
    def __init__(self, run: Run, cam: dict, engine: GraphEngine, fps: float):
        self.run, self.cam, self.engine = run, cam, engine
        self.id = cam["id"]
        self.period = 1.0 / max(fps, 0.1)
        self.calib = AutoCalibrator(engine, run.sup.detector)
        self.capture: Capture | None = None
        self.state = "unknown"
        self.backoff = BACKOFF_START
        self.next_retry = 0.0
        self.next_due = 0.0
        self.last_publish = -1e9
        self.last_health = -1e9
        self._err_at: dict[str, float] = {}

    # -- health / failure ---------------------------------------------------
    def _health(self, state: str, now: float, **payload) -> None:
        self.state, self.last_health = state, now
        self.run.sup._safe(
            self.run.sup.ingest.post_health,
            self.id,
            state,
            workflow_id=self.run.workflow_id,
            run_id=self.run.run_id,
            payload=payload or None,
        )

    def _fail(self, now: float, reason: str) -> None:
        if self.capture is not None:
            try:
                self.capture.release()
            except Exception:  # noqa: BLE001
                pass
            self.capture = None
        if self.state != "offline":
            self._health("offline", now, reason=reason)
        self.next_retry = now + self.backoff
        self.backoff = min(self.backoff * 2, BACKOFF_MAX)

    def close(self) -> None:
        if self.capture is not None:
            try:
                self.capture.release()
            except Exception:  # noqa: BLE001
                pass
            self.capture = None

    # -- stepping -------------------------------------------------------------
    def step(self, now: float) -> None:
        if self.state != "unknown" and now - self.last_health >= HEALTH_INTERVAL:
            self._health(self.state, now)
        if self.capture is None:
            if now < self.next_retry:
                return
            try:
                cap = open_capture(self.cam["rtsp_url"], self.run.sup.capture_factory)
                cap.open()
            except Exception as e:  # noqa: BLE001
                self._fail(now, type(e).__name__)
                return
            self.capture = cap
        if now < self.next_due:
            return
        self.next_due = now + self.period
        try:
            frame = self.capture.read()
        except Exception as e:  # noqa: BLE001
            self._fail(now, type(e).__name__)
            return
        if frame is None:
            self._fail(now, "no_frame")
            return
        self.backoff = BACKOFF_START
        if self.state != "online":
            self._health("online", now)
        self._process(frame, now)

    def _process(self, frame: np.ndarray, now: float) -> None:
        sup, run = self.run.sup, self.run
        try:
            for c in self.calib.step(frame, now):
                sup._safe(
                    sup.ingest.post_calibration,
                    self.id,
                    c.landmark,
                    c.old_box,
                    c.new_box,
                    c.similarity,
                    workflow_id=run.workflow_id,
                    run_id=run.run_id,
                )
        except Exception as e:  # noqa: BLE001
            self._report("calibration", f"{type(e).__name__}: {e}", now)
        try:
            res = self.engine.run_frame(frame, now=now)
        except Exception as e:  # noqa: BLE001
            self._report("engine", f"{type(e).__name__}: {e}", now)
            return
        for err in res.errors:
            e = err["error"]
            msg = e.get("message") if isinstance(e, dict) else str(e)
            self._report(err["node_id"], f"code block error: {msg}", now, detail=e)
        if now - self.last_publish >= FRAME_MIN_INTERVAL:
            self.last_publish = now
            try:
                jpeg = encode_jpeg(res.frame)
                sup.bus.publish_frame(self.id, jpeg)
                sup.bus.set_latest(self.id, jpeg, LATEST_TTL)
            except Exception as e:  # noqa: BLE001
                log.warning("frame publish failed: %s", type(e).__name__)
        for a in res.actions:
            self._action(a, res, now)

    def _action(self, a: dict, res, now: float) -> None:
        sup, run = self.run.sup, self.run
        emits = {k: v for d in res.emits.values() for k, v in d.items()}
        sup._safe(
            sup.ingest.post_event,
            "detection",
            camera_id=self.id,
            workflow_id=run.workflow_id,
            run_id=run.run_id,
            message=a.get("subject"),
            payload={"emits": emits, "node_id": a.get("source_node")},
        )
        to = a.get("to") or []
        if isinstance(to, str):
            to = [to]
        if to:
            sup._safe(
                sup.ingest.post_notification,
                to,
                a.get("subject", ""),
                a.get("body", ""),
                dedup_key=f"{run.run_id}:{a.get('node_id') or a.get('source_node')}:{int(now)}",
            )

    def _report(self, key: str, message: str, now: float, detail=None) -> None:
        if now - self._err_at.get(key, -1e9) < ERROR_REPORT_INTERVAL:
            return
        self._err_at[key] = now
        payload = {"node_id": key}
        if isinstance(detail, dict):
            payload["error"] = detail
        self.run.sup._safe(
            self.run.sup.ingest.post_event,
            "system",
            camera_id=self.id,
            workflow_id=self.run.workflow_id,
            run_id=self.run.run_id,
            severity="warn",
            message=message,
            payload=payload,
        )


class Run:
    def __init__(self, sup: Supervisor, cmd: dict):
        self.sup, self.cmd = sup, cmd
        self.run_id = cmd["run_id"]
        self.workflow_id = cmd.get("workflow_id")
        self.cameras: list[CameraRunner] = []
        graph = cmd["graph"]
        cam_cfgs = {
            n["config"].get("camera_id"): n["config"]
            for n in graph.get("nodes", [])
            if n.get("type") == "camera"
        }
        for cam in cmd.get("cameras", []):
            engine = GraphEngine(
                graph,
                sup.registry,
                sandbox=sup.sandbox,
                fake_detections=sup.fake_detections,
                camera_name=cam.get("name"),
            )
            for lm in cmd.get("landmarks", []):
                if lm.get("camera_id") == cam["id"]:
                    kw = {
                        k: lm[k] for k in ("drift_threshold", "similarity_threshold") if k in lm
                    }
                    engine.set_landmark(lm["name"], lm["box"], **kw)
            fps = cam_cfgs.get(cam["id"], {}).get("fps") or cam.get("fps") or 10
            self.cameras.append(CameraRunner(self, cam, engine, fps))

    def step(self, now: float) -> None:
        for c in self.cameras:
            try:
                c.step(now)
            except Exception:  # noqa: BLE001
                log.exception("camera step crashed run=%s", self.run_id)

    def close(self) -> None:
        for c in self.cameras:
            c.close()


class Supervisor:
    def __init__(
        self,
        bus: Bus,
        ingest: Ingest,
        registry: NodeRegistry,
        *,
        capture_factory: Callable[[str], Capture] | None = None,
        detector: Callable[[np.ndarray], Sequence] | None = None,
        sandbox: Sandbox | None = None,
        fake_detections: list[dict] | None = None,
        clock: Callable[[], float] = time.time,
        worker_id: str | None = None,
    ):
        self.bus, self.ingest, self.registry = bus, ingest, registry
        self.capture_factory = capture_factory
        self._detector = detector
        self.sandbox = sandbox or Sandbox()
        self.fake_detections = fake_detections
        self.clock = clock
        self.worker_id = worker_id or uuid.uuid4().hex[:8]
        self.runs: dict[str, Run] = {}
        self._last_beat = -1e9

    # lazily built so tests/imports never load a model
    def detector(self, frame: np.ndarray) -> Sequence:
        if self._detector is None:
            from .models import get_model

            model = get_model(os.environ.get("LANDMARK_MODEL", "yolov8n"))
            self._detector = lambda f: model(f, conf=0.25)
        return self._detector(frame)

    def _safe(self, fn, *a, **kw) -> None:
        try:
            fn(*a, **kw)
        except Exception as e:  # noqa: BLE001
            log.warning("ingest call failed: %s", type(e).__name__)

    # -- control ----------------------------------------------------------------
    def apply(self, cmd: dict) -> None:
        action, run_id = cmd.get("action"), cmd.get("run_id")
        if not run_id:
            return
        if action in ("start", "update"):
            old = self.runs.pop(run_id, None)
            if old:
                old.close()
            try:
                self.runs[run_id] = Run(self, cmd)
            except GraphInvalidError as e:
                self._safe(
                    self.ingest.post_event,
                    "system",
                    workflow_id=cmd.get("workflow_id"),
                    run_id=run_id,
                    severity="warn",
                    message=f"run not started: invalid graph: {e}",
                )
            except Exception:  # noqa: BLE001
                log.exception("failed to build run %s", run_id)
        elif action == "stop":
            run = self.runs.pop(run_id, None)
            if run:
                run.close()

    def resync(self) -> None:
        try:
            desired = self.bus.hgetall_desired()
        except Exception:  # noqa: BLE001
            log.exception("resync failed")
            return
        for cmd in desired.values():
            if cmd.get("action") in ("start", "update"):
                self.apply(cmd)

    def _drain_control(self) -> None:
        while True:
            try:
                cmd = self.bus.brpop_control(0)
            except Exception:  # noqa: BLE001
                log.warning("control read failed")
                return
            if cmd is None:
                return
            self.apply(cmd)

    # -- stepping -----------------------------------------------------------------
    def tick(self, now: float | None = None) -> None:
        now = self.clock() if now is None else now
        self._drain_control()
        for run in list(self.runs.values()):
            run.step(now)
        if now - self._last_beat >= HEARTBEAT_INTERVAL:
            self._last_beat = now
            self._safe(self.bus.set_heartbeat, self.worker_id, now)

    def run_frames(self, n: int, start: float = 0.0, dt: float = 0.1) -> float:
        """Test helper: n ticks on a fake clock. Returns the next timestamp."""
        t = start
        for _ in range(n):
            self.tick(t)
            t += dt
        return t

    def close(self) -> None:
        for run in self.runs.values():
            run.close()
        self.runs.clear()

    def serve_forever(self, stop: threading.Event | None = None, idle: float = 0.01) -> None:
        stop = stop or threading.Event()
        self.resync()
        while not stop.is_set():
            self.tick()
            stop.wait(idle)
        self.close()
