# Cameraman — Product & Technical Specification

**Status:** Draft v1 · **Owner:** datamonsterr · **Last updated:** 2026-10-25

Cameraman is a self-hostable camera management platform. It discovers IP cameras on
the local network, connects to their RTSP streams, and lets users build visual
automation workflows (n8n-style) whose nodes run computer-vision code against live
video and take actions such as drawing on the stream or sending email. A web UI is
used for full management and configuration; a mobile app is used for monitoring only.

This document is the single source of truth for scope. It is written to be testable:
every functional requirement has an ID (`FR-x`) and acceptance criteria. The Definition
of Done (DoD) in §12 gates release.

---

## 1. Goals & non-goals

### Goals
- Discover cameras on the LAN and connect to them from the UI with one click, showing
  connection progress until the stream is live.
- Let users compose workflows from nodes on a canvas: **Camera**, **Code Block (Python)**,
  **Email Notification**, with an extensible node model for future node types.
- Let users write Python (PyTorch, OpenCV, Ultralytics YOLO, arbitrary libs) in a Code
  Block that receives frames, runs detection/segmentation, and takes actions (draw on the
  stream, send a notification through the workflow, read/calibrate a landmarked area).
- Let users landmark a region for a still (stationary) object and auto-calibrate that
  region's box as the object drifts.
- Provide a web UI (management, configuration, workflow editor, account creation) and a
  mobile UI (monitoring only).
- Ship authenticated, containerized, CI/CD-deployed, with a seeded database.

### Non-goals (v1)
- No multi-tenant billing or org hierarchy beyond a single team with roles.
- No cloud camera onboarding (ONVIF Profile G/T NVR features, two-way audio).
- No horizontal autoscaling of the detection worker beyond a single GPU host.
- Mobile app does **not** configure cameras or edit workflows.

---

## 2. Personas & roles

| Role    | Capabilities |
|---------|--------------|
| `admin` | Everything: manage users, cameras, workflows, system settings. |
| `operator` | Manage cameras and workflows, cannot manage users or system settings. |
| `viewer` | Read-only: view live grid, events, workflow runs. Default for mobile. |

Auth is email + password (Argon2id hashing), JWT access tokens (short-lived) + refresh
tokens (rotating, stored hashed). RBAC enforced server-side on every endpoint. All
privileged actions are written to an append-only audit log.

---

## 3. System architecture

```
┌────────────┐   HTTPS/WS    ┌─────────────────────┐   SQLx    ┌────────────┐
│  Web (React)│◄────────────►│  Backend (Rust/Axum)│◄─────────►│  Postgres  │
└────────────┘               │  REST + WebSocket   │           └────────────┘
┌────────────┐   HTTPS/WS    │  auth, cameras,     │   gRPC/   ┌────────────┐
│ Mobile(Expo)│◄────────────►│  workflows, events  │◄─ Redis ─►│  Worker    │
└────────────┘               └─────────────────────┘  queue    │ (Python)   │
                                      ▲                         │ RTSP+YOLO  │
                                      │ events/frames (WS)      │ +codeblock │
                                      └─────────────────────────┤ sandbox    │
                                                                └────────────┘
                                                                      │ RTSP
                                                                ┌────────────┐
                                                                │ IP cameras │
                                                                └────────────┘
```

**Components**
- **Backend (Rust, Axum):** HTTP/REST + WebSocket API, auth, persistence, camera registry,
  LAN discovery orchestration, workflow CRUD, run supervision, event stream fan-out, email
  dispatch. Owns Postgres. Talks to the worker over a Redis job queue + a control channel.
- **Worker (Python):** owns live video. Pulls RTSP with OpenCV/ffmpeg, decodes frames, runs
  the active workflow graph per camera, executes user Code Block Python in a sandboxed
  subprocess, runs YOLO models, maintains landmark calibration state, produces annotated
  frames, emits events/detections back to the backend, and performs node actions (email via
  backend). GPU-accelerated when available (CUDA), CPU fallback.
- **Web (React + Vite + shadcn/ui):** dark-themed dashboard, collapsible sidebar, camera
  discovery & connect, live grid, workflow editor (React Flow), code editor (Monaco), events,
  settings, account management.
- **Mobile (React Native / Expo):** monitoring only — live camera views, event feed, push
  on alerts. No configuration.
- **Postgres:** system of record. **Redis:** job queue + ephemeral live-frame pub/sub.

---

## 4. Functional requirements

### 4.1 Camera discovery & connection

- **FR-1 LAN scan.** User triggers a scan from the UI. The backend enumerates the host's
  LAN interfaces and discovers candidate cameras by (a) ONVIF WS-Discovery multicast probe,
  (b) a TCP port sweep of common camera ports (554, 8554, 80, 8000, 8080, 8899, 37777), and
  (c) RTSP `OPTIONS`/`DESCRIBE` fingerprinting. Results stream to the UI as they arrive.
  - *Acceptance:* a scan on the operator's LAN returns the two known cameras
    (`192.168.1.38:554`, `192.168.1.164:8554`) within 30 s with vendor/port/paths guessed.
- **FR-2 Connect.** User clicks a discovered camera, supplies credentials if required, and
  connects. The backend validates the RTSP URL (`DESCRIBE` succeeds, stream opens), persists
  the camera, and reports status transitions `discovered → connecting → online` (or `error`
  with a reason) live in the UI until ready.
  - *Acceptance:* clicking connect with valid RTSP credentials moves the camera to `online`
    and a thumbnail/preview appears; invalid credentials surface a clear `401`/auth error.
- **FR-3 Manual add.** User can add a camera by RTSP URL directly (bypassing discovery).
- **FR-4 Health.** Each camera's connection is monitored; drops set status `offline` and
  raise a health event; reconnect is automatic with backoff.

### 4.2 Workflows (visual editor)

- **FR-5 Canvas.** Users compose a directed graph of nodes on a canvas (pan/zoom, drag,
  connect ports), n8n-style. Graphs persist as JSON (nodes + edges + positions).
- **FR-6 Node types (v1).**
  - **Camera node:** source; references a connected camera; outputs frames.
  - **Code Block node:** runs user Python against incoming frames; outputs a result object
    and may emit actions (draw, notify, landmark read/calibrate).
  - **Email Notification node:** sends email (subject/body/recipients, templated from
    upstream node output) via the backend mailer.
- **FR-7 Extensibility.** Node types are described by a registry (schema: inputs, outputs,
  config form). Adding a node type does not require UI rewrites.
- **FR-8 Validation.** The editor rejects invalid graphs (cycles where disallowed, missing
  required config, dangling required inputs) before save/run.
- **FR-9 Run lifecycle.** A workflow can be enabled/disabled. When enabled, the worker runs
  its graph against live frames; runs and their events are recorded and visible.

### 4.3 Code Block runtime

- **FR-10 API surface.** User Python runs with a stable injected API:
  - `frame` — current frame as a numpy array (BGR).
  - `cv2`, `np`, `torch`, `ultralytics` and common libs available.
  - `draw.box/label/mask/text(...)` — annotate the outgoing stream.
  - `notify(subject, body, to=None)` — emit a notification action into the workflow (routed
    to downstream Email nodes, or default recipients).
  - `landmark.get(name)` / `landmark.calibrate(name, box)` — read/update a landmarked region
    (see §4.4); `landmark.contains(name, box)` helper.
  - `state` — a dict persisted across frames for the node (for tracking/debouncing).
  - `emit(key, value)` — pass structured output to downstream nodes.
- **FR-11 Sandbox.** User code runs in an isolated subprocess with CPU/time/memory limits and
  no outbound network except through provided APIs. Crashes are contained and surfaced as run
  errors; they never take down the worker. (Threat model & limits in ADR-0007.)
- **FR-12 Models.** YOLO weights (e.g. `yolov8n.pt`, `yolov8s.pt`) are bundled/cached and
  loadable from user code; the worker provides a model cache so repeated loads are cheap.

### 4.4 Still-object landmark & auto-calibration

- **FR-13 Landmark.** In the UI the user draws a named region (polygon/rect) on a camera's
  frame to mark where a still object sits. Stored per camera.
- **FR-14 Auto-calibrate.** The worker tracks the landmarked object; when the object's
  detected box drifts beyond a threshold but is still the same object (IoU/appearance match),
  the landmark box is moved to re-center on it automatically. Calibration history is kept.
  - *Acceptance:* with a tracked still object physically nudged within frame, the stored
    landmark box follows it without user action, and the change is visible in the UI.
- **FR-15 Codeblock access.** `landmark.get(name)` returns the current (possibly
  auto-calibrated) box; code can gate logic on it (e.g. "object left its spot").

### 4.5 Notifications

- **FR-16 Email.** The Email node and `notify(...)` send email via SMTP configured in system
  settings. Delivery is recorded (queued/sent/failed) and visible in events.

### 4.6 Web UI

- **FR-17** Account creation, login, logout, password change; session management.
- **FR-18** Dashboard: live multi-camera grid, system health, recent events.
- **FR-19** Cameras: discovery, connect, add, edit, delete, per-camera live view + landmarks.
- **FR-20** Workflows: list, create, edit (canvas + code editor), enable/disable, run history.
- **FR-21** Events: filterable timeline of detections/notifications/health with snapshots.
- **FR-22** Settings: SMTP, users/roles (admin), model management, audit log.
- **FR-23 Design:** shadcn/ui components, **dark theme mandatory**, collapsible sidebar,
  compact and modern. Built under the `design-taste-frontend` house style.

### 4.7 Mobile UI (monitor only)

- **FR-24** Login (viewer by default), live camera grid + single view, event feed, push
  notifications on alerts. No create/edit/delete of cameras or workflows.

---

## 5. Chosen "other" features (5)

Selected from common camera-management products, scoped into v1:

1. **Live multi-camera grid** with adaptive layout (1/4/9/16) and per-tile status.
2. **Event timeline with snapshots** — motion/detection/health events, thumbnailed, filterable.
3. **Clip recording & retention** — on-event short clip capture with a retention policy
   (size/age based pruning).
4. **RBAC + audit log** — admin/operator/viewer roles and an append-only audit trail.
5. **Camera health monitoring & uptime alerts** — heartbeat, offline detection, uptime %,
   email/push alert on prolonged outage.

---

## 6. Data model (overview)

Authoritative DDL lives in `db/migrations`. Core tables:

`users`, `refresh_tokens`, `cameras`, `camera_status_history`, `landmarks`,
`workflows`, `workflow_versions`, `workflow_runs`, `nodes`/`edges` (or `graph` JSONB on
version), `events`, `detections`, `clips`, `snapshots`, `notifications`, `smtp_settings`,
`models`, `audit_log`. See ADR-0003 for the schema rationale.

---

## 7. API (overview)

REST under `/api/v1`, JSON, bearer auth. WebSocket under `/api/v1/ws` for live events and
per-camera frame preview. Representative endpoints:

```
POST   /auth/register            POST /auth/login     POST /auth/refresh   POST /auth/logout
GET    /cameras                  POST /cameras        GET  /cameras/:id    PATCH /cameras/:id
POST   /cameras/scan             POST /cameras/:id/connect
GET    /cameras/:id/snapshot     WS   /cameras/:id/stream
GET    /landmarks?camera=:id     POST /landmarks      PATCH /landmarks/:id
GET    /workflows                POST /workflows      GET  /workflows/:id  PATCH /workflows/:id
POST   /workflows/:id/enable     POST /workflows/:id/disable
GET    /workflows/:id/runs       GET  /events         GET  /events/:id
GET    /users (admin)            POST /users (admin)  GET  /audit (admin)
GET    /settings/smtp (admin)    PUT  /settings/smtp (admin)
WS     /ws/events
```

Full OpenAPI generated from the backend and published in `docs/api`.

---

## 8. Non-functional requirements

- **Security:** Argon2id passwords; JWT with rotation; RBAC on every route; sandboxed code
  execution; secrets via env/secret store, never committed; TLS in production.
- **Performance:** discovery scan ≤ 30 s on a /24; detection ≥ 10 FPS per camera at 720p on
  the GPX host (GTX 1060 baseline), graceful degradation on CPU.
- **Reliability:** camera auto-reconnect; worker crash isolation for user code; at-least-once
  event delivery.
- **Observability:** structured logs, `/health` + `/metrics`, run/event audit trails.
- **Portability:** everything runs via `docker compose up`; GPU optional.

---

## 9. Tech stack

- **Backend:** Rust, Axum, Tokio, SQLx (Postgres), `jsonwebtoken`, `argon2`, `lettre` (SMTP),
  `tracing`. **Worker:** Python 3.12, OpenCV, PyTorch, Ultralytics, `redis`, `pydantic`.
- **Web:** React + Vite + TypeScript, shadcn/ui + Tailwind, React Flow, Monaco, TanStack Query,
  Zustand. **Mobile:** Expo (React Native) + expo-router, expo-video, expo-notifications.
- **DB:** Postgres 16. **Queue/pubsub:** Redis 7.
- **Infra:** Docker + docker compose; CI/CD via GitHub Actions; deploy targets Railway
  (backend/worker/db), Vercel (web), EAS (mobile).

---

## 10. Testing strategy (TDD)

- **Backend:** unit tests per module; integration tests against an ephemeral Postgres
  (testcontainers / `sqlx::test`); API contract tests. Seams agreed per feature before tests.
- **Worker:** unit tests for graph execution, landmark calibration math, sandbox limits; the
  RTSP/model boundaries are mocked (recorded frames / fake model) so tests are deterministic.
- **Web/Mobile:** component tests (Vitest + Testing Library), E2E happy paths (Playwright web).
- **CI gate:** lint + typecheck + unit + integration must pass before merge; E2E + deploy on
  main. No feature is "done" until its FR acceptance criteria have an automated test.

---

## 11. Milestones

1. **M0 Foundation:** repo, docs, CI skeleton, docker compose, DB migrations + seed. 
2. **M1 Auth & cameras:** auth/RBAC, camera CRUD, discovery, connect, live preview.
3. **M2 Workflows core:** node registry, editor, persistence, run supervision, email node.
4. **M3 Code Block + vision:** sandbox, injected API, YOLO, landmark + auto-calibrate.
5. **M4 UX polish:** taste pass on web, mobile monitor app, events/clips/health features.
6. **M5 Deploy & DoD:** deploy infra, seed, connect the two real cameras, 2 example workflows.

---

## 12. Definition of Done

Release is done only when all hold:

1. Every FR in §4 is implemented and covered by passing automated tests.
2. CI/CD builds, tests, and deploys all services; failures block merge/deploy.
3. Infrastructure is deployed with the DB schema migrated and seeded with mock data.
4. All services containerized; `docker compose up` brings the full stack up locally.
5. The two LAN cameras are scanned and connected through the UI over RTSP.
6. Two example workflows exist using YOLO: **human detection** and **human detection near a
   door**, each emailing `phamdat17092004@gmail.com`.
7. A still-object landmark box auto-calibrates (moves) without user action.
8. Web UI meets the design bar (shadcn, dark, collapsible sidebar, compact/modern, taste pass).
9. Mobile app monitors (live + events + push), with no configuration surface.
