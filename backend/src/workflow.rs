use std::sync::Mutex;

use async_trait::async_trait;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Extension, Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    audit::audit_soft,
    error::{AppError, AppResult},
    extract::{AuthUser, OperatorUser},
    registry::{self, check_graph},
    AppState, Services,
};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Workflow {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub active_version_id: Option<Uuid>,
    pub active_version: Option<i32>,
    /// Active version's graph (detail view only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph: Option<Value>,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct WorkflowVersion {
    pub id: Uuid,
    pub workflow_id: Uuid,
    pub version: i32,
    pub graph: Value,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "run_status", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Starting,
    Running,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct WorkflowRun {
    pub id: Uuid,
    pub workflow_id: Uuid,
    pub version_id: Uuid,
    pub status: RunStatus,
    pub error: Option<String>,
    pub started_at: DateTime<Utc>,
    pub stopped_at: Option<DateTime<Utc>>,
}

// ------------------------------------------------------------- run control

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunAction {
    Start,
    Stop,
    /// Re-send a changed graph for an already open run.
    Update,
}

/// Signal telling the worker to start/stop a workflow run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunSignal {
    pub action: RunAction,
    pub workflow_id: Uuid,
    pub run_id: Option<Uuid>,
    pub version_id: Option<Uuid>,
}

/// Seam for the worker control channel (`runctl::RedisRunControl` is the real impl).
#[async_trait]
pub trait RunControl: Send + Sync {
    async fn signal(&self, sig: RunSignal) -> Result<(), String>;
}

/// No-op fallback when Redis is not configured: log only.
#[derive(Debug, Default)]
pub struct LogRunControl;

#[async_trait]
impl RunControl for LogRunControl {
    async fn signal(&self, sig: RunSignal) -> Result<(), String> {
        tracing::info!(?sig, "run control signal (no transport wired yet)");
        Ok(())
    }
}

/// Test double recording every signal.
#[derive(Debug, Default)]
pub struct FakeRunControl {
    pub signals: Mutex<Vec<RunSignal>>,
}

impl FakeRunControl {
    pub fn recorded(&self) -> Vec<RunSignal> {
        self.signals.lock().unwrap().clone()
    }
}

#[async_trait]
impl RunControl for FakeRunControl {
    async fn signal(&self, sig: RunSignal) -> Result<(), String> {
        self.signals.lock().unwrap().push(sig);
        Ok(())
    }
}

// ------------------------------------------------------------------ routes

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", get(get_one).patch(update))
        .route("/{id}/versions", get(versions))
        .route("/{id}/enable", post(enable))
        .route("/{id}/disable", post(disable))
        .route("/{id}/runs", get(runs))
}

const SELECT: &str = "SELECT w.id, w.name, w.description, w.enabled, w.active_version_id, \
    v.version AS active_version, GRAPH AS graph, w.created_by, w.created_at, w.updated_at \
    FROM workflows w LEFT JOIN workflow_versions v ON v.id = w.active_version_id";

async fn fetch(pool: &PgPool, id: Uuid) -> AppResult<Workflow> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{} WHERE w.id = $1",
        SELECT.replace("GRAPH", "v.graph")
    )))
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("workflow not found".into()))
}

fn validate_name(n: &str) -> AppResult<String> {
    let n = n.trim();
    if n.is_empty() {
        Err(AppError::Unprocessable("name is required".into()))
    } else {
        Ok(n.to_string())
    }
}

async fn list(_u: AuthUser, State(st): State<AppState>) -> AppResult<Json<Vec<Workflow>>> {
    let rows = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{} ORDER BY w.created_at DESC, w.id",
        SELECT.replace("GRAPH", "NULL::jsonb")
    )))
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(rows))
}

async fn get_one(
    _u: AuthUser,
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Workflow>> {
    Ok(Json(fetch(&st.pool, id).await?))
}

async fn versions(
    _u: AuthUser,
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Vec<WorkflowVersion>>> {
    fetch(&st.pool, id).await?;
    let rows = sqlx::query_as(
        "SELECT id, workflow_id, version, graph, created_by, created_at \
         FROM workflow_versions WHERE workflow_id = $1 ORDER BY version DESC",
    )
    .bind(id)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(rows))
}

/// Insert the next immutable version and make it the active one.
async fn add_version(
    tx: &mut sqlx::PgConnection,
    workflow_id: Uuid,
    graph: &Value,
    actor: Uuid,
) -> AppResult<Uuid> {
    let vid: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_versions (workflow_id, version, graph, created_by) \
         VALUES ($1, COALESCE((SELECT MAX(version) FROM workflow_versions WHERE workflow_id = $1), 0) + 1, $2, $3) \
         RETURNING id",
    )
    .bind(workflow_id)
    .bind(graph)
    .bind(actor)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE workflows SET active_version_id = $2, updated_at = now() WHERE id = $1")
        .bind(workflow_id)
        .bind(vid)
        .execute(&mut *tx)
        .await?;
    Ok(vid)
}

#[derive(Deserialize)]
pub struct CreateReq {
    pub name: String,
    pub description: Option<String>,
    pub graph: Value,
}

async fn create(
    OperatorUser(actor): OperatorUser,
    State(st): State<AppState>,
    Json(req): Json<CreateReq>,
) -> AppResult<(StatusCode, Json<Workflow>)> {
    let name = validate_name(&req.name)?;
    check_graph(&req.graph, registry::embedded())?;
    let mut tx = st.pool.begin().await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO workflows (name, description, created_by) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(&name)
    .bind(req.description.filter(|d| !d.is_empty()))
    .bind(actor.id)
    .fetch_one(&mut *tx)
    .await?;
    add_version(&mut tx, id, &req.graph, actor.id).await?;
    tx.commit().await?;
    audit_soft(
        &st.pool,
        Some(actor.id),
        "workflow.create",
        Some(&id.to_string()),
        Some(json!({"name": name})),
    )
    .await;
    Ok((StatusCode::CREATED, Json(fetch(&st.pool, id).await?)))
}

#[derive(Deserialize)]
pub struct UpdateReq {
    pub name: Option<String>,
    /// Empty string clears.
    pub description: Option<String>,
    pub graph: Option<Value>,
}

async fn update(
    OperatorUser(actor): OperatorUser,
    State(st): State<AppState>,
    Extension(svc): Extension<Services>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateReq>,
) -> AppResult<Json<Workflow>> {
    let cur = fetch(&st.pool, id).await?;
    let name = validate_name(req.name.as_deref().unwrap_or(&cur.name))?;
    let description = match req.description {
        Some(d) => Some(d).filter(|d| !d.is_empty()),
        None => cur.description.clone(),
    };
    if let Some(g) = &req.graph {
        check_graph(g, registry::embedded())?;
    }
    let mut tx = st.pool.begin().await?;
    sqlx::query(
        "UPDATE workflows SET name = $2, description = $3, updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(&name)
    .bind(&description)
    .execute(&mut *tx)
    .await?;
    let new_version = match &req.graph {
        Some(g) => Some(add_version(&mut tx, id, g, actor.id).await?),
        None => None,
    };
    // An enabled workflow restarts its open run(s) on the new graph.
    let mut updated_runs: Vec<Uuid> = Vec::new();
    if let (Some(vid), true) = (new_version, cur.enabled) {
        updated_runs = sqlx::query_scalar(
            "UPDATE workflow_runs SET version_id = $2 \
             WHERE workflow_id = $1 AND status IN ('starting', 'running') RETURNING id",
        )
        .bind(id)
        .bind(vid)
        .fetch_all(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    for run_id in updated_runs {
        signal(
            &svc,
            RunSignal {
                action: RunAction::Update,
                workflow_id: id,
                run_id: Some(run_id),
                version_id: new_version,
            },
        )
        .await;
    }
    audit_soft(
        &st.pool,
        Some(actor.id),
        "workflow.update",
        Some(&id.to_string()),
        Some(json!({"name": name, "new_version": req.graph.is_some()})),
    )
    .await;
    Ok(Json(fetch(&st.pool, id).await?))
}

async fn enable(
    OperatorUser(actor): OperatorUser,
    State(st): State<AppState>,
    Extension(svc): Extension<Services>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Workflow>> {
    let cur = fetch(&st.pool, id).await?;
    let version_id = cur
        .active_version_id
        .ok_or_else(|| AppError::Conflict("workflow has no active version".into()))?;
    if cur.enabled {
        return Ok(Json(cur));
    }
    let mut tx = st.pool.begin().await?;
    sqlx::query("UPDATE workflows SET enabled = TRUE, updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let run_id: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_runs (workflow_id, version_id, status) \
         VALUES ($1, $2, 'starting') RETURNING id",
    )
    .bind(id)
    .bind(version_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    signal(
        &svc,
        RunSignal {
            action: RunAction::Start,
            workflow_id: id,
            run_id: Some(run_id),
            version_id: Some(version_id),
        },
    )
    .await;
    audit_soft(
        &st.pool,
        Some(actor.id),
        "workflow.enable",
        Some(&id.to_string()),
        Some(json!({"run_id": run_id})),
    )
    .await;
    Ok(Json(fetch(&st.pool, id).await?))
}

async fn disable(
    OperatorUser(actor): OperatorUser,
    State(st): State<AppState>,
    Extension(svc): Extension<Services>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Workflow>> {
    let cur = fetch(&st.pool, id).await?;
    if !cur.enabled {
        return Ok(Json(cur));
    }
    let mut tx = st.pool.begin().await?;
    sqlx::query("UPDATE workflows SET enabled = FALSE, updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let stopped: Vec<Uuid> = sqlx::query_scalar(
        "UPDATE workflow_runs SET status = 'stopped', stopped_at = now() \
         WHERE workflow_id = $1 AND status IN ('starting', 'running') RETURNING id",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    if stopped.is_empty() {
        signal(
            &svc,
            RunSignal {
                action: RunAction::Stop,
                workflow_id: id,
                run_id: None,
                version_id: cur.active_version_id,
            },
        )
        .await;
    }
    for run_id in &stopped {
        signal(
            &svc,
            RunSignal {
                action: RunAction::Stop,
                workflow_id: id,
                run_id: Some(*run_id),
                version_id: cur.active_version_id,
            },
        )
        .await;
    }
    audit_soft(
        &st.pool,
        Some(actor.id),
        "workflow.disable",
        Some(&id.to_string()),
        Some(json!({"runs_stopped": stopped.len()})),
    )
    .await;
    Ok(Json(fetch(&st.pool, id).await?))
}

/// Best-effort: the DB is the source of truth, a failed signal is logged.
async fn signal(svc: &Services, sig: RunSignal) {
    if let Err(e) = svc.run_control.signal(sig).await {
        tracing::warn!(error = %e, "run control signal failed");
    }
}

async fn runs(
    _u: AuthUser,
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Vec<WorkflowRun>>> {
    fetch(&st.pool, id).await?;
    let rows = sqlx::query_as(
        "SELECT id, workflow_id, version_id, status, error, started_at, stopped_at \
         FROM workflow_runs WHERE workflow_id = $1 ORDER BY started_at DESC, id",
    )
    .bind(id)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(rows))
}
