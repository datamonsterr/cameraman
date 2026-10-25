mod common;

use axum::http::{Method, StatusCode};
use cameraman::{crypto::decrypt_secret, mail::load_smtp_config, mail::FakeMailer};
use common::*;
use serde_json::{json, Value};
use sqlx::PgPool;

const W: [(&str, &str); 1] = [("x-worker-token", "test-worker-token")];

async fn ingest(c: &Ctx, body: Value) -> (StatusCode, Value) {
    call_h(
        &c.app,
        Method::POST,
        "/api/v1/ingest/events",
        None,
        &W,
        Some(body),
    )
    .await
}

#[sqlx::test]
async fn ingest_event_writes_rows_and_fans_out(pool: PgPool) {
    let c = ctx(pool).await;
    let cam = insert_camera(&c.pool, "10.0.0.1").await;
    let (s, v) = ingest(
        &c,
        json!({
            "kind": "detection", "camera_id": cam, "severity": "alert", "message": "person",
            "payload": {"k": 1},
            "detections": [{"label": "person", "confidence": 0.9, "box": {"x":0.1,"y":0.2,"w":0.3,"h":0.4}}],
            "snapshot": {"path": "snaps/a.jpg", "width": 640, "height": 480}
        }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    let id = v["id"].as_i64().unwrap();

    let published = c.events.recorded();
    assert_eq!(published.len(), 1);
    assert_eq!(published[0].event.id, id);
    assert_eq!(published[0].detections.len(), 1);

    let (s, d) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/events/{id}"),
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{d}");
    assert_eq!(d["kind"], "detection");
    assert_eq!(d["severity"], "alert");
    assert_eq!(d["detections"][0]["label"], "person");
    assert_eq!(d["detections"][0]["box"]["w"], 0.3);
    assert_eq!(d["snapshot"]["path"], "snaps/a.jpg");
    assert_eq!(d["snapshot"]["width"], 640);
    assert_eq!(d["snapshot_id"], d["snapshot"]["id"]);

    let (s, _) = call(
        &c.app,
        Method::GET,
        "/api/v1/events/999999",
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn ingest_auth_and_validation(pool: PgPool) {
    let c = ctx(pool).await;
    let body = json!({"kind": "system", "message": "hi"});
    let (s, _) = call(
        &c.app,
        Method::POST,
        "/api/v1/ingest/events",
        None,
        Some(body.clone()),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = call_h(
        &c.app,
        Method::POST,
        "/api/v1/ingest/events",
        None,
        &[("x-worker-token", "wrong")],
        Some(body.clone()),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    // a user JWT is not a worker credential
    let (s, _) = call(
        &c.app,
        Method::POST,
        "/api/v1/ingest/events",
        Some(&c.admin),
        Some(body.clone()),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = call_h(
        &c.app,
        Method::POST,
        "/api/v1/ingest/notifications",
        None,
        &[("x-worker-token", "wrong")],
        Some(json!({"recipients": ["a@b.co"]})),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert!(c.events.recorded().is_empty());
    assert!(c.mailer.recorded().is_empty());

    let (s, _) = ingest(&c, json!({"kind": "system", "severity": "panic"})).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let (s, _) = ingest(
        &c,
        json!({"kind": "system", "camera_id": uuid::Uuid::new_v4()}),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let (s, _) = ingest(
        &c,
        json!({"kind": "system", "detections": [{"label":"x","confidence":2.0,"box":{}}]}),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM events")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[sqlx::test]
async fn events_query_filters(pool: PgPool) {
    let c = ctx(pool).await;
    let cam_a = insert_camera(&c.pool, "10.0.0.1").await;
    let cam_b = insert_camera(&c.pool, "10.0.0.2").await;
    for i in 0..5 {
        ingest(
            &c,
            json!({"kind": "detection", "camera_id": cam_a, "message": format!("a{i}")}),
        )
        .await;
    }
    ingest(
        &c,
        json!({"kind": "health", "camera_id": cam_b, "severity": "warn", "message": "b"}),
    )
    .await;
    ingest(&c, json!({"kind": "system", "message": "sys"})).await;

    let get = |q: String| {
        let app = c.app.clone();
        let t = c.viewer.clone();
        async move {
            call(
                &app,
                Method::GET,
                &format!("/api/v1/events{q}"),
                Some(&t),
                None,
            )
            .await
        }
    };
    let (s, all) = get(String::new()).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(all.as_array().unwrap().len(), 7);
    assert_eq!(all[0]["message"], "sys"); // newest first

    let (_, v) = get(format!("?camera_id={cam_a}&limit=3")).await;
    let msgs: Vec<_> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["message"].as_str().unwrap())
        .collect();
    assert_eq!(msgs, ["a4", "a3", "a2"]);

    let (_, v) = get("?kind=health".into()).await;
    assert_eq!(v.as_array().unwrap().len(), 1);
    let (_, v) = get("?severity=warn".into()).await;
    assert_eq!(v.as_array().unwrap().len(), 1);
    let (_, v) = get("?since=2999-01-01T00:00:00Z".into()).await;
    assert!(v.as_array().unwrap().is_empty());
    let (_, v) = get("?since=2000-01-01T00:00:00Z&limit=2".into()).await;
    assert_eq!(v.as_array().unwrap().len(), 2);
    let (_, v) = get("?limit=0".into()).await; // clamped to 1
    assert_eq!(v.as_array().unwrap().len(), 1);
    let (s, _) = get("?kind=bogus".into()).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = call(&c.app, Method::GET, "/api/v1/events", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn notification_sends_and_records(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, ev) = ingest(&c, json!({"kind": "notification"})).await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, v) = call_h(
        &c.app,
        Method::POST,
        "/api/v1/ingest/notifications",
        None,
        &W,
        Some(json!({"recipients": ["a@b.co", "c@d.co"], "subject": "S", "body": "B", "event_id": ev["id"]})),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    assert_eq!(v["status"], "sent");
    let sent = c.mailer.recorded();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].to, ["a@b.co", "c@d.co"]);
    assert_eq!(sent[0].subject, "S");
    let (status, at): (String, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("SELECT status::text, sent_at FROM notifications WHERE id = $1::uuid")
            .bind(v["id"].as_str().unwrap())
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(status, "sent");
    assert!(at.is_some());

    let (s, _) = call_h(
        &c.app,
        Method::POST,
        "/api/v1/ingest/notifications",
        None,
        &W,
        Some(json!({"recipients": []})),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let (s, _) = call_h(
        &c.app,
        Method::POST,
        "/api/v1/ingest/notifications",
        None,
        &W,
        Some(json!({"recipients": ["nope"]})),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
}

#[sqlx::test]
async fn notification_failure_is_recorded(pool: PgPool) {
    let c = ctx_with(pool, FakeMailer::failing("smtp down")).await;
    let (s, v) = call_h(
        &c.app,
        Method::POST,
        "/api/v1/ingest/notifications",
        None,
        &W,
        Some(json!({"recipients": ["a@b.co"], "subject": "S"})),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    assert_eq!(v["status"], "failed");
    let (status, err): (String, Option<String>) =
        sqlx::query_as("SELECT status::text, error FROM notifications")
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(status, "failed");
    assert_eq!(err.as_deref(), Some("smtp down"));
}

#[sqlx::test]
async fn smtp_settings_mask_secret_and_rbac(pool: PgPool) {
    let c = ctx(pool).await;
    let uri = "/api/v1/settings/smtp";
    let (s, v) = call(&c.app, Method::GET, uri, Some(&c.admin), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["configured"], false);

    let put = json!({"host": "smtp.example.com", "port": 587, "username": "u", "password": "hunter2-smtp", "from_addr": "cam@example.com", "use_tls": true});
    let (s, v) = call(&c.app, Method::PUT, uri, Some(&c.admin), Some(put)).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["has_secret"], true);
    let (s, g) = call(&c.app, Method::GET, uri, Some(&c.admin), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(g["host"], "smtp.example.com");
    assert_eq!(g["configured"], true);
    for t in [v.to_string(), g.to_string()] {
        assert!(
            !t.contains("hunter2-smtp") && !t.contains("secret_enc") && !t.contains("password")
        );
    }

    // stored encrypted, decryptable, loaded at send time
    let blob: Vec<u8> = sqlx::query_scalar("SELECT secret_enc FROM smtp_settings")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert!(!blob.windows(12).any(|w| w == b"hunter2-smtp"));
    let key = cameraman::crypto::dev_key();
    assert_eq!(decrypt_secret(&key, &blob).unwrap(), "hunter2-smtp");
    let cfg = load_smtp_config(&c.pool, &key).await.unwrap().unwrap();
    assert_eq!(cfg.password.as_deref(), Some("hunter2-smtp"));
    assert_eq!(cfg.port, 587);

    // absent password keeps secret; empty clears
    let keep = json!({"host": "smtp2.example.com", "from_addr": "cam@example.com"});
    let (_, v) = call(&c.app, Method::PUT, uri, Some(&c.admin), Some(keep)).await;
    assert_eq!(v["has_secret"], true);
    assert_eq!(v["host"], "smtp2.example.com");
    let clear =
        json!({"host": "smtp2.example.com", "from_addr": "cam@example.com", "password": ""});
    let (_, v) = call(&c.app, Method::PUT, uri, Some(&c.admin), Some(clear)).await;
    assert_eq!(v["has_secret"], false);

    let bad = json!({"host": "", "from_addr": "cam@example.com"});
    let (s, _) = call(&c.app, Method::PUT, uri, Some(&c.admin), Some(bad)).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let bad = json!({"host": "h", "from_addr": "not-an-email"});
    let (s, _) = call(&c.app, Method::PUT, uri, Some(&c.admin), Some(bad)).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);

    for t in [&c.operator, &c.viewer] {
        let (s, _) = call(&c.app, Method::GET, uri, Some(t), None).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        let (s, _) = call(
            &c.app,
            Method::PUT,
            uri,
            Some(t),
            Some(json!({"host": "h", "from_addr": "a@b.co"})),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = 'settings.smtp.update'")
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(n, 3);
}

#[sqlx::test]
async fn device_upsert(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, a) = call(
        &c.app,
        Method::POST,
        "/api/v1/devices",
        Some(&c.viewer),
        Some(json!({"token": "tok-1", "platform": "ios"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{a}");
    let (s, b) = call(
        &c.app,
        Method::POST,
        "/api/v1/devices",
        Some(&c.viewer),
        Some(json!({"token": "tok-1", "platform": "android"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(a["id"], b["id"]);
    assert_eq!(b["platform"], "android");
    // another user claiming the token takes it over
    let (_, d) = call(
        &c.app,
        Method::POST,
        "/api/v1/devices",
        Some(&c.operator),
        Some(json!({"token": "tok-1", "platform": "ios"})),
    )
    .await;
    assert_ne!(d["user_id"], a["user_id"]);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM devices")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
    let (s, _) = call(
        &c.app,
        Method::POST,
        "/api/v1/devices",
        Some(&c.viewer),
        Some(json!({"token": " ", "platform": "ios"})),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let (s, _) = call(
        &c.app,
        Method::POST,
        "/api/v1/devices",
        None,
        Some(json!({"token": "t", "platform": "ios"})),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}
