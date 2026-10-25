mod common;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test]
async fn landmark_crud_and_audit(pool: PgPool) {
    let c = ctx(pool).await;
    let cam = insert_camera(&c.pool, "10.0.0.1").await;
    let (s, lm) = call(
        &c.app,
        Method::POST,
        "/api/v1/landmarks",
        Some(&c.operator),
        Some(json!({"camera_id": cam, "name": " door ", "box": [0.1, 0.2, 0.3, 0.4]})),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{lm}");
    assert_eq!(lm["name"], "door");
    assert_eq!(lm["box"], json!([0.1, 0.2, 0.3, 0.4]));
    assert!(lm["drift_threshold"].as_f64().unwrap() > 0.0);
    let id = lm["id"].as_str().unwrap();

    // duplicate name on the same camera
    let (s, _) = call(
        &c.app,
        Method::POST,
        "/api/v1/landmarks",
        Some(&c.operator),
        Some(json!({"camera_id": cam, "name": "door", "box": [0, 0, 1, 1]})),
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT);

    // validation
    for body in [
        json!({"camera_id": cam, "name": "", "box": [0, 0, 1, 1]}),
        json!({"camera_id": cam, "name": "x", "box": [0, 0, 1]}),
        json!({"camera_id": cam, "name": "x", "box": [0, 0, 1, 1], "drift_threshold": 2.0}),
        json!({"camera_id": cam, "name": "x", "box": [0, 0, 1, 1], "polygon": [[0, 0]]}),
        json!({"camera_id": uuid::Uuid::new_v4(), "name": "x", "box": [0, 0, 1, 1]}),
    ] {
        let (s, v) = call(
            &c.app,
            Method::POST,
            "/api/v1/landmarks",
            Some(&c.operator),
            Some(body.clone()),
        )
        .await;
        assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{body} -> {v}");
    }

    let (s, v) = call(
        &c.app,
        Method::PATCH,
        &format!("/api/v1/landmarks/{id}"),
        Some(&c.operator),
        Some(json!({"name": "front door", "similarity_threshold": 0.8,
                    "polygon": [[0, 0], [1, 0], [1, 1]]})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["name"], "front door");
    assert_eq!(v["box"], json!([0.1, 0.2, 0.3, 0.4]));
    assert!((v["similarity_threshold"].as_f64().unwrap() - 0.8).abs() < 1e-6);
    assert_eq!(v["polygon"].as_array().unwrap().len(), 3);

    // a second camera's landmark must not leak into a filtered list
    let cam2 = insert_camera(&c.pool, "10.0.0.2").await;
    call(
        &c.app,
        Method::POST,
        "/api/v1/landmarks",
        Some(&c.operator),
        Some(json!({"camera_id": cam2, "name": "gate", "box": {"x":0,"y":0,"w":1,"h":1}})),
    )
    .await;
    let (s, list) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/landmarks?camera={cam}"),
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["name"], "front door");
    let (_, all) = call(
        &c.app,
        Method::GET,
        "/api/v1/landmarks",
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(all.as_array().unwrap().len(), 2);

    let (s, _) = call(
        &c.app,
        Method::DELETE,
        &format!("/api/v1/landmarks/{id}"),
        Some(&c.operator),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = call(
        &c.app,
        Method::DELETE,
        &format!("/api/v1/landmarks/{id}"),
        Some(&c.operator),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = call(
        &c.app,
        Method::PATCH,
        &format!("/api/v1/landmarks/{id}"),
        Some(&c.operator),
        Some(json!({"name": "z"})),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    for (a, n) in [
        ("landmark.create", 2),
        ("landmark.update", 1),
        ("landmark.delete", 1),
    ] {
        let got: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = $1")
            .bind(a)
            .fetch_one(&c.pool)
            .await
            .unwrap();
        assert_eq!(got, n, "{a}");
    }
}

#[sqlx::test]
async fn landmark_rbac(pool: PgPool) {
    let c = ctx(pool).await;
    let cam = insert_camera(&c.pool, "10.0.0.1").await;
    let body = json!({"camera_id": cam, "name": "door", "box": [0, 0, 1, 1]});
    let (s, _) = call(
        &c.app,
        Method::POST,
        "/api/v1/landmarks",
        None,
        Some(body.clone()),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = call(
        &c.app,
        Method::POST,
        "/api/v1/landmarks",
        Some(&c.viewer),
        Some(body.clone()),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (_, lm) = call(
        &c.app,
        Method::POST,
        "/api/v1/landmarks",
        Some(&c.operator),
        Some(body),
    )
    .await;
    let uri = format!("/api/v1/landmarks/{}", lm["id"].as_str().unwrap());
    let (s, _) = call(
        &c.app,
        Method::PATCH,
        &uri,
        Some(&c.viewer),
        Some(json!({"name": "q"})),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = call(&c.app, Method::DELETE, &uri, Some(&c.viewer), None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = call(&c.app, Method::GET, "/api/v1/landmarks", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}
