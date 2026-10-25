//! Internal endpoints called by the worker (`X-Worker-Token`).

use axum::{extract::State, http::StatusCode, routing::post, Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    events::{fetch_detail, EventKind},
    extract::WorkerAuth,
    mail::EmailMessage,
    AppState, Services,
};

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
    let severity = req.severity.unwrap_or_else(|| "info".into());
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
    let mut tx = st.pool.begin().await?;
    let snapshot_id: Option<Uuid> = match &req.snapshot {
        Some(s) => Some(
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
        None => None,
    };
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO events (kind, camera_id, workflow_id, run_id, severity, message, payload, snapshot_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(req.kind)
    .bind(req.camera_id)
    .bind(req.workflow_id)
    .bind(req.run_id)
    .bind(&severity)
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
    tx.commit().await?;
    let detail = fetch_detail(&st.pool, id).await?;
    if let Err(e) = svc.events.publish(&detail).await {
        tracing::warn!(error = %e, event_id = id, "event fan-out failed");
    }
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
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
