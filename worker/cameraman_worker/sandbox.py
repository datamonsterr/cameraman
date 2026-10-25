"""Code Block sandbox (ADR-0007): one subprocess per run with rlimits + wall-clock timeout."""

from __future__ import annotations

import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class Limits:
    cpu_seconds: int = int(os.environ.get("CODEBLOCK_CPU_SECONDS", "10"))
    mem_mb: int = int(os.environ.get("CODEBLOCK_MEM_MB", "2048"))
    wall_seconds: float = float(os.environ.get("CODEBLOCK_WALL_SECONDS", "15"))
    max_output_bytes: int = 1_000_000


@dataclass
class SandboxResult:
    ok: bool
    error: dict | None = None
    actions: list[dict] = field(default_factory=list)
    draw_ops: list[dict] = field(default_factory=list)
    emits: dict = field(default_factory=dict)
    state: dict = field(default_factory=dict)
    landmark_updates: dict = field(default_factory=dict)
    logs: list[str] = field(default_factory=list)
    duration: float = 0.0


def _fail(kind: str, message: str, state: dict, duration: float, **extra) -> SandboxResult:
    return SandboxResult(
        ok=False,
        error={"kind": kind, "type": kind, "message": message, **extra},
        state=state,
        duration=duration,
    )


class Sandbox:
    def __init__(self, limits: Limits | None = None):
        self.limits = limits or Limits()
        self._states: dict[str, dict] = {}  # node_id -> persisted state
        self._pkg_parent = str(Path(__file__).resolve().parent.parent)

    def get_state(self, node_id: str) -> dict:
        return self._states.get(node_id, {})

    def run(
        self,
        code: str,
        frame: np.ndarray,
        *,
        camera: dict,
        config: dict | None = None,
        state: dict | None = None,
        landmarks: dict | None = None,
        now: float | None = None,
        fake_detections: list[dict] | None = None,
        node_id: str | None = None,
    ) -> SandboxResult:
        if state is None:
            state = self._states.get(node_id, {}) if node_id else {}
        started = time.monotonic()
        try:
            res = self._spawn(
                code,
                frame,
                camera,
                config or {},
                state,
                landmarks or {},
                time.time() if now is None else now,
                fake_detections,
            )
        except Exception as e:  # never crash the worker
            res = _fail("crash", f"sandbox error: {e}", state, time.monotonic() - started)
        res.duration = time.monotonic() - started
        if res.ok and node_id:
            self._states[node_id] = res.state
        return res

    def _spawn(self, code, frame, camera, config, state, landmarks, now, fake) -> SandboxResult:
        lim = self.limits
        frame = np.ascontiguousarray(frame)
        header = json.dumps(
            {
                "code": code,
                "config": config,
                "state": state,
                "camera": camera,
                "landmarks": {k: list(v) for k, v in landmarks.items()},
                "now": now,
                "shape": list(frame.shape),
                "dtype": str(frame.dtype),
                "fake_detections": fake,
                "limits": {
                    "cpu_seconds": lim.cpu_seconds,
                    "mem_mb": lim.mem_mb,
                    "max_output_bytes": lim.max_output_bytes,
                },
            }
        ).encode()
        payload = struct.pack(">Q", len(header)) + header + frame.tobytes()
        env = {
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": self._pkg_parent,
            "PYTHONDONTWRITEBYTECODE": "1",
            "OMP_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
            "HOME": "/nonexistent",
        }
        for k in ("WORKER_FAKE_MODEL", "YOLO_CONFIG_DIR", "LD_LIBRARY_PATH", "VIRTUAL_ENV"):
            if k in os.environ:
                env[k] = os.environ[k]
        workdir = tempfile.mkdtemp(prefix="codeblock-")
        try:
            return self._exec(payload, env, workdir, state)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def _exec(self, payload, env, workdir, state) -> SandboxResult:
        lim = self.limits
        proc = subprocess.Popen(
            [sys.executable, "-m", "cameraman_worker._child"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=workdir,
            start_new_session=True,
        )
        try:
            stdout, stderr = proc.communicate(payload, timeout=lim.wall_seconds)
        except subprocess.TimeoutExpired:
            _kill(proc)
            proc.communicate()
            return _fail("timeout", f"exceeded {lim.wall_seconds}s wall clock", state, 0.0)
        except BrokenPipeError:
            _kill(proc)
            return _fail("crash", "child closed pipe early", state, 0.0)
        finally:
            _kill(proc)

        rc = proc.returncode
        if rc == -signal.SIGXCPU or (rc == -signal.SIGKILL and not stdout):
            return _fail(
                "cpu_limit", f"killed (signal {-rc}); CPU limit {lim.cpu_seconds}s", state, 0.0
            )
        if rc == 97:
            return _fail("memory", "out of memory", state, 0.0)
        if rc != 0 or not stdout:
            tail = stderr.decode(errors="replace")[-1000:]
            kind = "memory" if "MemoryError" in tail else "crash"
            return _fail(kind, f"child exited rc={rc}", state, 0.0, stderr=tail)
        if len(stdout) > lim.max_output_bytes + 1024:
            return _fail("output_too_large", "output exceeded cap", state, 0.0)
        try:
            d = json.loads(stdout)
        except ValueError:
            return _fail("crash", "unparseable child output", state, 0.0)
        if not d["ok"]:
            return SandboxResult(ok=False, error=d["error"], state=state, logs=d.get("logs", []))
        return SandboxResult(
            ok=True,
            actions=d["actions"],
            draw_ops=d["draw_ops"],
            emits=d["emits"],
            state=d["state"],
            landmark_updates=d["landmark_updates"],
            logs=d["logs"],
        )


def _kill(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


__all__ = ["Limits", "Sandbox", "SandboxResult"]
