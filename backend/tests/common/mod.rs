#![allow(dead_code)]
use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use cameraman::{
    app_with, config::Config, events::FakeEventSink, mail::FakeMailer, workflow::FakeRunControl,
    AppState, Services,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;

pub struct Ctx {
    pub app: Router,
    pub pool: PgPool,
    pub admin: String,
    pub operator: String,
    pub viewer: String,
    pub run_control: Arc<FakeRunControl>,
    pub events: Arc<FakeEventSink>,
    pub mailer: Arc<FakeMailer>,
}

pub async fn call_h(
    app: &Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    headers: &[(&str, &str)],
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let req = match body {
        Some(v) => b
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(v.to_string())),
        None => b.body(Body::empty()),
    }
    .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, v)
}

pub async fn call(
    app: &Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    call_h(app, method, uri, token, &[], body).await
}

async fn token(app: &Router, email: &str) -> String {
    call(
        app,
        Method::POST,
        "/api/v1/auth/register",
        None,
        Some(json!({"email": email, "display_name": "T", "password": "correct-horse"})),
    )
    .await;
    let (_, l) = call(
        app,
        Method::POST,
        "/api/v1/auth/login",
        None,
        Some(json!({"email": email, "password": "correct-horse"})),
    )
    .await;
    l["access_token"].as_str().unwrap().to_string()
}

/// Redis for integration tests: `REDIS_URL`, else the local test instance.
pub fn redis_url() -> String {
    std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6399".into())
}

pub async fn ctx_with(pool: PgPool, mailer: FakeMailer) -> Ctx {
    ctx_cfg(pool, mailer, |_| {}).await
}

/// Like `ctx_with` but lets the test tweak the config (redis_url, media_dir, ...).
pub async fn ctx_cfg(pool: PgPool, mailer: FakeMailer, tweak: impl FnOnce(&mut Config)) -> Ctx {
    let run_control = Arc::new(FakeRunControl::default());
    let events = Arc::new(FakeEventSink::default());
    let mailer = Arc::new(mailer);
    let services = Services {
        run_control: run_control.clone(),
        events: events.clone(),
        mailer: mailer.clone(),
        ..Services::real()
    };
    let mut config = Config::for_test();
    tweak(&mut config);
    let app = app_with(
        AppState {
            pool: pool.clone(),
            config: Arc::new(config),
        },
        services,
    );
    finish(app, pool, run_control, events, mailer).await
}

/// Real Redis-backed run control + event sink (`app` / `Services::wired`), with
/// `redis_url` and a private `media_dir` set. The fakes in `Ctx` stay empty.
pub async fn ctx_wired(pool: PgPool, media_dir: &str) -> Ctx {
    let mut config = Config::for_test();
    config.redis_url = redis_url();
    config.media_dir = media_dir.to_string();
    let app = cameraman::app(AppState {
        pool: pool.clone(),
        config: Arc::new(config),
    });
    finish(
        app,
        pool,
        Arc::default(),
        Arc::default(),
        Arc::new(FakeMailer::default()),
    )
    .await
}

/// Serve the app on an ephemeral port for WebSocket clients.
pub async fn serve(app: Router) -> std::net::SocketAddr {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    addr
}

async fn finish(
    app: Router,
    pool: PgPool,
    run_control: Arc<FakeRunControl>,
    events: Arc<FakeEventSink>,
    mailer: Arc<FakeMailer>,
) -> Ctx {
    let admin = token(&app, "admin@example.com").await; // first user = admin
    let viewer = token(&app, "viewer@example.com").await;
    let operator = token(&app, "op@example.com").await;
    sqlx::query("UPDATE users SET role = 'operator' WHERE email = 'op@example.com'")
        .execute(&pool)
        .await
        .unwrap();
    Ctx {
        app,
        pool,
        admin,
        operator,
        viewer,
        run_control,
        events,
        mailer,
    }
}

pub async fn ctx(pool: PgPool) -> Ctx {
    ctx_with(pool, FakeMailer::default()).await
}

pub fn good_graph() -> Value {
    json!({
        "nodes": [
            {"id": "cam", "type": "camera", "config": {"camera_id": "11111111-1111-1111-1111-111111111111"}},
            {"id": "code", "type": "codeblock", "config": {"code": "def process(f): pass"}},
            {"id": "mail", "type": "email", "config": {"to": ["a@b.co"], "subject": "hi"}}
        ],
        "edges": [
            {"id": "e1", "source": "cam", "target": "code", "sourceHandle": "frames", "targetHandle": "frames"},
            {"id": "e2", "source": "code", "target": "mail", "sourceHandle": "actions", "targetHandle": "trigger"}
        ]
    })
}

pub async fn insert_camera(pool: &PgPool, host: &str) -> uuid::Uuid {
    sqlx::query_scalar(
        "INSERT INTO cameras (name, host, port, rtsp_path) VALUES ('c', $1::inet, 554, '/') RETURNING id",
    )
    .bind(host)
    .fetch_one(pool)
    .await
    .unwrap()
}
