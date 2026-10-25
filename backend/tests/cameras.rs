use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use cameraman::{
    app_with,
    camera::{set_status, CameraStatus},
    config::Config,
    discovery::FakeProbe,
    rtsp::{FakeValidator, StreamMeta, ValidateError},
    AppState, Services,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

struct Ctx {
    app: Router,
    pool: PgPool,
    admin: String,
    viewer: String,
}

fn services(v: Result<StreamMeta, ValidateError>) -> Services {
    Services {
        probe: Arc::new(FakeProbe::lan_fixture()),
        validator: Arc::new(FakeValidator(v)),
    }
}

fn meta() -> StreamMeta {
    StreamMeta {
        width: 2304,
        height: 1296,
        codec: "hevc".into(),
    }
}

async fn call(
    app: &Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
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

async fn ctx(pool: PgPool, v: Result<StreamMeta, ValidateError>) -> Ctx {
    let app = app_with(
        AppState {
            pool: pool.clone(),
            config: Arc::new(Config::for_test()),
        },
        services(v),
    );
    let admin = token(&app, "admin@example.com").await; // first user = admin
    let viewer = token(&app, "viewer@example.com").await;
    Ctx {
        app,
        pool,
        admin,
        viewer,
    }
}

fn new_cam() -> Value {
    json!({
        "name": "Front door", "host": "192.168.1.38", "port": 554, "rtsp_path": "/tenda",
        "rtsp_username": "admin", "rtsp_password": "hunter2-pw"
    })
}

async fn create(c: &Ctx) -> Value {
    let (s, v) = call(
        &c.app,
        Method::POST,
        "/api/v1/cameras",
        Some(&c.admin),
        Some(new_cam()),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    v
}

#[sqlx::test]
async fn crud_happy_path_and_no_secrets(pool: PgPool) {
    let c = ctx(pool, Ok(meta())).await;
    let cam = create(&c).await;
    assert_eq!(cam["status"], "discovered");
    assert_eq!(cam["host"], "192.168.1.38");
    assert_eq!(cam["has_credentials"], true);
    assert_eq!(cam["rtsp_username"], "admin");
    let id = cam["id"].as_str().unwrap();

    // stored encrypted, never plaintext, never serialized
    let raw: Vec<u8> =
        sqlx::query_scalar("SELECT rtsp_secret_enc FROM cameras WHERE id = $1::uuid")
            .bind(id)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert!(!raw.windows(10).any(|w| w == b"hunter2-pw"));

    let (s, list) = call(
        &c.app,
        Method::GET,
        "/api/v1/cameras",
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
    let (s, one) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/cameras/{id}"),
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    for v in [&list.to_string(), &one.to_string(), &cam.to_string()] {
        assert!(!v.contains("hunter2-pw"));
        assert!(!v.contains("rtsp_secret_enc"));
        assert!(!v.contains("rtsp_password"));
    }

    let (s, up) = call(
        &c.app,
        Method::PATCH,
        &format!("/api/v1/cameras/{id}"),
        Some(&c.admin),
        Some(json!({"name": "Porch", "rtsp_password": "rotated-pw"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{up}");
    assert_eq!(up["name"], "Porch");
    assert_eq!(up["port"], 554);
    let raw2: Vec<u8> =
        sqlx::query_scalar("SELECT rtsp_secret_enc FROM cameras WHERE id = $1::uuid")
            .bind(id)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_ne!(raw, raw2, "credential rotated");

    let (s, _) = call(
        &c.app,
        Method::DELETE,
        &format!("/api/v1/cameras/{id}"),
        Some(&c.admin),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, e) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/cameras/{id}"),
        Some(&c.admin),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(e["error"], "not_found");

    let actions: Vec<String> =
        sqlx::query_scalar("SELECT action FROM audit_log WHERE action LIKE 'camera.%' ORDER BY id")
            .fetch_all(&c.pool)
            .await
            .unwrap();
    assert_eq!(actions, ["camera.create", "camera.update", "camera.delete"]);
    let leaked: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE detail::text LIKE '%pw%'")
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(leaked, 0);
}

#[sqlx::test]
async fn rbac_and_validation(pool: PgPool) {
    let c = ctx(pool, Ok(meta())).await;
    let cam = create(&c).await;
    let id = cam["id"].as_str().unwrap();
    let u = format!("/api/v1/cameras/{id}");

    for (m, uri, body) in [
        (Method::POST, "/api/v1/cameras".to_string(), Some(new_cam())),
        (Method::PATCH, u.clone(), Some(json!({"name": "x"}))),
        (Method::DELETE, u.clone(), None),
        (Method::POST, format!("{u}/connect"), Some(json!({}))),
        (
            Method::POST,
            "/api/v1/cameras/scan".to_string(),
            Some(json!({})),
        ),
    ] {
        let (s, _) = call(&c.app, m.clone(), &uri, Some(&c.viewer), body.clone()).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{m} {uri}");
        let (s, _) = call(&c.app, m.clone(), &uri, None, body).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "{m} {uri}");
    }
    for uri in [
        "/api/v1/cameras".to_string(),
        u.clone(),
        format!("{u}/status/history"),
    ] {
        assert_eq!(
            call(&c.app, Method::GET, &uri, None, None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(&c.app, Method::GET, &uri, Some(&c.viewer), None)
                .await
                .0,
            StatusCode::OK
        );
    }

    // operator role may mutate
    sqlx::query("UPDATE users SET role = 'operator' WHERE email = 'viewer@example.com'")
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, _) = call(
        &c.app,
        Method::PATCH,
        &u,
        Some(&c.viewer),
        Some(json!({"name": "ok"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    // validation + conflict
    let bad = |v: Value| async {
        call(
            &c.app,
            Method::POST,
            "/api/v1/cameras",
            Some(&c.admin),
            Some(v),
        )
        .await
        .0
    };
    assert_eq!(
        bad(json!({"name": "", "host": "1.2.3.4"})).await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        bad(json!({"name": "a", "host": "not-an-ip"})).await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        bad(json!({"name": "a", "host": "1.2.3.4", "port": 0})).await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        bad(json!({"name": "a", "host": "1.2.3.4", "transport": "sctp"})).await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(bad(new_cam()).await, StatusCode::CONFLICT);
    let (s, _) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/cameras/{}", Uuid::new_v4()),
        Some(&c.admin),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn manual_add_defaults(pool: PgPool) {
    let c = ctx(pool, Ok(meta())).await;
    let (s, v) = call(
        &c.app,
        Method::POST,
        "/api/v1/cameras",
        Some(&c.admin),
        Some(json!({"name": "Bare", "host": "192.168.1.164", "port": 8554, "rtsp_path": "live"})),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    assert_eq!(v["rtsp_path"], "/live");
    assert_eq!(v["transport"], "tcp");
    assert_eq!(v["has_credentials"], false);
}

#[sqlx::test]
async fn connect_success_stores_meta_and_history(pool: PgPool) {
    let c = ctx(pool, Ok(meta())).await;
    let cam = create(&c).await;
    let id = cam["id"].as_str().unwrap();
    let (s, v) = call(
        &c.app,
        Method::POST,
        &format!("/api/v1/cameras/{id}/connect"),
        Some(&c.admin),
        Some(json!({"username": "u2", "password": "new-pw"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "online");
    assert_eq!(v["width"], 2304);
    assert_eq!(v["height"], 1296);
    assert_eq!(v["codec"], "hevc");
    assert_eq!(v["rtsp_username"], "u2");
    assert!(v["last_seen_at"].is_string());
    assert!(!v.to_string().contains("new-pw"));

    let (_, h) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/cameras/{id}/status/history"),
        Some(&c.viewer),
        None,
    )
    .await;
    let seq: Vec<&str> = h
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .map(|r| r["status"].as_str().unwrap())
        .collect();
    assert_eq!(seq, ["discovered", "connecting", "online"]);
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = 'camera.connect'")
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(n, 1);
}

#[sqlx::test]
async fn connect_auth_failure_sets_error(pool: PgPool) {
    let c = ctx(
        pool,
        Err(ValidateError::Auth(
            "authentication failed (401): check username/password".into(),
        )),
    )
    .await;
    let cam = create(&c).await;
    let id = cam["id"].as_str().unwrap();
    let (s, v) = call(
        &c.app,
        Method::POST,
        &format!("/api/v1/cameras/{id}/connect"),
        Some(&c.admin),
        Some(json!({"password": "wrong-pw"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["status"], "error");
    assert!(v["status_reason"].as_str().unwrap().contains("401"));
    assert!(v["width"].is_null());
    let (_, h) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/cameras/{id}/status/history?limit=1"),
        Some(&c.admin),
        None,
    )
    .await;
    assert_eq!(h[0]["status"], "error");
    assert!(h[0]["reason"].as_str().unwrap().contains("401"));
    // unknown camera id
    let (s, _) = call(
        &c.app,
        Method::POST,
        &format!("/api/v1/cameras/{}/connect", Uuid::new_v4()),
        Some(&c.admin),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn scan_endpoint_returns_candidates(pool: PgPool) {
    let c = ctx(pool, Ok(meta())).await;
    let (s, v) = call(
        &c.app,
        Method::POST,
        "/api/v1/cameras/scan",
        Some(&c.admin),
        Some(json!({"cidr": "192.168.1.0/24"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let cands = v["candidates"].as_array().unwrap();
    assert_eq!(cands.len(), 2);
    let b = cands.iter().find(|x| x["host"] == "192.168.1.164").unwrap();
    assert_eq!(b["port"], 8554);
    assert_eq!(b["vendor"], "YGTek RTSP Server 2.0");
    assert_eq!(b["requires_auth"], true);
    let (s, _) = call(
        &c.app,
        Method::POST,
        "/api/v1/cameras/scan",
        Some(&c.admin),
        Some(json!({"cidr": "bogus"})),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = 'camera.scan'")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[sqlx::test]
async fn set_status_records_transitions(pool: PgPool) {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO cameras (name, host) VALUES ('c', '10.0.0.9'::inet) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    set_status(&pool, id, CameraStatus::Online, None)
        .await
        .unwrap();
    set_status(&pool, id, CameraStatus::Offline, Some("stream dropped"))
        .await
        .unwrap();
    let (st, reason, seen): (
        CameraStatus,
        Option<String>,
        Option<chrono::DateTime<chrono::Utc>>,
    ) = sqlx::query_as("SELECT status, status_reason, last_seen_at FROM cameras WHERE id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(st, CameraStatus::Offline);
    assert_eq!(reason.as_deref(), Some("stream dropped"));
    assert!(seen.is_some(), "last_seen_at set when it was online");
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM camera_status_history WHERE camera_id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(n, 2);
    assert!(
        set_status(&pool, Uuid::new_v4(), CameraStatus::Online, None)
            .await
            .is_err()
    );
}
