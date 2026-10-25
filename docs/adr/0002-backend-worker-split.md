# ADR-0002: Backend/worker responsibility split

**Status:** Accepted · **Date:** 2026-10-25

## Context
Live video decoding, model inference, and running untrusted user Python are CPU/GPU-heavy and
Python-centric. The API layer needs to stay responsive and safe.

## Decision
- **Backend (Rust/Axum)** owns: HTTP/WS API, auth, persistence (Postgres), camera registry,
  discovery orchestration, workflow CRUD, run supervision, event fan-out, email dispatch.
- **Worker (Python)** owns: RTSP ingestion, frame decode, workflow graph execution, YOLO
  inference, the Code Block sandbox, landmark calibration, and producing annotated frames.
- They communicate via Redis (job queue for run control; pub/sub for live frames/events).

## Consequences
- The API stays fast and memory-safe; heavy/unsafe work is isolated in the worker.
- A worker crash (e.g. bad user code) cannot take down the API.
- Clear scaling axis: run more workers for more cameras.
