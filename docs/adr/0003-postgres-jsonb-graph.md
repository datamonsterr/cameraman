# ADR-0003: Postgres as system of record; workflow graph as JSONB

**Status:** Accepted · **Date:** 2026-10-25

## Context
Workflows are graphs edited frequently in a visual editor and versioned. Relational data
(users, cameras, events) needs integrity and queryability.

## Decision
Postgres 16 is the system of record. Normalized tables for users, cameras, events, clips,
etc. The workflow **graph** (nodes + edges + positions + config) is stored as a `JSONB`
`graph` column on an immutable `workflow_versions` row; the active version is referenced by
`workflows.active_version_id`. Events/detections reference the version that produced them.

## Consequences
- Editing a workflow creates a new version (cheap, auditable, rollback-friendly).
- Graph shape can evolve without migrations; node configs validated against the node registry.
- Cross-cutting queries (events by camera/time) stay relational and indexed.
