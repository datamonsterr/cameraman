//! Redis / WebSocket integration tests. Need a Redis at `REDIS_URL`
//! (default `redis://localhost:6399` locally; CI provides one).
mod common;

use std::time::Duration;

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use common::*;
use futures_util::StreamExt;
use http_body_util::BodyExt;
use redis::AsyncCommands;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tower::ServiceExt;
use uuid::Uuid;

const W: [(&str, &str); 1] = [("x-worker-token", "test-worker-token")];
const T: Duration = Duration::from_secs(5);

fn media() -> String {
    std::env::temp_dir()
        .join(format!("cameraman-media-{}", Uuid::new_v4()))
        .to_string_lossy()
        .into_owned()
}

async fn redis_con() -> redis::aio::MultiplexedConnection {
    redis::Client::open(redis_url())
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap()
}

async fn ingest_event(c: &Ctx, body: Value) -> i64 {
    let (s, v) = call_h(
        &c.app,
        Method::POST,
        "/api/v1/ingest/events",
        None,
        &W,
        Some(body),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    v["id"].as_i64().unwrap()
}

#[sqlx::test]
async fn enable_update_disable_push_run_control_to_redis(pool: PgPool) {
    let c = ctx_wired(pool, &media()).await;
    let (s, cam) = call(
        &c.app,
        Method::POST,
        "/api/v1/cameras",
        Some(&c.operator),
        Some(
            json!({"name": "front", "host": "10.1.2.3", "port": 8554, "rtsp_path": "/live",
                    "rtsp_username": "admin", "rtsp_password": "p@ss w0rd"}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{cam}");
    let cam_id = cam["id"].as_str().unwrap();
    let (s, _) = call(
        &c.app,
        Method::POST,
        "/api/v1/landmarks",
        Some(&c.operator),
        Some(
            json!({"camera_id": cam_id, "name": "door", "box": {"x":0.1,"y":0.2,"w":0.3,"h":0.4},
                    "drift_threshold": 0.05}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);
    let mut graph = good_graph();
    graph["nodes"][0]["config"] = json!({"camera_id": cam_id, "fps": 5});
    let (_, wf) = call(
        &c.app,
        Method::POST,
        "/api/v1/workflows",
        Some(&c.operator),
        Some(json!({"name": "w", "graph": graph})),
    )
    .await;
    let wid = wf["id"].as_str().unwrap();
    let uri = format!("/api/v1/workflows/{wid}");
    call(
        &c.app,
        Method::POST,
        &format!("{uri}/enable"),
        Some(&c.operator),
        None,
    )
    .await;
    let (_, runs) = call(
        &c.app,
        Method::GET,
        &format!("{uri}/runs"),
        Some(&c.viewer),
        None,
    )
    .await;
    let run_id = runs[0]["id"].as_str().unwrap().to_string();

    let mut con = redis_con().await;
    let find = |items: Vec<String>, action: &str| {
        items
            .iter()
            .filter_map(|s| serde_json::from_str::<Value>(s).ok())
            .find(|v| v["run_id"] == run_id.as_str() && v["action"] == action)
    };
    let items: Vec<String> = con.lrange("cameraman:runs:control", 0, -1).await.unwrap();
    let start = find(items, "start").expect("start command pushed");
    assert_eq!(start["workflow_id"], wid);
    assert_eq!(start["graph"]["nodes"][0]["type"], "camera");
    assert_eq!(start["cameras"].as_array().unwrap().len(), 1);
    let rc = &start["cameras"][0];
    assert_eq!(rc["id"], cam_id);
    assert_eq!(rc["name"], "front");
    assert_eq!(
        rc["rtsp_url"],
        "rtsp://admin:p%40ss%20w0rd@10.1.2.3:8554/live"
    );
    assert_eq!(rc["transport"], "tcp");
    assert_eq!(rc["fps"], 5.0);
    let lm = &start["landmarks"][0];
    assert_eq!(lm["name"], "door");
    assert_eq!(lm["camera_id"], cam_id);
    assert_eq!(lm["box"], json!([0.1, 0.2, 0.3, 0.4]));
    assert_eq!(lm["drift_threshold"], 0.05);
    assert_eq!(lm["similarity_threshold"], 0.6);
    let desired: Option<String> = con.hget("cameraman:runs:desired", &run_id).await.unwrap();
    let desired: Value = serde_json::from_str(&desired.expect("desired set")).unwrap();
    assert_eq!(desired["action"], "start");

    // graph change -> update command
    let mut g2 = graph.clone();
    g2["nodes"][2]["config"]["subject"] = json!("v2");
    call(
        &c.app,
        Method::PATCH,
        &uri,
        Some(&c.operator),
        Some(json!({"graph": g2})),
    )
    .await;
    let items: Vec<String> = con.lrange("cameraman:runs:control", 0, -1).await.unwrap();
    let upd = find(items, "update").expect("update command pushed");
    assert_eq!(upd["graph"]["nodes"][2]["config"]["subject"], "v2");
    assert_ne!(upd["version_id"], start["version_id"]);

    call(
        &c.app,
        Method::POST,
        &format!("{uri}/disable"),
        Some(&c.operator),
        None,
    )
    .await;
    let items: Vec<String> = con.lrange("cameraman:runs:control", 0, -1).await.unwrap();
    let stop = find(items, "stop").expect("stop command pushed");
    assert_eq!(stop, json!({"action": "stop", "run_id": run_id}));
    let desired: Option<String> = con.hget("cameraman:runs:desired", &run_id).await.unwrap();
    assert!(desired.is_none(), "desired entry removed on stop");
}

#[sqlx::test]
async fn ingested_event_is_published_to_redis(pool: PgPool) {
    let c = ctx_wired(pool, &media()).await;
    let mut ps = redis::Client::open(redis_url())
        .unwrap()
        .get_async_pubsub()
        .await
        .unwrap();
    ps.subscribe("cameraman:events").await.unwrap();
    let mut msgs = ps.on_message();
    let id = ingest_event(&c, json!({"kind": "system", "message": "hello-redis"})).await;
    loop {
        let m = timeout(T, msgs.next())
            .await
            .expect("event published")
            .unwrap();
        let v: Value = serde_json::from_slice(m.get_payload_bytes()).unwrap();
        if v["id"] == id {
            assert_eq!(v["message"], "hello-redis");
            assert_eq!(v["kind"], "system");
            assert!(v["detections"].is_array());
            break;
        }
    }
}

#[sqlx::test]
async fn ws_events_forwards_published_events(pool: PgPool) {
    let c = ctx_wired(pool, &media()).await;
    let addr = serve(c.app.clone()).await;
    let url = format!("ws://{addr}/api/v1/ws/events?token={}", c.viewer);
    let (mut ws, _) = connect_async(url).await.unwrap();
    let id = ingest_event(&c, json!({"kind": "system", "message": "live"})).await;
    loop {
        let m = timeout(T, ws.next())
            .await
            .expect("frame")
            .unwrap()
            .unwrap();
        let Message::Text(t) = m else { continue };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["id"] == id {
            assert_eq!(v["message"], "live");
            break;
        }
    }
}

#[sqlx::test]
async fn ws_rejects_missing_or_bad_token(pool: PgPool) {
    let c = ctx_wired(pool, &media()).await;
    let cam = insert_camera(&c.pool, "10.0.0.1").await;
    let addr = serve(c.app.clone()).await;
    for url in [
        format!("ws://{addr}/api/v1/ws/events"),
        format!("ws://{addr}/api/v1/ws/events?token=garbage"),
        format!("ws://{addr}/api/v1/cameras/{cam}/stream"),
        format!("ws://{addr}/api/v1/cameras/{cam}/stream?token=garbage"),
    ] {
        match connect_async(url.clone()).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(r)) => {
                assert_eq!(r.status(), 401, "{url}")
            }
            other => panic!("{url}: expected 401, got {:?}", other.map(|_| ())),
        }
    }
    // unknown camera with a valid token
    let url = format!(
        "ws://{addr}/api/v1/cameras/{}/stream?token={}",
        Uuid::new_v4(),
        c.viewer
    );
    match connect_async(url).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) => assert_eq!(r.status(), 404),
        other => panic!("expected 404, got {:?}", other.map(|_| ())),
    }
}

#[sqlx::test]
async fn camera_stream_forwards_binary_frames(pool: PgPool) {
    let c = ctx_wired(pool, &media()).await;
    let cam = insert_camera(&c.pool, "10.0.0.1").await;
    let other = insert_camera(&c.pool, "10.0.0.2").await;
    let addr = serve(c.app.clone()).await;
    let url = format!("ws://{addr}/api/v1/cameras/{cam}/stream?token={}", c.viewer);
    let (mut ws, _) = connect_async(url).await.unwrap();
    let mut con = redis_con().await;
    let _: i64 = con
        .publish(format!("cameraman:camera:{other}:frames"), vec![9u8, 9])
        .await
        .unwrap();
    let jpeg = vec![0xffu8, 0xd8, 0xff, 0x00, 0xd9];
    let _: i64 = con
        .publish(format!("cameraman:camera:{cam}:frames"), jpeg.clone())
        .await
        .unwrap();
    let m = timeout(T, ws.next())
        .await
        .expect("frame")
        .unwrap()
        .unwrap();
    assert_eq!(m, Message::Binary(jpeg.into()));
}

#[sqlx::test]
async fn live_snapshot_serves_latest_frame(pool: PgPool) {
    let c = ctx_wired(pool, &media()).await;
    let cam = Uuid::new_v4();
    let uri = format!("/api/v1/cameras/{cam}/snapshot");
    let get = |token: Option<&'static str>, uri: String| {
        let app = c.app.clone();
        async move {
            let mut b = Request::builder().uri(uri);
            if let Some(t) = token {
                b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
            }
            let r = app.oneshot(b.body(Body::empty()).unwrap()).await.unwrap();
            let s = r.status();
            let ct = r
                .headers()
                .get(header::CONTENT_TYPE)
                .map(|v| v.to_str().unwrap().to_string());
            (s, ct, r.into_body().collect().await.unwrap().to_bytes())
        }
    };
    let viewer: &'static str = Box::leak(c.viewer.clone().into_boxed_str());
    let (s, _, _) = get(Some(viewer), uri.clone()).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _, _) = get(None, uri.clone()).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    let jpeg = vec![0xffu8, 0xd8, 0xff, 0xd9];
    let mut con = redis_con().await;
    let key = format!("cameraman:camera:{cam}:latest");
    let _: () = con.set_ex(&key, jpeg.clone(), 30).await.unwrap();
    let (s, ct, body) = get(Some(viewer), uri).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(ct.as_deref(), Some("image/jpeg"));
    assert_eq!(body.to_vec(), jpeg);
    let _: () = con.del(key).await.unwrap();
}
