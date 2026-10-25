# ADR-0006: Single node registry drives editor and execution

**Status:** Accepted · **Date:** 2026-10-25

## Context
Node types must appear in the visual editor (config forms, ports) and be executed by the
worker. Duplicating definitions in TS and Python would drift.

## Decision
Define each node type once as a JSON Schema descriptor (`id`, `inputs`, `outputs`,
`config` schema, `category`). The descriptors live in `db` seed + a shared `node-registry`
JSON published to both web (to render forms/ports and validate) and worker (to dispatch
execution). Adding a node type = add a descriptor + a worker executor + optional web renderer.

## Consequences
- Editor and worker agree on node contracts by construction.
- FR-7 extensibility: new node types need no editor rewrite.
- Validation (FR-8) is schema-driven on both ends.
