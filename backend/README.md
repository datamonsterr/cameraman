# Cameraman backend

Rust / Axum API. Scope so far: foundation, auth (Argon2id + JWT + rotating refresh), RBAC, audit log.

## Run

    export DATABASE_URL=postgres://postgres:pw@localhost:5544/cameraman
    export JWT_SECRET=$(openssl rand -hex 32)
    SEED_ON_START=true ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=change-me-now cargo run

Migrations (`migrations/`, copied byte-identical from `../db/migrations`) run on startup.

## Test

    docker run -d --name cm-be-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=cameraman -p 5544:5432 postgres:16-alpine
    export DATABASE_URL=postgres://postgres:pw@localhost:5544/cameraman
    cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --all
    docker rm -f cm-be-pg   # cleanup

Integration tests use `#[sqlx::test]`: each test gets its own fresh database (migrations applied),
so they are independent. The DB role must be able to `CREATE DATABASE` and `CREATE EXTENSION pgcrypto`.
Queries are runtime-checked (no `query!` macros), so no `.sqlx` offline data / `SQLX_OFFLINE` is needed.

## Environment

| Var | Default | Notes |
|-----|---------|-------|
| `BACKEND_BIND` | `0.0.0.0:8080` | listen address |
| `DATABASE_URL` | required | Postgres |
| `REDIS_URL` | `redis://localhost:6379` | unused yet |
| `JWT_SECRET` | required | HS256 key |
| `ACCESS_TOKEN_TTL_SECS` | `900` | |
| `REFRESH_TOKEN_TTL_SECS` | `2592000` | |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | unset | used when seeding |
| `SEED_ON_START` | `false` | ensure admin exists (idempotent) |
| `CORS_ORIGINS` | `*` | comma-separated origins or `*` |
| `RUST_LOG` | `info` | |

## API (`/api/v1`)

`GET /health` (also `/health`), `POST /auth/{register,login,refresh,logout}`,
`GET /me` (any auth), `GET /audit?limit=` (admin). First registered user becomes `admin`.
Errors: `{"error": "<code>", "message": "..."}`.
