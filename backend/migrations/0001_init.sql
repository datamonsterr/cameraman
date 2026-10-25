-- Cameraman initial schema (SPEC §6). Postgres 16.
-- Idempotent-ish: uses IF NOT EXISTS where practical. Applied by sqlx migrate.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Auth & users
-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('admin', 'operator', 'viewer');

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,                 -- Argon2id PHC string
    role          user_role NOT NULL DEFAULT 'viewer',
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,            -- sha256 of the opaque token
    device_label TEXT,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ---------------------------------------------------------------------------
-- Cameras
-- ---------------------------------------------------------------------------
CREATE TYPE camera_status AS ENUM ('discovered','connecting','online','offline','error');

CREATE TABLE cameras (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    vendor        TEXT,
    host          INET NOT NULL,
    port          INTEGER NOT NULL DEFAULT 554,
    rtsp_path     TEXT NOT NULL DEFAULT '/',
    rtsp_username TEXT,
    -- credentials stored encrypted at rest (app-level); never plaintext in dumps
    rtsp_secret_enc BYTEA,
    transport     TEXT NOT NULL DEFAULT 'tcp',   -- tcp|udp
    status        camera_status NOT NULL DEFAULT 'discovered',
    status_reason TEXT,
    last_seen_at  TIMESTAMPTZ,
    width         INTEGER,
    height        INTEGER,
    codec         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (host, port, rtsp_path)
);
CREATE INDEX idx_cameras_status ON cameras(status);

CREATE TABLE camera_status_history (
    id         BIGSERIAL PRIMARY KEY,
    camera_id  UUID NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    status     camera_status NOT NULL,
    reason     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_camera_status_history_cam ON camera_status_history(camera_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Landmarks (still-object regions + auto-calibration)
-- ---------------------------------------------------------------------------
CREATE TABLE landmarks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id       UUID NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    -- box: {x,y,w,h} in normalized [0,1]; polygon optional
    box             JSONB NOT NULL,
    polygon         JSONB,
    reference_descriptor JSONB,                   -- appearance template/embedding
    drift_threshold REAL NOT NULL DEFAULT 0.15,
    similarity_threshold REAL NOT NULL DEFAULT 0.6,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (camera_id, name)
);

CREATE TABLE landmark_calibrations (
    id          BIGSERIAL PRIMARY KEY,
    landmark_id UUID NOT NULL REFERENCES landmarks(id) ON DELETE CASCADE,
    old_box     JSONB NOT NULL,
    new_box     JSONB NOT NULL,
    similarity  REAL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_landmark_calib ON landmark_calibrations(landmark_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Workflows (graph stored as JSONB per immutable version; ADR-0003)
-- ---------------------------------------------------------------------------
CREATE TABLE workflows (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL,
    description       TEXT,
    enabled           BOOLEAN NOT NULL DEFAULT FALSE,
    active_version_id UUID,                        -- FK added after versions table
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_versions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    graph       JSONB NOT NULL,                    -- {nodes:[], edges:[]}
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workflow_id, version)
);

ALTER TABLE workflows
    ADD CONSTRAINT fk_active_version
    FOREIGN KEY (active_version_id) REFERENCES workflow_versions(id) ON DELETE SET NULL;

CREATE TYPE run_status AS ENUM ('starting','running','stopped','error');

CREATE TABLE workflow_runs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    version_id  UUID NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
    status      run_status NOT NULL DEFAULT 'starting',
    error       TEXT,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at  TIMESTAMPTZ
);
CREATE INDEX idx_workflow_runs_wf ON workflow_runs(workflow_id, started_at DESC);

-- Node type registry (ADR-0006). Seeded; drives editor + worker.
CREATE TABLE node_types (
    id          TEXT PRIMARY KEY,                  -- 'camera','codeblock','email'
    category    TEXT NOT NULL,
    title       TEXT NOT NULL,
    descriptor  JSONB NOT NULL,                    -- inputs/outputs/config schema
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Events, detections, media
-- ---------------------------------------------------------------------------
CREATE TYPE event_kind AS ENUM
    ('detection','notification','health','calibration','clip','system');

CREATE TABLE events (
    id          BIGSERIAL PRIMARY KEY,
    kind        event_kind NOT NULL,
    camera_id   UUID REFERENCES cameras(id) ON DELETE SET NULL,
    workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL,
    run_id      UUID REFERENCES workflow_runs(id) ON DELETE SET NULL,
    severity    TEXT NOT NULL DEFAULT 'info',      -- info|warn|alert
    message     TEXT,
    payload     JSONB,
    snapshot_id UUID,                              -- FK added after snapshots
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_time ON events(created_at DESC);
CREATE INDEX idx_events_camera ON events(camera_id, created_at DESC);
CREATE INDEX idx_events_kind ON events(kind, created_at DESC);

CREATE TABLE detections (
    id          BIGSERIAL PRIMARY KEY,
    event_id    BIGINT REFERENCES events(id) ON DELETE CASCADE,
    camera_id   UUID REFERENCES cameras(id) ON DELETE SET NULL,
    label       TEXT NOT NULL,
    confidence  REAL NOT NULL,
    box         JSONB NOT NULL,                    -- {x,y,w,h} normalized
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_detections_cam ON detections(camera_id, created_at DESC);

CREATE TABLE snapshots (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id  UUID REFERENCES cameras(id) ON DELETE SET NULL,
    path       TEXT NOT NULL,                      -- object-store key / fs path
    width      INTEGER,
    height     INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE events
    ADD CONSTRAINT fk_event_snapshot
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE SET NULL;

CREATE TABLE clips (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id   UUID REFERENCES cameras(id) ON DELETE SET NULL,
    event_id    BIGINT REFERENCES events(id) ON DELETE SET NULL,
    path        TEXT NOT NULL,
    duration_ms INTEGER,
    size_bytes  BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_clips_time ON clips(created_at DESC);

-- ---------------------------------------------------------------------------
-- Notifications & settings
-- ---------------------------------------------------------------------------
CREATE TYPE notification_status AS ENUM ('queued','sent','failed');

CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel     TEXT NOT NULL DEFAULT 'email',
    recipients  TEXT[] NOT NULL,
    subject     TEXT,
    body        TEXT,
    status      notification_status NOT NULL DEFAULT 'queued',
    error       TEXT,
    event_id    BIGINT REFERENCES events(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at     TIMESTAMPTZ
);

CREATE TABLE smtp_settings (
    id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton row
    host       TEXT NOT NULL,
    port       INTEGER NOT NULL DEFAULT 587,
    username   TEXT,
    secret_enc BYTEA,
    from_addr  TEXT NOT NULL,
    use_tls    BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE models (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,              -- 'yolov8n'
    task        TEXT NOT NULL,                     -- detect|segment|pose
    path        TEXT NOT NULL,                     -- cache path / url
    classes     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Audit log (append-only; RBAC feature)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
    id         BIGSERIAL PRIMARY KEY,
    actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,                      -- 'camera.create', etc.
    target     TEXT,
    detail     JSONB,
    ip         INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_time ON audit_log(created_at DESC);
