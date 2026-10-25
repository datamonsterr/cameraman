mod common;

use axum::http::{Method, StatusCode};
use cameraman::workflow::{RunAction, RunStatus};
use common::*;
use serde_json::json;
use sqlx::PgPool;

async fn create_wf(c: &Ctx) -> serde_json::Value {
    let (s, v) = call(
        &c.app,
        Method::POST,
        "/api/v1/workflows",
        Some(&c.operator),
        Some(json!({"name": "Door watch", "description": "d", "graph": good_graph()})),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    v
}

#[sqlx::test]
async fn create_list_get_versions(pool: PgPool) {
    let c = ctx(pool).await;
    let wf = create_wf(&c).await;
    assert_eq!(wf["active_version"], 1);
    assert_eq!(wf["enabled"], false);
    assert_eq!(wf["graph"], good_graph());
    let id = wf["id"].as_str().unwrap();

    let (s, list) = call(
        &c.app,
        Method::GET,
        "/api/v1/workflows",
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert!(list[0].get("graph").is_none());

    let (s, one) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/workflows/{id}"),
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(one["graph"], good_graph());

    let (s, vs) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/workflows/{id}/versions"),
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(vs.as_array().unwrap().len(), 1);
    assert_eq!(vs[0]["version"], 1);

    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = 'workflow.create'")
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(n, 1);

    let (s, _) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/workflows/{}", uuid::Uuid::new_v4()),
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn invalid_graph_is_422_with_details(pool: PgPool) {
    let c = ctx(pool).await;
    let mut g = good_graph();
    g["edges"].as_array_mut().unwrap().pop();
    let (s, v) = call(
        &c.app,
        Method::POST,
        "/api/v1/workflows",
        Some(&c.operator),
        Some(json!({"name": "x", "graph": g})),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    assert_eq!(v["details"][0]["code"], "dangling_input");
    assert_eq!(v["details"][0]["node_id"], "mail");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM workflows")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[sqlx::test]
async fn patch_bumps_version_only_on_graph_change(pool: PgPool) {
    let c = ctx(pool).await;
    let wf = create_wf(&c).await;
    let id = wf["id"].as_str().unwrap();
    let uri = format!("/api/v1/workflows/{id}");

    let (s, v) = call(
        &c.app,
        Method::PATCH,
        &uri,
        Some(&c.operator),
        Some(json!({"name": "Renamed"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["name"], "Renamed");
    assert_eq!(v["active_version"], 1);

    let mut g = good_graph();
    g["nodes"][2]["config"]["subject"] = json!("changed");
    let (s, v) = call(
        &c.app,
        Method::PATCH,
        &uri,
        Some(&c.operator),
        Some(json!({"graph": g})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["active_version"], 2);
    assert_eq!(v["graph"]["nodes"][2]["config"]["subject"], "changed");

    let (_, vs) = call(
        &c.app,
        Method::GET,
        &format!("{uri}/versions"),
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(vs.as_array().unwrap().len(), 2);
    assert_eq!(vs[0]["version"], 2);
    // version 1 is immutable
    assert_eq!(vs[1]["graph"], good_graph());

    let (s, v) = call(
        &c.app,
        Method::PATCH,
        &uri,
        Some(&c.operator),
        Some(json!({"graph": {"nodes": "x"}})),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let (_, v) = call(&c.app, Method::GET, &uri, Some(&c.viewer), None).await;
    assert_eq!(v["active_version"], 2);

    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = 'workflow.update'")
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(n, 2);
}

#[sqlx::test]
async fn enable_disable_toggles_runs_and_signals(pool: PgPool) {
    let c = ctx(pool).await;
    let wf = create_wf(&c).await;
    let id = wf["id"].as_str().unwrap();
    let wid: uuid::Uuid = id.parse().unwrap();

    let (s, v) = call(
        &c.app,
        Method::POST,
        &format!("/api/v1/workflows/{id}/enable"),
        Some(&c.operator),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["enabled"], true);
    let (_, runs) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/workflows/{id}/runs"),
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(runs.as_array().unwrap().len(), 1);
    assert_eq!(runs[0]["status"], "starting");
    let run_id: uuid::Uuid = runs[0]["id"].as_str().unwrap().parse().unwrap();
    let sigs = c.run_control.recorded();
    assert_eq!(sigs.len(), 1);
    assert_eq!(sigs[0].action, RunAction::Start);
    assert_eq!(sigs[0].workflow_id, wid);
    assert_eq!(sigs[0].run_id, Some(run_id));

    // idempotent
    call(
        &c.app,
        Method::POST,
        &format!("/api/v1/workflows/{id}/enable"),
        Some(&c.operator),
        None,
    )
    .await;
    assert_eq!(c.run_control.recorded().len(), 1);

    let (s, v) = call(
        &c.app,
        Method::POST,
        &format!("/api/v1/workflows/{id}/disable"),
        Some(&c.operator),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["enabled"], false);
    let status: RunStatus = sqlx::query_scalar("SELECT status FROM workflow_runs WHERE id = $1")
        .bind(run_id)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(status, RunStatus::Stopped);
    let (_, runs) = call(
        &c.app,
        Method::GET,
        &format!("/api/v1/workflows/{id}/runs"),
        Some(&c.viewer),
        None,
    )
    .await;
    assert!(runs[0]["stopped_at"].is_string());
    let sigs = c.run_control.recorded();
    assert_eq!(sigs.len(), 2);
    assert_eq!(sigs[1].action, RunAction::Stop);
    assert_eq!(sigs[1].run_id, Some(run_id));

    for a in ["workflow.enable", "workflow.disable"] {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = $1")
            .bind(a)
            .fetch_one(&c.pool)
            .await
            .unwrap();
        assert_eq!(n, 1, "{a}");
    }
}

#[sqlx::test]
async fn rbac(pool: PgPool) {
    let c = ctx(pool).await;
    let wf = create_wf(&c).await;
    let id = wf["id"].as_str().unwrap();
    let uri = format!("/api/v1/workflows/{id}");
    let body = json!({"name": "n", "graph": good_graph()});
    for (m, u, b) in [
        (Method::POST, "/api/v1/workflows".to_string(), Some(body)),
        (Method::PATCH, uri.clone(), Some(json!({"name": "z"}))),
        (Method::POST, format!("{uri}/enable"), None),
        (Method::POST, format!("{uri}/disable"), None),
    ] {
        let (s, _) = call(&c.app, m.clone(), &u, Some(&c.viewer), b.clone()).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{m} {u}");
        let (s, _) = call(&c.app, m, &u, None, b).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }
    for u in [
        uri.clone(),
        format!("{uri}/versions"),
        format!("{uri}/runs"),
        "/api/v1/workflows".into(),
    ] {
        let (s, _) = call(&c.app, Method::GET, &u, Some(&c.viewer), None).await;
        assert_eq!(s, StatusCode::OK, "{u}");
    }
}

#[sqlx::test]
async fn node_types_seeded_and_listed(pool: PgPool) {
    let c = ctx(pool).await;
    let st = cameraman::AppState {
        pool: c.pool.clone(),
        config: std::sync::Arc::new(cameraman::config::Config::for_test()),
    };
    cameraman::seed(&st).await.unwrap();
    cameraman::seed(&st).await.unwrap(); // idempotent
    let (s, v) = call(
        &c.app,
        Method::GET,
        "/api/v1/node-types",
        Some(&c.viewer),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let ids: Vec<_> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 3);
    assert!(ids.contains(&"camera") && ids.contains(&"codeblock") && ids.contains(&"email"));
    assert!(v[0]["descriptor"]["config"].is_object());
    let (s, _) = call(&c.app, Method::GET, "/api/v1/node-types", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}
