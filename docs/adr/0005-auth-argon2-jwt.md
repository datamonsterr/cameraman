# ADR-0005: Argon2id + JWT with refresh rotation; server-side RBAC

**Status:** Accepted · **Date:** 2026-10-25

## Context
The system is authenticated and multi-role. Mobile and web both need sessions; privileged
actions must be gated and audited.

## Decision
- Passwords hashed with Argon2id.
- Short-lived JWT access tokens (15 min) signed with `JWT_SECRET`; rotating refresh tokens
  (30 d) stored **hashed** in `refresh_tokens`, revocable per device.
- RBAC (`admin`/`operator`/`viewer`) enforced in an Axum middleware/extractor on every route;
  never trusted from the client.
- All privileged mutations append to `audit_log`.

## Consequences
- Stolen access token expires fast; refresh tokens are revocable and rotate on use.
- Mobile gets `viewer` by default and cannot reach mutating endpoints.
- Audit trail satisfies the RBAC "other feature" and aids debugging.
