# ADR-0001: Polyglot monorepo

**Status:** Accepted · **Date:** 2026-10-25

## Context
The product needs a high-throughput, safe API layer; a Python-native computer-vision runtime
(PyTorch, OpenCV, Ultralytics have no first-class Rust equivalents); a rich web app; and a
mobile app. These have different languages and release cadences but share one spec and data
model.

## Decision
Use a single monorepo with per-service directories (`backend` Rust, `worker` Python, `web`
React, `mobile` Expo, plus `db`, `infra`, `docs`). One source of truth for the spec, schema,
and CI; independent build/test pipelines per service.

## Consequences
- One PR can change API + UI + migration together, keeping contracts in sync.
- CI runs per-service jobs with path filters.
- Shared types (API contract) are generated from the backend's OpenAPI, not hand-duplicated.
