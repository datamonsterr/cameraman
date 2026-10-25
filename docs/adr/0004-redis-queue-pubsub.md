# ADR-0004: Redis for job queue and live-frame pub/sub

**Status:** Accepted · **Date:** 2026-10-25

## Context
The backend must tell workers which workflows to run and stream live annotated frames/events
to connected clients with low latency, without bloating Postgres.

## Decision
Use Redis 7: a durable-ish stream/list for run-control jobs (enable/disable/update), and
pub/sub channels for ephemeral live frames (`camera:<id>:frames`) and events
(`events`). Durable records (events, detections, clips metadata) are still written to Postgres
by the worker via the backend; Redis carries only transient realtime traffic + control.

## Consequences
- Low-latency live preview and event fan-out over WebSocket.
- Backend remains the only Postgres writer path for durable data (single source of truth).
- Adding a second worker/consumer is straightforward.
