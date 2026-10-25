use std::sync::Mutex;

use async_trait::async_trait;
use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    extract::AuthUser,
    AppState,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "event_kind", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Detection,
    Notification,
    Health,
    Calibration,
    Clip,
    System,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Event {
    pub id: i64,
    pub kind: EventKind,
    pub camera_id: Option<Uuid>,
    pub workflow_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub severity: String,
    pub message: Option<String>,
    pub payload: Option<Value>,
    pub snapshot_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Detection {
    pub id: i64,
    pub label: String,
    pub confidence: f32,
    #[sqlx(rename = "box")]
    #[serde(rename = "box")]
    pub bbox: Value,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Snapshot {
    pub id: Uuid,
    pub path: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

/// An event with its detections and snapshot reference.
#[derive(Debug, Clone, Serialize)]
pub struct EventDetail {
    #[serde(flatten)]
    pub event: Event,
    pub detections: Vec<Detection>,
    pub snapshot: Option<Snapshot>,
}

/// Fan-out seam for freshly ingested events (Redis/WebSocket later).
#[async_trait]
pub trait EventSink: Send + Sync {
    async fn publish(&self, event: &EventDetail) -> Result<(), String>;
}

/// Real default for now: log only.
#[derive(Debug, Default)]
pub struct LogEventSink;

#[async_trait]
impl EventSink for LogEventSink {
    async fn publish(&self, event: &EventDetail) -> Result<(), String> {
        tracing::info!(id = event.event.id, kind = ?event.event.kind, "event (no fan-out wired yet)");
        Ok(())
    }
}

/// Test double recording every published event.
#[derive(Debug, Default)]
pub struct FakeEventSink {
    pub published: Mutex<Vec<EventDetail>>,
}

impl FakeEventSink {
    pub fn recorded(&self) -> Vec<EventDetail> {
        self.published.lock().unwrap().clone()
    }
}

#[async_trait]
impl EventSink for FakeEventSink {
    async fn publish(&self, event: &EventDetail) -> Result<(), String> {
        self.published.lock().unwrap().push(event.clone());
        Ok(())
    }
}

pub const EVENT_COLS: &str =
    "id, kind, camera_id, workflow_id, run_id, severity, message, payload, snapshot_id, created_at";

/// Load an event with detections + snapshot.
pub async fn fetch_detail(pool: &PgPool, id: i64) -> AppResult<EventDetail> {
    let event: Event = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {EVENT_COLS} FROM events WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("event not found".into()))?;
    let detections = sqlx::query_as(
        "SELECT id, label, confidence, box FROM detections WHERE event_id = $1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    let snapshot = match event.snapshot_id {
        Some(sid) => {
            sqlx::query_as("SELECT id, path, width, height FROM snapshots WHERE id = $1")
                .bind(sid)
                .fetch_optional(pool)
                .await?
        }
        None => None,
    };
    Ok(EventDetail {
        event,
        detections,
        snapshot,
    })
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list))
        .route("/{id}", get(get_one))
}

#[derive(Deserialize)]
struct ListQuery {
    kind: Option<EventKind>,
    camera_id: Option<Uuid>,
    severity: Option<String>,
    since: Option<DateTime<Utc>>,
    limit: Option<i64>,
}

async fn list(
    _u: AuthUser,
    State(st): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<Event>>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let rows = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {EVENT_COLS} FROM events \
         WHERE ($1::event_kind IS NULL OR kind = $1) \
           AND ($2::uuid IS NULL OR camera_id = $2) \
           AND ($3::text IS NULL OR severity = $3) \
           AND ($4::timestamptz IS NULL OR created_at >= $4) \
         ORDER BY created_at DESC, id DESC LIMIT $5"
    )))
    .bind(q.kind)
    .bind(q.camera_id)
    .bind(q.severity)
    .bind(q.since)
    .bind(limit)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(rows))
}

async fn get_one(
    _u: AuthUser,
    State(st): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<EventDetail>> {
    Ok(Json(fetch_detail(&st.pool, id).await?))
}
