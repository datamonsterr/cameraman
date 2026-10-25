use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use cameraman::{app, config::Config, seed, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;

fn router_with(pool: PgPool, cfg: Config) -> Router {
    app(AppState {
        pool,
        config: Arc::new(cfg),
    })
}

fn router(pool: PgPool) -> Router {
    router_with(pool, Config::for_test())
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

async fn register(app: &Router, email: &str) -> (StatusCode, Value) {
    call(
        app,
        Method::POST,
        "/api/v1/auth/register",
        None,
        Some(json!({"email": email, "display_name": "Test", "password": "correct-horse"})),
    )
    .await
}

async fn login(app: &Router, email: &str, pw: &str) -> (StatusCode, Value) {
    call(
        app,
        Method::POST,
        "/api/v1/auth/login",
        None,
        Some(json!({"email": email, "password": pw})),
    )
    .await
}

#[sqlx::test]
async fn health_endpoints(pool: PgPool) {
    let app = router(pool);
    for uri in ["/health", "/api/v1/health"] {
        let (s, v) = call(&app, Method::GET, uri, None, None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v, json!({"status": "ok"}));
    }
}

#[sqlx::test]
async fn register_login_me(pool: PgPool) {
    let app = router(pool);
    let (s, u) = register(&app, "first@example.com").await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(u["role"], "admin", "first user is admin");
    assert!(u.get("password_hash").is_none());
    let (s, u2) = register(&app, "Second@Example.com").await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(u2["role"], "viewer");
    assert_eq!(u2["email"], "second@example.com");

    let (s, l) = login(&app, "second@example.com", "correct-horse").await;
    assert_eq!(s, StatusCode::OK);
    assert!(l["user"].get("password_hash").is_none());
    let access = l["access_token"].as_str().unwrap();
    assert!(l["refresh_token"].as_str().is_some());

    let (s, me) = call(&app, Method::GET, "/api/v1/me", Some(access), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(me["email"], "second@example.com");
    assert_eq!(me["role"], "viewer");

    let (s, e) = call(&app, Method::GET, "/api/v1/me", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(e["error"], "unauthorized");
    let (s, _) = call(&app, Method::GET, "/api/v1/me", Some("garbage"), None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn duplicate_email_conflict(pool: PgPool) {
    let app = router(pool);
    assert_eq!(register(&app, "a@example.com").await.0, StatusCode::CREATED);
    let (s, e) = register(&app, "A@example.com").await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(e["error"], "conflict");
}

#[sqlx::test]
async fn register_validation_422(pool: PgPool) {
    let app = router(pool);
    let (s, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/register",
        None,
        Some(json!({"email": "nope", "display_name": "x", "password": "correct-horse"})),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let (s, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/register",
        None,
        Some(json!({"email": "a@b.co", "display_name": "x", "password": "short"})),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
}

#[sqlx::test]
async fn bad_login_is_generic_401(pool: PgPool) {
    let app = router(pool);
    register(&app, "a@example.com").await;
    let (s1, e1) = login(&app, "a@example.com", "wrong-password").await;
    let (s2, e2) = login(&app, "ghost@example.com", "wrong-password").await;
    assert_eq!(s1, StatusCode::UNAUTHORIZED);
    assert_eq!(s2, StatusCode::UNAUTHORIZED);
    assert_eq!(e1, e2, "no user enumeration");
}

#[sqlx::test]
async fn refresh_rotates_and_invalidates_old(pool: PgPool) {
    let app = router(pool.clone());
    register(&app, "a@example.com").await;
    let (_, l) = login(&app, "a@example.com", "correct-horse").await;
    let old = l["refresh_token"].as_str().unwrap().to_string();

    let (s, n) = call(
        &app,
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": old})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let new = n["refresh_token"].as_str().unwrap().to_string();
    assert_ne!(new, old);
    let (s, me) = call(
        &app,
        Method::GET,
        "/api/v1/me",
        n["access_token"].as_str(),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(me["email"], "a@example.com");

    let (s, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": old})),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "old token is single-use");
    let (s, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": new})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    // Only hashes are stored.
    let plain: i64 =
        sqlx::query_scalar("SELECT count(*) FROM refresh_tokens WHERE token_hash = $1")
            .bind(&old)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(plain, 0);
}

#[sqlx::test]
async fn logout_revokes(pool: PgPool) {
    let app = router(pool);
    register(&app, "a@example.com").await;
    let (_, l) = login(&app, "a@example.com", "correct-horse").await;
    let rt = l["refresh_token"].as_str().unwrap();
    let (s, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/logout",
        None,
        Some(json!({"refresh_token": rt})),
    )
    .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": rt})),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn expired_refresh_rejected(pool: PgPool) {
    let mut cfg = Config::for_test();
    cfg.refresh_ttl_secs = -10;
    let app = router_with(pool, cfg);
    register(&app, "a@example.com").await;
    let (_, l) = login(&app, "a@example.com", "correct-horse").await;
    let (s, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": l["refresh_token"]})),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn rbac_audit_admin_only(pool: PgPool) {
    let app = router(pool);
    register(&app, "admin@example.com").await; // first -> admin
    register(&app, "viewer@example.com").await;
    let (_, a) = login(&app, "admin@example.com", "correct-horse").await;
    let (_, v) = login(&app, "viewer@example.com", "correct-horse").await;

    let (s, e) = call(
        &app,
        Method::GET,
        "/api/v1/audit",
        v["access_token"].as_str(),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(e["error"], "forbidden");
    let (s, _) = call(&app, Method::GET, "/api/v1/audit", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    let (s, list) = call(
        &app,
        Method::GET,
        "/api/v1/audit?limit=50",
        a["access_token"].as_str(),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let actions: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    assert!(actions.contains(&"auth.register"));
    assert!(actions.contains(&"auth.login"));
}

#[sqlx::test]
async fn role_change_takes_effect_immediately(pool: PgPool) {
    let app = router(pool.clone());
    register(&app, "admin@example.com").await;
    let (_, a) = login(&app, "admin@example.com", "correct-horse").await;
    let tok = a["access_token"].as_str().unwrap();
    sqlx::query("UPDATE users SET role = 'viewer' WHERE email = 'admin@example.com'")
        .execute(&pool)
        .await
        .unwrap();
    let (s, _) = call(&app, Method::GET, "/api/v1/audit", Some(tok), None).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "role loaded from DB, not JWT");
}

#[sqlx::test]
async fn seed_admin_idempotent(pool: PgPool) {
    let mut cfg = Config::for_test();
    cfg.seed_on_start = true;
    cfg.admin_email = Some("Root@Example.com".into());
    cfg.admin_password = Some("seed-password-1".into());
    let state = AppState {
        pool: pool.clone(),
        config: Arc::new(cfg),
    };
    seed(&state).await.unwrap();
    seed(&state).await.unwrap();
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users WHERE email = 'root@example.com' AND role = 'admin'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, 1);
    let hash: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE email = 'root@example.com'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(hash.starts_with("$argon2id$"));
    let app = app(state);
    let (s, _) = login(&app, "root@example.com", "seed-password-1").await;
    assert_eq!(s, StatusCode::OK);
}

#[sqlx::test]
async fn seed_disabled_does_nothing(pool: PgPool) {
    let mut cfg = Config::for_test();
    cfg.admin_email = Some("root@example.com".into());
    cfg.admin_password = Some("seed-password-1".into());
    let state = AppState {
        pool: pool.clone(),
        config: Arc::new(cfg),
    };
    seed(&state).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}
