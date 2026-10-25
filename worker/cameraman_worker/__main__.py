"""Entry point: `python -m cameraman_worker` (env: REDIS_URL, BACKEND_URL, WORKER_TOKEN,
MODEL_CACHE_DIR, NODE_TYPES_PATH)."""

from __future__ import annotations

import logging
import os
import signal
import threading


def build_supervisor():
    from .bus import RedisBus
    from .ingest import HttpIngest
    from .registry import NodeRegistry
    from .runtime import Supervisor

    registry = NodeRegistry.load()  # resolve NODE_TYPES_PATH before any chdir
    cache = os.environ.get("MODEL_CACHE_DIR")
    if cache:
        os.makedirs(cache, exist_ok=True)
        os.environ.setdefault("YOLO_CONFIG_DIR", cache)
        os.chdir(cache)  # ultralytics downloads yolov8n.pt into cwd
    return Supervisor(RedisBus(), HttpIngest(), registry)


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    sup = build_supervisor()
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    sup.serve_forever(stop)


if __name__ == "__main__":
    main()
