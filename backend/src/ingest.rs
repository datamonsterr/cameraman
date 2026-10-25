//! Internal endpoints called by the worker (`X-Worker-Token`).

use axum::{extract::State, http::StatusCode, routing::post, Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    camera::{set_status, CameraStatus},
    error::{AppError, AppResult},
    events::{fetch_detail, EventKind},
    extract::WorkerAuth,
    mail::EmailMessage,
    media, AppState, Services,
};

/// A camera reported offline for at least this long raises an `alert` event.
pub const PROLONGED_OFFLINE_SECS: i64 = 300;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/events", post(ingest_event))
        .route("/notifications", post(ingest_notification))
}

#[derive(Deserialize)]
pub struct DetectionIn {
    pub label: String,
    pub confidence: f32,
    #[serde(rename = "box")]
    pub bbox: Value,
}

#[derive(Deserialize)]
pub struct SnapshotIn {
    pub path: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Deserialize)]
pub struct EventIn {
    pub kind: EventKind,
    pub camera_id: Option<Uuid>,
    pub workflow_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub severity: Option<String>,
    pub message: Option<String>,
    pub payload: Option<Value>,
    #[serde(default)]
    pub detections: Vec<DetectionIn>,
    pub snapshot: Option<SnapshotIn>,
    /// Base64 JPEG; stored under `${MEDIA_DIR}/snapshots/` and takes precedence over `snapshot`.
    pub snapshot_jpeg: Option<String>,
}

fn map_fk(e: sqlx::Error) -> AppError {
    if e.as_database_error()
        .is_some_and(|d| d.is_foreign_key_violation())
    {
        return AppError::Unprocessable("referenced camera, workflow or run does not exist".into());
    }
    e.into()
}

async fn ingest_event(
    _w: WorkerAuth,
    State(st): State<AppState>,
    Extension(svc): Extension<Services>,
    Json(req): Json<EventIn>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let severity = req.severity.clone().unwrap_or_else(|| "info".into());
    if !matches!(severity.as_str(), "info" | "warn" | "alert") {
        return Err(AppError::Unprocessable(
            "severity must be info, warn or alert".into(),
        ));
    }
    for d in &req.detections {
        if !(0.0..=1.0).contains(&d.confidence) {
            return Err(AppError::Unprocessable(
                "confidence must be within 0..1".into(),
            ));
        }
    }
    // A health report without camera or state is stored as a plain event.
    let health = match (req.kind, req.camera_id, health_state(req.payload.as_ref())?) {
        (EventKind::Health, Some(cam), Some(state)) => Some((cam, state)),
        _ => None,
    };
    // Write the JPEG first; remove it again if the DB work fails.
    let stored = match &req.snapshot_jpeg {
        Some(b64) => {
            let bytes = media::decode_jpeg(b64)?;
            let sid = Uuid::new_v4();
            let rel = media::save_jpeg(&st.config.media_dir, sid, &bytes).await?;
            Some((sid, rel))
        }
        None => None,
    };
    let id = match store_event(
        &st,
        &req,
        &severity,
        stored.as_ref().map(|(i, p)| (*i, p.as_str())),
    )
    .await
    {
        Ok(id) => id,
        Err(e) => {
            if let Some((_, rel)) = &stored {
                if let Some(full) = media::resolve(&st.config.media_dir, rel) {
                    let _ = tokio::fs::remove_file(full).await;
                }
            }
            return Err(e);
        }
    };
    publish(&st, &svc, id).await;
    if let Some((cam, state)) = health {
        handle_health(&st, &svc, cam, state).await?;
    }
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

async fn publish(st: &AppState, svc: &Services, id: i64) {
    match fetch_detail(&st.pool, id).await {
        Ok(detail) => {
            if let Err(e) = svc.events.publish(&detail).await {
                tracing::warn!(error = %e, event_id = id, "event fan-out failed");
            }
        }
        Err(e) => tracing::warn!(error = %e, event_id = id, "event reload for fan-out failed"),
    }
}

/// Insert the event, detections, snapshot and kind-specific rows atomically.
async fn store_event(
    st: &AppState,
    req: &EventIn,
    severity: &str,
    stored: Option<(Uuid, &str)>,
) -> AppResult<i64> {
    let mut tx = st.pool.begin().await?;
    let snapshot_id: Option<Uuid> = match (stored, &req.snapshot) {
        (Some((sid, rel)), _) => Some(
            sqlx::query_scalar(
                "INSERT INTO snapshots (id, camera_id, path) VALUES ($1, $2, $3) RETURNING id",
            )
            .bind(sid)
            .bind(req.camera_id)
            .bind(rel)
            .fetch_one(&mut *tx)
            .await
            .map_err(map_fk)?,
        ),
        (None, Some(s)) => Some(
            sqlx::query_scalar(
                "INSERT INTO snapshots (camera_id, path, width, height) \
                 VALUES ($1, $2, $3, $4) RETURNING id",
            )
            .bind(req.camera_id)
            .bind(&s.path)
            .bind(s.width)
            .bind(s.height)
            .fetch_one(&mut *tx)
            .await
            .map_err(map_fk)?,
        ),
        (None, None) => None,
    };
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO events (kind, camera_id, workflow_id, run_id, severity, message, payload, snapshot_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(req.kind)
    .bind(req.camera_id)
    .bind(req.workflow_id)
    .bind(req.run_id)
    .bind(severity)
    .bind(&req.message)
    .bind(&req.payload)
    .bind(snapshot_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(map_fk)?;
    for d in &req.detections {
        sqlx::query(
            "INSERT INTO detections (event_id, camera_id, label, confidence, box) \
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(id)
        .bind(req.camera_id)
        .bind(&d.label)
        .bind(d.confidence)
        .bind(&d.bbox)
        .execute(&mut *tx)
        .await?;
    }
    if req.kind == EventKind::Calibration {
        store_calibration(&mut tx, req).await?;
    }
    tx.commit().await?;
    Ok(id)
}

/// `payload{landmark,old_box,new_box,similarity}` -> `landmark_calibrations` row; the
/// landmark's current box follows `new_box` so the next run starts from it.
async fn store_calibration(tx: &mut sqlx::PgConnection, req: &EventIn) -> AppResult<()> {
    let bad = || {
        AppError::Unprocessable(
            "calibration needs camera_id and payload{landmark,old_box,new_box}".into(),
        )
    };
    let cam = req.camera_id.ok_or_else(bad)?;
    let p = req.payload.as_ref().ok_or_else(bad)?;
    let name = p.get("landmark").and_then(Value::as_str).ok_or_else(bad)?;
    let old_box = p.get("old_box").filter(|v| !v.is_null()).ok_or_else(bad)?;
    let new_box = p.get("new_box").filter(|v| !v.is_null()).ok_or_else(bad)?;
    let similarity = p
        .get("similarity")
        .and_then(Value::as_f64)
        .map(|f| f as f32);
    let lid: Uuid =
        sqlx::query_scalar("SELECT id FROM landmarks WHERE camera_id = $1 AND name = $2")
            .bind(cam)
            .bind(name)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| AppError::Unprocessable("landmark not found for camera".into()))?;
    sqlx::query(
        "INSERT INTO landmark_calibrations (landmark_id, old_box, new_box, similarity) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(lid)
    .bind(old_box)
    .bind(new_box)
    .bind(similarity)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE landmarks SET box = $2, updated_at = now() WHERE id = $1")
        .bind(lid)
        .bind(new_box)
        .execute(&mut *tx)
        .await?;
    Ok(())
}

fn health_state(payload: Option<&Value>) -> AppResult<Option<CameraStatus>> {
    match payload.and_then(|p| p.get("state")).and_then(Value::as_str) {
        None => Ok(None),
        Some("online") => Ok(Some(CameraStatus::Online)),
        Some("offline") => Ok(Some(CameraStatus::Offline)),
        Some("error") => Ok(Some(CameraStatus::Error)),
        Some(_) => Err(AppError::Unprocessable(
            "health payload.state must be online, offline or error".into(),
        )),
    }
}

/// Apply a health report: update status + history on change, and raise one `alert`
/// event once a camera has stayed offline for `PROLONGED_OFFLINE_SECS`.
async fn handle_health(
    st: &AppState,
    svc: &Services,
    cam: Uuid,
    state: CameraStatus,
) -> AppResult<()> {
    let cur: CameraStatus = sqlx::query_scalar("SELECT status FROM cameras WHERE id = $1")
        .bind(cam)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("camera not found".into()))?;
    if cur != state {
        set_status(&st.pool, cam, state, None).await?;
    }
    if state != CameraStatus::Offline {
        return Ok(());
    }
    // Start of the current offline stretch = first offline row after the last non-offline one.
    let since: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "SELECT MIN(created_at) FROM camera_status_history WHERE camera_id = $1 \
         AND status = 'offline' AND id > COALESCE((SELECT MAX(id) FROM camera_status_history \
         WHERE camera_id = $1 AND status <> 'offline'), 0)",
    )
    .bind(cam)
    .fetch_one(&st.pool)
    .await?;
    let Some(since) = since else { return Ok(()) };
    if (chrono::Utc::now() - since).num_seconds() < PROLONGED_OFFLINE_SECS {
        return Ok(());
    }
    let already: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM events WHERE camera_id = $1 AND kind = 'health' \
         AND severity = 'alert' AND created_at >= $2)",
    )
    .bind(cam)
    .bind(since)
    .fetch_one(&st.pool)
    .await?;
    if already {
        return Ok(());
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO events (kind, camera_id, severity, message, payload) \
         VALUES ('health', $1, 'alert', $2, $3) RETURNING id",
    )
    .bind(cam)
    .bind(format!(
        "camera offline for over {} minutes",
        PROLONGED_OFFLINE_SECS / 60
    ))
    .bind(json!({"state": "offline", "prolonged": true, "since": since}))
    .fetch_one(&st.pool)
    .await?;
    publish(st, svc, id).await;
    Ok(())
}

#[derive(Deserialize)]
pub struct NotificationIn {
    pub recipients: Vec<String>,
    pub subject: Option<String>,
    pub body: Option<String>,
    pub event_id: Option<i64>,
}

async fn ingest_notification(
    _w: WorkerAuth,
    State(st): State<AppState>,
    Extension(svc): Extension<Services>,
    Json(req): Json<NotificationIn>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let recipients: Vec<String> = req
        .recipients
        .iter()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .collect();
    if recipients.is_empty() || recipients.iter().any(|r| !r.contains('@')) {
        return Err(AppError::Unprocessable(
            "recipients must be a non-empty list of email addresses".into(),
        ));
    }
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO notifications (recipients, subject, body, event_id) \
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(&recipients)
    .bind(&req.subject)
    .bind(&req.body)
    .bind(req.event_id)
    .fetch_one(&st.pool)
    .await
    .map_err(map_fk)?;
    let msg = EmailMessage {
        to: recipients,
        subject: req.subject.unwrap_or_default(),
        body: req.body.unwrap_or_default(),
    };
    let (status, error): (&str, Option<String>) = match svc.mailer.send(&st, &msg).await {
        Ok(()) => ("sent", None),
        Err(e) => {
            tracing::warn!(error = %e, notification = %id, "email send failed");
            ("failed", Some(e))
        }
    };
    sqlx::query(
        "UPDATE notifications SET status = $2::notification_status, error = $3, \
         sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(&error)
    .execute(&st.pool)
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": id, "status": status, "error": error })),
    ))
}
