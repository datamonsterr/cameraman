# Runtime protocol: backend ↔ worker (Redis + HTTP)

Defines the contract between the Rust backend and the Python worker for running workflows,
streaming live frames, and ingesting results. Both sides implement to THIS document so the
pieces interlock. (See ADR-0002 split, ADR-0004 Redis.)

## Transports

- **Redis** carries transient realtime traffic and run control.
- **HTTP** (`/api/v1/ingest/*`, authenticated by `X-Worker-Token`) carries durable writes
  (events, detections, notifications, snapshots). The backend is the only Postgres writer.

## Run control — Redis list `cameraman:runs:control`

Backend `LPUSH`es a JSON command; the worker `BRPOP`s and reconciles its running set.

```jsonc
// start (or update) a workflow run
{
  "action": "start",              // "start" | "stop" | "update"
  "run_id": "<uuid>",
  "workflow_id": "<uuid>",
  "version_id": "<uuid>",
  "graph": { "nodes": [...], "edges": [...] },   // the active version graph
  "cameras": [                     // every camera referenced by a camera node
    {
      "id": "<uuid>",
      "name": "front door",
      "rtsp_url": "rtsp://user:pass@host:port/path",  // backend decrypts creds
      "transport": "tcp",
      "fps": 10
    }
  ],
  "landmarks": [                   // landmarks for the cameras in this run
    { "name": "door", "camera_id": "<uuid>", "box": [x,y,w,h],
      "drift_threshold": 0.02, "similarity_threshold": 0.7 }
  ]
}
// stop: { "action": "stop", "run_id": "<uuid>" }
```

- On `start`/`update` the worker (re)builds the run: opens each camera's RTSP capture, loads
  the graph into a `GraphEngine`, and begins the per-frame loop.
- On `stop` the worker tears the run down.
- `rtsp_url` includes decrypted credentials. This travels only over the local/private Redis;
  do not log it. (Hardening: a short-lived fetch token instead — future.)
- The backend also writes the current desired state to `cameraman:runs:desired` (a hash
  `run_id → command`) so a freshly started worker can resync via `HGETALL` on boot.

## Live frames — Redis pub/sub

- Channel `cameraman:camera:<camera_id>:frames`: the worker `PUBLISH`es annotated preview
  frames as JPEG bytes (target ≤ 5 fps, ≤ ~100 kB each) for live preview.
- Key `cameraman:camera:<camera_id>:latest`: the worker `SET`s the most recent JPEG (with a
  short TTL, e.g. 30s) so the snapshot endpoint can serve a still without a subscription.
- Backend `GET /api/v1/cameras/:id/snapshot` returns `cameraman:camera:<id>:latest` as
  `image/jpeg`; 404 (or a placeholder) when absent.
- Backend WS `GET /api/v1/cameras/:id/stream` (auth) `SUBSCRIBE`s the frames channel and
  forwards binary frames to the client.

## Events — HTTP ingest + Redis fan-out

- The worker `POST`s results to `POST /api/v1/ingest/events` and
  `POST /api/v1/ingest/notifications` (see backend SPEC §7 / ingest). The backend writes
  Postgres rows, then `PUBLISH`es a compact JSON event to channel `cameraman:events`.
- Backend WS `GET /api/v1/ws/events` (auth) `SUBSCRIBE`s `cameraman:events` and forwards to
  clients. Mobile/web event feeds use the REST `GET /events` for history and this WS for live.

## Calibration events

When a landmark auto-calibrates, the worker `POST`s an ingest event
`{ "kind": "calibration", "camera_id", "payload": { "landmark": "door", "old_box", "new_box",
"similarity" } }`. The backend records it in `events` + `landmark_calibrations` (via an ingest
handler) so the UI can show the box moving.

## Health & heartbeats

- The worker `SET`s `cameraman:worker:<id>:heartbeat` periodically; the backend's camera
  health monitor reads capture state the worker reports via `POST /ingest/events`
  `{kind:"health", camera_id, payload:{state:"online|offline", ...}}` and updates
  `cameras.status` + history, raising an alert event on prolonged outage.

## Idempotency & ordering

- Control commands are keyed by `run_id`; the worker treats `start` for a known `run_id` as
  `update`. `stop` for an unknown `run_id` is a no-op.
- Ingest calls include a client-generated `dedup_key` where at-least-once could duplicate
  (e.g. a notification); the backend upserts on it.
