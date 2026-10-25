"""Sandbox child process: runs ONE Code Block, then exits. Not imported by the worker.

Protocol (stdin): 8-byte big-endian header length, JSON header, raw frame bytes.
Protocol (stdout): one JSON result document (the real stdout fd is private to this module).
"""

from __future__ import annotations

import datetime as _dt
import io
import json
import os
import resource
import socket
import struct
import sys
import traceback
import types

import cv2
import numpy as np

from cameraman_worker import models
from cameraman_worker.boxes import as_box, overlap_ratio
from cameraman_worker.draw import DrawRecorder


class _Lazy:
    """Import heavy optional libs (torch, ultralytics) only when user code touches them."""

    def __init__(self, name: str):
        self._name = name
        self._mod = None

    def __getattr__(self, item):
        if self._mod is None:
            import importlib

            self._mod = importlib.import_module(self._name)
        return getattr(self._mod, item)


def _jsonable(o):
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, tuple):
        return list(o)
    raise TypeError(f"not JSON serializable: {type(o).__name__}")


def _norm(value):
    """Round-trip through JSON so everything returned is plain data (and validated)."""
    return json.loads(json.dumps(value, default=_jsonable))


def _apply_limits(lim: dict) -> None:
    cpu = int(lim["cpu_seconds"])
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
    mem = int(lim["mem_mb"]) * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def _block_network() -> None:
    def deny(*_a, **_k):
        raise PermissionError("network access is disabled in Code Blocks")

    for name in ("connect", "connect_ex", "bind", "sendto", "listen"):
        setattr(socket.socket, name, deny)
    socket.create_connection = deny  # type: ignore[assignment]
    socket.getaddrinfo = deny  # type: ignore[assignment]


class _Landmark:
    def __init__(self, boxes: dict):
        self._boxes = {k: as_box(v) for k, v in boxes.items()}
        self.updates: dict[str, list[float]] = {}

    def get(self, name):
        b = self._boxes.get(name)
        return None if b is None else list(b)

    def calibrate(self, name, box):
        self._boxes[name] = as_box(box)
        self.updates[name] = list(self._boxes[name])

    def contains(self, name, box, min_overlap=0.3):
        b = self._boxes.get(name)
        return b is not None and overlap_ratio(b, box) >= min_overlap


def _main() -> None:
    raw = sys.stdin.buffer.read()
    (hlen,) = struct.unpack(">Q", raw[:8])
    header = json.loads(raw[8 : 8 + hlen])
    frame = np.frombuffer(raw[8 + hlen :], dtype=header["dtype"]).reshape(header["shape"]).copy()
    del raw

    out_fd = os.dup(1)
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 1)
    out = os.fdopen(out_fd, "wb")

    lim = header["limits"]
    _block_network()
    _apply_limits(lim)

    logs: list[str] = []
    captured = io.StringIO()
    sys.stdout = captured
    max_logs = 200

    def log(*args):
        if len(logs) < max_logs:
            logs.append(" ".join(str(a) for a in args)[:2000])

    emits: dict = {}
    actions: list[dict] = []
    recorder = DrawRecorder()
    landmark = _Landmark(header["landmarks"])
    now_value = float(header["now"])
    state = header["state"]
    result: dict = {"ok": True, "error": None}

    def emit(key, value):
        if len(emits) < 200 or key in emits:
            emits[str(key)] = _norm(value)

    def notify(subject, body, to=None):
        if isinstance(to, str):
            to = [to]
        actions.append(
            {
                "type": "notify",
                "subject": str(subject),
                "body": str(body),
                "to": None if to is None else [str(t) for t in to],
            }
        )

    if header.get("fake_detections") is not None:
        fake = header["fake_detections"]
        models.register_model(lambda _name: models.FakeModel(fake))

    ns = {
        "__name__": "__codeblock__",
        "frame": frame,
        "np": np,
        "cv2": cv2,
        "torch": _Lazy("torch"),
        "ultralytics": _Lazy("ultralytics"),
        "get_model": models.get_model,
        "draw": recorder,
        "notify": notify,
        "landmark": landmark,
        "emit": emit,
        "state": state,
        "camera": types.SimpleNamespace(**header["camera"]),
        "config": header["config"],
        "now": lambda: now_value,
        "ts": lambda: _dt.datetime.fromtimestamp(now_value, _dt.UTC).isoformat(),
        "log": log,
    }

    try:
        exec(compile(header["code"], "<codeblock>", "exec"), ns)  # noqa: S102
        final_state = _norm(state)
    except BaseException as e:  # noqa: BLE001 - user code may raise anything
        kind = "memory" if isinstance(e, MemoryError) else "exception"
        result = {
            "ok": False,
            "error": {
                "kind": kind,
                "type": type(e).__name__,
                "message": str(e)[:2000],
                "traceback": traceback.format_exc()[-4000:],
            },
        }
        final_state = None
    sys.stdout = sys.__stdout__
    for line in captured.getvalue().splitlines()[:max_logs]:
        log(line)

    result.update(
        actions=actions if result["ok"] else [],
        draw_ops=recorder.ops if result["ok"] else [],
        emits=emits if result["ok"] else {},
        state=final_state,
        landmark_updates=landmark.updates if result["ok"] else {},
        logs=logs,
    )
    payload = json.dumps(result, default=_jsonable).encode()
    if len(payload) > lim["max_output_bytes"]:
        payload = json.dumps(
            {
                "ok": False,
                "error": {
                    "kind": "output_too_large",
                    "type": "OutputTooLarge",
                    "message": f"output {len(payload)} bytes exceeds cap",
                },
                "actions": [],
                "draw_ops": [],
                "emits": {},
                "state": None,
                "landmark_updates": {},
                "logs": [],
            }
        ).encode()
    out.write(payload)
    out.flush()
    os._exit(0)


if __name__ == "__main__":
    try:
        _main()
    except MemoryError:
        os._exit(97)
