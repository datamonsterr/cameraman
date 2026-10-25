use std::{net::IpAddr, time::Duration};

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Extension, Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    audit::audit_soft,
    crypto::{decrypt_secret, encrypt_secret},
    discovery::{self, Candidate},
    error::{AppError, AppResult},
    extract::{AuthUser, OperatorUser},
    rtsp::{build_rtsp_url, ValidateError},
    AppState, Services,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "camera_status", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum CameraStatus {
    Discovered,
    Connecting,
    Online,
    Offline,
    Error,
}

/// Public camera view. Never carries the encrypted secret, only whether one is set.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Camera {
    pub id: Uuid,
    pub name: String,
    pub vendor: Option<String>,
    pub host: String,
    pub port: i32,
    pub rtsp_path: String,
    pub rtsp_username: Option<String>,
    pub has_credentials: bool,
    pub transport: String,
    pub status: CameraStatus,
    pub status_reason: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub codec: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct StatusChange {
    pub id: i64,
    pub status: CameraStatus,
    pub reason: Option<String>,
    pub created_at: DateTime<Utc>,
}

const COLS: &str = "id, name, vendor, host(host) AS host, port, rtsp_path, rtsp_username, \
    (rtsp_secret_enc IS NOT NULL) AS has_credentials, transport, status, status_reason, \
    last_seen_at, width, height, codec, created_at, updated_at";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/scan", post(scan))
        .route("/{id}", get(get_one).patch(update).delete(remove))
        .route("/{id}/connect", post(connect))
        .route("/{id}/status/history", get(status_history))
}

/// Update `cameras.status` and append a `camera_status_history` row atomically.
pub async fn set_status(
    pool: &PgPool,
    id: Uuid,
    status: CameraStatus,
    reason: Option<&str>,
) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    let n = sqlx::query(
        "UPDATE cameras SET status = $2, status_reason = $3, updated_at = now(), \
         last_seen_at = CASE WHEN $2 = 'online'::camera_status THEN now() ELSE last_seen_at END \
         WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(reason)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound("camera not found".into()));
    }
    sqlx::query(
        "INSERT INTO camera_status_history (camera_id, status, reason) VALUES ($1, $2, $3)",
    )
    .bind(id)
    .bind(status)
    .bind(reason)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn fetch(pool: &PgPool, id: Uuid) -> AppResult<Camera> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM cameras WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("camera not found".into()))
}

fn map_write_err(e: sqlx::Error) -> AppError {
    if let Some(db) = e.as_database_error() {
        if db.is_unique_violation() {
            return AppError::Conflict(
                "a camera with this host, port and path already exists".into(),
            );
        }
    }
    e.into()
}

fn validate_host(h: &str) -> AppResult<String> {
    h.trim()
        .parse::<IpAddr>()
        .map(|ip| ip.to_string())
        .map_err(|_| AppError::Unprocessable("host must be an IP address".into()))
}

fn validate_port(p: i32) -> AppResult<i32> {
    if (1..=65535).contains(&p) {
        Ok(p)
    } else {
        Err(AppError::Unprocessable("port must be 1-65535".into()))
    }
}

fn normalize_path(p: &str) -> String {
    let p = p.trim();
    if p.starts_with('/') {
        p.to_string()
    } else {
        format!("/{p}")
    }
}

fn validate_transport(t: &str) -> AppResult<String> {
    match t.trim().to_lowercase().as_str() {
        v @ ("tcp" | "udp") => Ok(v.to_string()),
        _ => Err(AppError::Unprocessable(
            "transport must be tcp or udp".into(),
        )),
    }
}

fn validate_name(n: &str) -> AppResult<String> {
    let n = n.trim();
    if n.is_empty() {
        Err(AppError::Unprocessable("name is required".into()))
    } else {
        Ok(n.to_string())
    }
}

fn nonempty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty())
}

// ------------------------------------------------------------------ CRUD

async fn list(_u: AuthUser, State(st): State<AppState>) -> AppResult<Json<Vec<Camera>>> {
    let rows = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM cameras ORDER BY created_at DESC, id"
    )))
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(rows))
}

async fn get_one(
    _u: AuthUser,
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Camera>> {
    Ok(Json(fetch(&st.pool, id).await?))
}

#[derive(Deserialize)]
pub struct CreateReq {
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: i32,
    #[serde(default = "default_path")]
    pub rtsp_path: String,
    pub rtsp_username: Option<String>,
    pub rtsp_password: Option<String>,
    pub transport: Option<String>,
    pub vendor: Option<String>,
}

fn default_port() -> i32 {
    554
}
fn default_path() -> String {
    "/".into()
}

async fn create(
    OperatorUser(actor): OperatorUser,
    State(st): State<AppState>,
    Json(req): Json<CreateReq>,
) -> AppResult<(StatusCode, Json<Camera>)> {
    let name = validate_name(&req.name)?;
    let host = validate_host(&req.host)?;
    let port = validate_port(req.port)?;
    let path = normalize_path(&req.rtsp_path);
    let transport = validate_transport(req.transport.as_deref().unwrap_or("tcp"))?;
    let user = nonempty(req.rtsp_username);
    let secret = match nonempty(req.rtsp_password) {
        Some(p) => Some(encrypt_secret(&st.config.camera_enc_key, &p)?),
        None => None,
    };
    let cam: Camera = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "INSERT INTO cameras (name, vendor, host, port, rtsp_path, rtsp_username, rtsp_secret_enc, transport) \
         VALUES ($1, $2, $3::inet, $4, $5, $6, $7, $8) RETURNING {COLS}"
    )))
    .bind(&name)
    .bind(nonempty(req.vendor))
    .bind(&host)
    .bind(port)
    .bind(&path)
    .bind(&user)
    .bind(secret)
    .bind(&transport)
    .fetch_one(&st.pool)
    .await
    .map_err(map_write_err)?;
    sqlx::query("INSERT INTO camera_status_history (camera_id, status) VALUES ($1, $2)")
        .bind(cam.id)
        .bind(CameraStatus::Discovered)
        .execute(&st.pool)
        .await?;
    audit_soft(
        &st.pool,
        Some(actor.id),
        "camera.create",
        Some(&cam.id.to_string()),
        Some(json!({"name": cam.name, "host": cam.host, "port": cam.port})),
    )
    .await;
    Ok((StatusCode::CREATED, Json(cam)))
}

#[derive(Deserialize)]
pub struct UpdateReq {
    pub name: Option<String>,
    pub vendor: Option<String>,
    pub host: Option<String>,
    pub port: Option<i32>,
    pub rtsp_path: Option<String>,
    /// Empty string clears.
    pub rtsp_username: Option<String>,
    /// Non-empty rotates the stored credential; empty string clears it.
    pub rtsp_password: Option<String>,
    pub transport: Option<String>,
}

async fn update(
    OperatorUser(actor): OperatorUser,
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateReq>,
) -> AppResult<Json<Camera>> {
    let cur = fetch(&st.pool, id).await?;
    let name = validate_name(req.name.as_deref().unwrap_or(&cur.name))?;
    let host = validate_host(req.host.as_deref().unwrap_or(&cur.host))?;
    let port = validate_port(req.port.unwrap_or(cur.port))?;
    let path = normalize_path(req.rtsp_path.as_deref().unwrap_or(&cur.rtsp_path));
    let transport = validate_transport(req.transport.as_deref().unwrap_or(&cur.transport))?;
    let vendor = match req.vendor {
        Some(v) => nonempty(Some(v)),
        None => cur.vendor.clone(),
    };
    let user = match req.rtsp_username {
        Some(u) => nonempty(Some(u)),
        None => cur.rtsp_username.clone(),
    };
    let rotated = req.rtsp_password.is_some();
    // $9 = whether to touch the secret column; $10 = its new value (NULL clears).
    let secret = match req.rtsp_password {
        Some(p) if !p.is_empty() => Some(encrypt_secret(&st.config.camera_enc_key, &p)?),
        _ => None,
    };
    let cam: Camera = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE cameras SET name = $2, vendor = $3, host = $4::inet, port = $5, rtsp_path = $6, \
         rtsp_username = $7, transport = $8, \
         rtsp_secret_enc = CASE WHEN $9 THEN $10 ELSE rtsp_secret_enc END, \
         updated_at = now() WHERE id = $1 RETURNING {COLS}"
    )))
    .bind(id)
    .bind(&name)
    .bind(&vendor)
    .bind(&host)
    .bind(port)
    .bind(&path)
    .bind(&user)
    .bind(&transport)
    .bind(rotated)
    .bind(secret)
    .fetch_one(&st.pool)
    .await
    .map_err(map_write_err)?;
    audit_soft(
        &st.pool,
        Some(actor.id),
        "camera.update",
        Some(&id.to_string()),
        Some(json!({"credentials_rotated": rotated})),
    )
    .await;
    Ok(Json(cam))
}

async fn remove(
    OperatorUser(actor): OperatorUser,
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let n = sqlx::query("DELETE FROM cameras WHERE id = $1")
        .bind(id)
        .execute(&st.pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound("camera not found".into()));
    }
    audit_soft(
        &st.pool,
        Some(actor.id),
        "camera.delete",
        Some(&id.to_string()),
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------ discovery

#[derive(Deserialize, Default)]
struct ScanReq {
    cidr: Option<String>,
}

const SCAN_TIMEOUT: Duration = Duration::from_secs(20);

async fn scan(
    OperatorUser(actor): OperatorUser,
    State(st): State<AppState>,
    Extension(svc): Extension<Services>,
    body: Bytes,
) -> AppResult<Json<serde_json::Value>> {
    let req: ScanReq = if body.iter().all(u8::is_ascii_whitespace) {
        ScanReq::default()
    } else {
        serde_json::from_slice(&body).map_err(|e| AppError::BadRequest(e.to_string()))?
    };
    let cidr = match nonempty(req.cidr) {
        Some(c) => c,
        None => discovery::default_cidr().await.ok_or_else(|| {
            AppError::Unprocessable("cannot determine local network; pass cidr".into())
        })?,
    };
    let candidates: Vec<Candidate> =
        discovery::scan(svc.probe.clone(), &cidr, SCAN_TIMEOUT).await?;
    audit_soft(
        &st.pool,
        Some(actor.id),
        "camera.scan",
        Some(&cidr),
        Some(json!({"found": candidates.len()})),
    )
    .await;
    Ok(Json(json!({ "cidr": cidr, "candidates": candidates })))
}

// ------------------------------------------------------------------ connect

#[derive(Deserialize, Default)]
struct ConnectReq {
    username: Option<String>,
    password: Option<String>,
}

async fn connect(
    OperatorUser(actor): OperatorUser,
    State(st): State<AppState>,
    Extension(svc): Extension<Services>,
    Path(id): Path<Uuid>,
    body: Bytes,
) -> AppResult<Json<Camera>> {
    let req: ConnectReq = if body.iter().all(u8::is_ascii_whitespace) {
        ConnectReq::default()
    } else {
        serde_json::from_slice(&body).map_err(|e| AppError::BadRequest(e.to_string()))?
    };
    let cam = fetch(&st.pool, id).await?;
    let key = &st.config.camera_enc_key;
    let stored: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT rtsp_secret_enc FROM cameras WHERE id = $1")
            .bind(id)
            .fetch_one(&st.pool)
            .await?;
    let given_user = nonempty(req.username);
    let given_pass = nonempty(req.password);
    let user = given_user.clone().or(cam.rtsp_username.clone());
    let pass = match (&given_pass, &stored) {
        (Some(p), _) => Some(p.clone()),
        (None, Some(blob)) => Some(decrypt_secret(key, blob)?),
        (None, None) => None,
    };

    set_status(&st.pool, id, CameraStatus::Connecting, None).await?;
    let url = build_rtsp_url(
        &cam.host,
        cam.port,
        &cam.rtsp_path,
        user.as_deref(),
        pass.as_deref(),
    );
    match svc.validator.validate(&url, &cam.transport).await {
        Ok(meta) => {
            let secret = match &given_pass {
                Some(p) => Some(encrypt_secret(key, p)?),
                None => None,
            };
            sqlx::query(
                "UPDATE cameras SET width = $2, height = $3, codec = $4, rtsp_username = $5, \
                 rtsp_secret_enc = COALESCE($6, rtsp_secret_enc) WHERE id = $1",
            )
            .bind(id)
            .bind(meta.width)
            .bind(meta.height)
            .bind(&meta.codec)
            .bind(&user)
            .bind(secret)
            .execute(&st.pool)
            .await?;
            set_status(&st.pool, id, CameraStatus::Online, None).await?;
            audit_soft(
                &st.pool,
                Some(actor.id),
                "camera.connect",
                Some(&id.to_string()),
                Some(json!({"result": "online"})),
            )
            .await;
        }
        Err(e) => {
            let reason = e.reason().to_string();
            set_status(&st.pool, id, CameraStatus::Error, Some(&reason)).await?;
            audit_soft(
                &st.pool,
                Some(actor.id),
                "camera.connect",
                Some(&id.to_string()),
                Some(json!({
                    "result": "error",
                    "auth_failed": matches!(e, ValidateError::Auth(_)),
                    "reason": reason,
                })),
            )
            .await;
        }
    }
    Ok(Json(fetch(&st.pool, id).await?))
}

// ------------------------------------------------------------------ history

#[derive(Deserialize)]
struct HistoryQuery {
    limit: Option<i64>,
}

async fn status_history(
    _u: AuthUser,
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<HistoryQuery>,
) -> AppResult<Json<Vec<StatusChange>>> {
    fetch(&st.pool, id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let rows = sqlx::query_as(
        "SELECT id, status, reason, created_at FROM camera_status_history \
         WHERE camera_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
    )
    .bind(id)
    .bind(limit)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(rows))
}
