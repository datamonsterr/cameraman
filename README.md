# Cameraman

Self-hostable camera management platform: discover IP cameras on your LAN, connect to their
RTSP streams, and build n8n-style visual workflows whose nodes run computer-vision Python
(PyTorch / OpenCV / YOLO) against live video to detect objects and take actions — draw on the
stream, send email, track landmarked areas. Full management from a dark-themed web app;
monitoring from an Expo mobile app.

> Status: **in active construction.** See [`SPEC.md`](SPEC.md) for scope and the Definition of
> Done, [`AGENTS.md`](AGENTS.md) for how the repo is built, and [`docs/adr`](docs/adr) for
> architecture decisions.

## Quick start

```bash
cp .env.example .env     # fill in secrets
docker compose up        # postgres, redis, backend, worker, web
```

Web UI: http://localhost:5173 · API: http://localhost:8080/api/v1

## Layout

| Dir | What |
|-----|------|
| `backend/` | Rust (Axum) API + WebSocket, auth, persistence, discovery, workflow supervision |
| `worker/`  | Python detection worker: RTSP, YOLO, Code Block sandbox, landmark calibration |
| `web/`     | React + Vite + shadcn/ui web app (full management) |
| `mobile/`  | Expo (React Native) monitor-only app |
| `db/`      | SQL migrations + seed data |
| `infra/`   | Dockerfiles, docker-compose, deploy config |
| `docs/`    | Spec, ADRs, API docs |

## Features

Camera discovery & one-click connect · visual workflow editor · Python Code Block vision
runtime · still-object landmark auto-calibration · email notifications · live multi-camera
grid · event timeline with snapshots · clip recording + retention · RBAC + audit log · camera
health monitoring & uptime alerts.

## License

MIT — see [`LICENSE`](LICENSE).
