"""Redis wrapper (docs/runtime-protocol.md). Sync; FakeBus for tests."""

from __future__ import annotations

import json
import os
from collections import deque
from typing import Protocol

CONTROL_KEY = "cameraman:runs:control"
DESIRED_KEY = "cameraman:runs:desired"


def frames_channel(camera_id: str) -> str:
    return f"cameraman:camera:{camera_id}:frames"


def latest_key(camera_id: str) -> str:
    return f"cameraman:camera:{camera_id}:latest"


def heartbeat_key(worker_id: str) -> str:
    return f"cameraman:worker:{worker_id}:heartbeat"


class Bus(Protocol):
    def brpop_control(self, timeout: float = 0) -> dict | None: ...
    def hgetall_desired(self) -> dict[str, dict]: ...
    def publish_frame(self, camera_id: str, jpeg: bytes) -> None: ...
    def set_latest(self, camera_id: str, jpeg: bytes, ttl: int = 30) -> None: ...
    def set_heartbeat(self, worker_id: str, ts: float, ttl: int = 60) -> None: ...


def _loads(raw) -> dict | None:
    try:
        v = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return v if isinstance(v, dict) else None


class RedisBus:
    def __init__(self, url: str | None = None, client=None):
        if client is None:
            import redis

            client = redis.Redis.from_url(url or os.environ.get("REDIS_URL", "redis://localhost"))
        self.r = client

    def brpop_control(self, timeout: float = 0) -> dict | None:
        if timeout <= 0:  # BRPOP 0 would block forever; poll instead
            raw = self.r.rpop(CONTROL_KEY)
        else:
            item = self.r.brpop(CONTROL_KEY, timeout=timeout)
            raw = item[1] if item else None
        return _loads(raw) if raw else None

    def hgetall_desired(self) -> dict[str, dict]:
        out = {}
        for k, v in self.r.hgetall(DESIRED_KEY).items():
            cmd = _loads(v)
            if cmd is not None:
                out[k.decode() if isinstance(k, bytes) else k] = cmd
        return out

    def publish_frame(self, camera_id: str, jpeg: bytes) -> None:
        self.r.publish(frames_channel(camera_id), jpeg)

    def set_latest(self, camera_id: str, jpeg: bytes, ttl: int = 30) -> None:
        self.r.set(latest_key(camera_id), jpeg, ex=ttl)

    def set_heartbeat(self, worker_id: str, ts: float, ttl: int = 60) -> None:
        self.r.set(heartbeat_key(worker_id), str(ts), ex=ttl)


class FakeBus:
    def __init__(self) -> None:
        self.control: deque[dict] = deque()
        self.desired: dict[str, dict] = {}
        self.published: list[tuple[str, bytes]] = []  # (channel, jpeg)
        self.kv: dict[str, tuple[bytes | str, int | None]] = {}

    def push_control(self, cmd: dict) -> None:
        self.control.append(cmd)

    def brpop_control(self, timeout: float = 0) -> dict | None:
        return self.control.popleft() if self.control else None

    def hgetall_desired(self) -> dict[str, dict]:
        return dict(self.desired)

    def publish_frame(self, camera_id: str, jpeg: bytes) -> None:
        self.published.append((frames_channel(camera_id), jpeg))

    def set_latest(self, camera_id: str, jpeg: bytes, ttl: int = 30) -> None:
        self.kv[latest_key(camera_id)] = (jpeg, ttl)

    def set_heartbeat(self, worker_id: str, ts: float, ttl: int = 60) -> None:
        self.kv[heartbeat_key(worker_id)] = (str(ts), ttl)
