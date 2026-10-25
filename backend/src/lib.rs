pub mod audit;
pub mod auth;
pub mod camera;
pub mod config;
pub mod crypto;
pub mod device;
pub mod discovery;
pub mod error;
pub mod events;
pub mod extract;
pub mod ingest;
pub mod landmark;
pub mod mail;
pub mod media;
pub mod models;
pub mod password;
pub mod realtime;
pub mod registry;
pub mod rtsp;
pub mod runctl;
pub mod tokens;
pub mod workflow;

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{HeaderValue, Method},
    routing::get,
    Json, Router,
};
use config::Config;
use discovery::{Probe, RealProbe};
use error::AppResult;
use events::{EventSink, LogEventSink};
use extract::{AdminUser, AuthUser};
use mail::{Mailer, SmtpMailer};
use models::{AuditEntry, User};
use rtsp::{FfprobeValidator, RtspValidator};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use workflow::{LogRunControl, RunControl};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
}

/// Network-facing collaborators, swappable in tests (see `app_with`).
#[derive(Clone)]
pub struct Services {
    pub probe: Arc<dyn Probe>,
    pub validator: Arc<dyn RtspValidator>,
    /// Worker start/stop signalling (`runctl::RedisRunControl` when Redis is configured).
    pub run_control: Arc<dyn RunControl>,
    /// Event fan-out (`realtime::RedisEventSink` when Redis is configured).
    pub events: Arc<dyn EventSink>,
    pub mailer: Arc<dyn Mailer>,
}

impl Services {
    /// Real LAN probe + ffprobe validator; run control and events are log-only
    /// (no-op fallback). See [`Services::wired`] for the Redis-backed pair.
    pub fn real() -> Self {
        Self {
            probe: Arc::new(RealProbe::default()),
            validator: Arc::new(FfprobeValidator::default()),
            run_control: Arc::new(LogRunControl),
            events: Arc::new(LogEventSink),
            mailer: Arc::new(SmtpMailer),
        }
    }
}

impl Services {
    /// `real()` plus Redis run control and event fan-out when `config.redis_url` is set.
    pub fn wired(state: &AppState) -> Self {
        let mut svc = Self::real();
        let url = state.config.redis_url.trim();
        if url.is_empty() {
            return svc;
        }
        match runctl::RedisRunControl::new(url, state.pool.clone(), state.config.camera_enc_key) {
            Ok(rc) => svc.run_control = Arc::new(rc),
            Err(e) => tracing::warn!(error = %e, "redis run control disabled"),
        }
        match realtime::RedisEventSink::new(url) {
            Ok(sink) => svc.events = Arc::new(sink),
            Err(e) => tracing::warn!(error = %e, "redis event fan-out disabled"),
        }
        svc
    }
}

/// Connect to Postgres and apply migrations.
pub async fn connect_db(database_url: &str) -> Result<PgPool, sqlx::Error> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt().with_env_filter(filter).try_init();
}

fn cors(origins: &str) -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(Any);
    if origins.trim() == "*" {
        layer.allow_origin(Any)
    } else {
        let list: Vec<HeaderValue> = origins
            .split(',')
            .filter_map(|o| o.trim().parse().ok())
            .collect();
        layer.allow_origin(list)
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn me(user: AuthUser) -> Json<User> {
    Json(user.0)
}

#[derive(Deserialize)]
struct AuditQuery {
    limit: Option<i64>,
}

async fn list_audit(
    _admin: AdminUser,
    State(st): State<AppState>,
    Query(q): Query<AuditQuery>,
) -> AppResult<Json<Vec<AuditEntry>>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let rows = sqlx::query_as(
        "SELECT id, actor_id, action, target, detail, created_at \
         FROM audit_log ORDER BY created_at DESC, id DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(rows))
}

/// Build the application router (no port binding; usable from tests).
pub fn app(state: AppState) -> Router {
    let services = Services::wired(&state);
    app_with(state, services)
}

/// Like [`app`] but with injected network collaborators (fakes in tests).
pub fn app_with(state: AppState, services: Services) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/me", get(me))
        .route("/audit", get(list_audit))
        .nest("/auth", auth::router())
        .nest(
            "/cameras",
            camera::router().merge(realtime::camera_router()),
        )
        .merge(realtime::router())
        .nest("/landmarks", landmark::router())
        .nest("/snapshots", media::router())
        .nest("/node-types", registry::router())
        .nest("/workflows", workflow::router())
        .nest("/events", events::router())
        .nest("/ingest", ingest::router())
        .nest("/settings", mail::router())
        .nest("/devices", device::router());
    let layer_cors = cors(&state.config.cors_origins);
    Router::new()
        .route("/health", get(health))
        .nest("/api/v1", api)
        .layer(TraceLayer::new_for_http())
        .layer(layer_cors)
        .layer(axum::Extension(services))
        .with_state(state)
}

/// Startup seeding: node-type registry always; admin only when `SEED_ON_START`.
pub async fn seed(state: &AppState) -> AppResult<()> {
    registry::seed_node_types(&state.pool).await?;
    let c = &state.config;
    if !c.seed_on_start {
        return Ok(());
    }
    match (&c.admin_email, &c.admin_password) {
        (Some(e), Some(p)) => auth::ensure_admin(&state.pool, e, p).await,
        _ => {
            tracing::warn!("SEED_ON_START set but ADMIN_EMAIL/ADMIN_PASSWORD missing; skipping");
            Ok(())
        }
    }
}
