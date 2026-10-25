mod common;

use axum::http::{Method, StatusCode};
use cameraman::workflow::RunAction;
use common::*;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test]
async fn graph_patch_updates_open_run_only_when_enabled(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, wf) = call(
        &c.app,
        Method::POST,
        "/api/v1/workflows",
        Some(&c.operator),
        Some(json!({"name": "w", "graph": good_graph()})),
    )
    .await;
    let id = wf["id"].as_str().unwrap();
    let uri = format!("/api/v1/workflows/{id}");
    let mut g = good_graph();
    g["nodes"][2]["config"]["subject"] = json!("v2");

    // disabled: no signal
    let (s, _) = call(
        &c.app,
        Method::PATCH,
        &uri,
        Some(&c.operator),
        Some(json!({"graph": g})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert!(c.run_control.recorded().is_empty());

    call(
        &c.app,
        Method::POST,
        &format!("{uri}/enable"),
        Some(&c.operator),
        None,
    )
    .await;
    assert_eq!(c.run_control.recorded().len(), 1);

    // rename only: still no update
    call(
        &c.app,
        Method::PATCH,
        &uri,
        Some(&c.operator),
        Some(json!({"name": "renamed"})),
    )
    .await;
    assert_eq!(c.run_control.recorded().len(), 1);

    let mut g3 = good_graph();
    g3["nodes"][2]["config"]["subject"] = json!("v3");
    let (s, v) = call(
        &c.app,
        Method::PATCH,
        &uri,
        Some(&c.operator),
        Some(json!({"graph": g3})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let sigs = c.run_control.recorded();
    assert_eq!(sigs.len(), 2);
    assert_eq!(sigs[1].action, RunAction::Update);
    assert_eq!(sigs[1].run_id, sigs[0].run_id);
    let new_vid: uuid::Uuid = v["active_version_id"].as_str().unwrap().parse().unwrap();
    assert_eq!(sigs[1].version_id, Some(new_vid));
    let run_v: uuid::Uuid =
        sqlx::query_scalar("SELECT version_id FROM workflow_runs WHERE id = $1")
            .bind(sigs[0].run_id.unwrap())
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(run_v, new_vid);
}
