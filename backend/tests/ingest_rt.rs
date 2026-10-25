mod common;

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use common::*;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;

const W: [(&str, &str); 1] = [("x-worker-token", "test-worker-token")];
/// base64 of FF D8 FF D9.
const TINY_JPEG: &str = "/9j/2Q==";

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

fn temp_media() -> String {
    let d = std::env::temp_dir().join(format!("cameraman-media-{}", uuid::Uuid::new_v4()));
    d.to_string_lossy().into_owned()
}

async fn get_raw(c: &Ctx, uri: &str, token: Option<&str>) -> (StatusCode, Option<String>, Vec<u8>) {
    let mut b = Request::builder().method(Method::GET).uri(uri);
    if let Some(t) = token {
        b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let resp = c
        .app
        .clone()
        .oneshot(b.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let ct = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .map(|v| v.to_str().unwrap().to_string());
    let bytes = resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, ct, bytes)
}

#[sqlx::test]
async fn snapshot_jpeg_is_stored_and_served(pool: PgPool) {
    let dir = temp_media();
    let d = dir.clone();
    let c = ctx_cfg(pool, Default::default(), move |cfg| cfg.media_dir = d).await;
    let cam = insert_camera(&c.pool, "10.0.0.1").await;
    let (s, v) = ingest(
        &c,
        json!({"kind": "detection", "camera_id": cam, "snapshot_jpeg": TINY_JPEG}),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    let id = v["id"].as_i64().unwrap();
    let (snap_id, path): (uuid::Uuid, String) = sqlx::query_as(
        "SELECT s.id, s.path FROM events e JOIN snapshots s ON s.id = e.snapshot_id WHERE e.id = $1",
    )
    .bind(id)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(path, format!("snapshots/{snap_id}.jpg"));
    let on_disk = std::fs::read(std::path::Path::new(&dir).join(&path)).unwrap();
    assert_eq!(on_disk, vec![0xff, 0xd8, 0xff, 0xd9]);

    let (s, ct, body) = get_raw(&c, &format!("/api/v1/snapshots/{snap_id}"), Some(&c.viewer)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(ct.as_deref(), Some("image/jpeg"));
    assert_eq!(body, on_disk);

    let (s, _, _) = get_raw(&c, &format!("/api/v1/snapshots/{snap_id}"), None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _, _) = get_raw(
        &c,
        &format!("/api/v1/snapshots/{}", uuid::Uuid::new_v4()),
        Some(&c.viewer),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // file removed -> 404
    std::fs::remove_file(std::path::Path::new(&dir).join(&path)).unwrap();
    let (s, _, _) = get_raw(&c, &format!("/api/v1/snapshots/{snap_id}"), Some(&c.viewer)).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // bad base64 -> 422, nothing written
    let (s, _) = ingest(&c, json!({"kind": "system", "snapshot_jpeg": "%%%"})).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let _ = std::fs::remove_dir_all(dir);
}

#[sqlx::test]
async fn failed_ingest_leaves_no_file(pool: PgPool) {
    let dir = temp_media();
    let d = dir.clone();
    let c = ctx_cfg(pool, Default::default(), move |cfg| cfg.media_dir = d).await;
    let (s, _) = ingest(
        &c,
        json!({"kind": "detection", "camera_id": uuid::Uuid::new_v4(), "snapshot_jpeg": TINY_JPEG}),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let left = std::fs::read_dir(std::path::Path::new(&dir).join("snapshots"))
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(left, 0);
    let _ = std::fs::remove_dir_all(dir);
}

#[sqlx::test]
async fn calibration_records_row_and_moves_box(pool: PgPool) {
    let c = ctx(pool).await;
    let cam = insert_camera(&c.pool, "10.0.0.1").await;
    let (_, lm) = call(
        &c.app,
        Method::POST,
        "/api/v1/landmarks",
        Some(&c.operator),
        Some(json!({"camera_id": cam, "name": "door", "box": [0.1, 0.1, 0.2, 0.2]})),
    )
    .await;
    let lid: uuid::Uuid = lm["id"].as_str().unwrap().parse().unwrap();
    let (s, v) = ingest(
        &c,
        json!({"kind": "calibration", "camera_id": cam, "payload": {
            "landmark": "door", "old_box": [0.1, 0.1, 0.2, 0.2],
            "new_box": [0.12, 0.1, 0.2, 0.2], "similarity": 0.91}}),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    let (old, new, sim): (Value, Value, Option<f32>) = sqlx::query_as(
        "SELECT old_box, new_box, similarity FROM landmark_calibrations WHERE landmark_id = $1",
    )
    .bind(lid)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(old, json!([0.1, 0.1, 0.2, 0.2]));
    assert_eq!(new, json!([0.12, 0.1, 0.2, 0.2]));
    assert!((sim.unwrap() - 0.91).abs() < 1e-6);
    let (_, list) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/landmarks?camera={cam}"),
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(list[0]["box"], json!([0.12, 0.1, 0.2, 0.2]));
    assert_eq!(c.events.recorded().len(), 1);

    // unknown landmark / malformed payload -> 422 and no event kept
    for p in [
        json!({"landmark": "nope", "old_box": [0,0,1,1], "new_box": [0,0,1,1]}),
        json!({"landmark": "door"}),
    ] {
        let (s, _) = ingest(
            &c,
            json!({"kind": "calibration", "camera_id": cam, "payload": p}),
        )
        .await;
        assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE kind = 'calibration'")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[sqlx::test]
async fn health_updates_status_and_alerts_once_when_prolonged(pool: PgPool) {
    let c = ctx(pool).await;
    let cam = insert_camera(&c.pool, "10.0.0.1").await;
    let health =
        |state: &str| json!({"kind": "health", "camera_id": cam, "payload": {"state": state}});
    let status = || async {
        sqlx::query_scalar::<_, String>("SELECT status::text FROM cameras WHERE id = $1")
            .bind(cam)
            .fetch_one(&c.pool)
            .await
            .unwrap()
    };
    let history = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM camera_status_history WHERE camera_id = $1",
        )
        .bind(cam)
        .fetch_one(&c.pool)
        .await
        .unwrap()
    };
    let alerts = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM events WHERE camera_id = $1 AND kind = 'health' AND severity = 'alert'",
        )
        .bind(cam)
        .fetch_one(&c.pool)
        .await
        .unwrap()
    };

    assert_eq!(ingest(&c, health("online")).await.0, StatusCode::CREATED);
    assert_eq!(status().await, "online");
    let h = history().await;
    assert_eq!(ingest(&c, health("online")).await.0, StatusCode::CREATED);
    assert_eq!(history().await, h, "no history row without a change");

    assert_eq!(ingest(&c, health("offline")).await.0, StatusCode::CREATED);
    assert_eq!(status().await, "offline");
    assert_eq!(alerts().await, 0, "fresh outage is not an alert");

    sqlx::query(
        "UPDATE camera_status_history SET created_at = now() - interval '10 minutes' \
         WHERE camera_id = $1 AND status = 'offline'",
    )
    .bind(cam)
    .execute(&c.pool)
    .await
    .unwrap();
    assert_eq!(ingest(&c, health("offline")).await.0, StatusCode::CREATED);
    assert_eq!(alerts().await, 1);
    let last = c.events.recorded().pop().unwrap();
    assert_eq!(last.event.severity, "alert");
    assert_eq!(ingest(&c, health("offline")).await.0, StatusCode::CREATED);
    assert_eq!(alerts().await, 1, "alert raised once per outage");

    assert_eq!(ingest(&c, health("online")).await.0, StatusCode::CREATED);
    assert_eq!(status().await, "online");
    let (s, _) = ingest(&c, health("bogus")).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
}
