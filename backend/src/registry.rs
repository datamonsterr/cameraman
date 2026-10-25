//! Node-type registry (ADR-0006): embedded seed, DB upsert, and server-side
//! graph validation mirroring the worker (`cameraman_worker/graph.py`).

use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

use axum::{extract::State, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    error::{AppError, AppResult},
    extract::AuthUser,
    AppState,
};

const EMBEDDED: &str = include_str!("../assets/node_types.json");

#[derive(Debug, Clone, Deserialize)]
pub struct Port {
    pub id: String,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default = "yes")]
    pub required: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone)]
pub struct NodeType {
    pub id: String,
    pub category: String,
    pub title: String,
    pub inputs: Vec<Port>,
    pub outputs: Vec<Port>,
    pub config: Value,
    /// Raw descriptor as stored in `node_types.descriptor`.
    pub descriptor: Value,
}

#[derive(Debug, Clone, Default)]
pub struct NodeRegistry {
    types: HashMap<String, NodeType>,
    order: Vec<String>,
}

impl NodeRegistry {
    pub fn from_json(raw: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let list = v
            .get("node_types")
            .and_then(Value::as_array)
            .ok_or("node_types array missing")?;
        let mut reg = Self::default();
        for t in list {
            let id = t["id"].as_str().ok_or("node type id missing")?.to_string();
            let d = t.get("descriptor").cloned().unwrap_or_else(|| json!({}));
            let ports = |k: &str| -> Result<Vec<Port>, String> {
                serde_json::from_value(d.get(k).cloned().unwrap_or_else(|| json!([])))
                    .map_err(|e| format!("{id}.{k}: {e}"))
            };
            reg.order.push(id.clone());
            reg.types.insert(
                id.clone(),
                NodeType {
                    category: t["category"].as_str().unwrap_or("").into(),
                    title: t["title"].as_str().unwrap_or("").into(),
                    inputs: ports("inputs")?,
                    outputs: ports("outputs")?,
                    config: d.get("config").cloned().unwrap_or_else(|| json!({})),
                    descriptor: d,
                    id,
                },
            );
        }
        Ok(reg)
    }

    pub fn get(&self, id: &str) -> Option<&NodeType> {
        self.types.get(id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &NodeType> {
        self.order.iter().filter_map(|i| self.types.get(i))
    }
}

/// The registry shipped in the binary (`assets/node_types.json`).
pub fn embedded() -> &'static NodeRegistry {
    static REG: OnceLock<NodeRegistry> = OnceLock::new();
    REG.get_or_init(|| NodeRegistry::from_json(EMBEDDED).expect("embedded node_types.json invalid"))
}

/// Idempotent upsert of the embedded registry into `node_types`.
pub async fn seed_node_types(pool: &PgPool) -> AppResult<()> {
    for t in embedded().iter() {
        sqlx::query(
            "INSERT INTO node_types (id, category, title, descriptor) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (id) DO UPDATE SET category = EXCLUDED.category, \
             title = EXCLUDED.title, descriptor = EXCLUDED.descriptor",
        )
        .bind(&t.id)
        .bind(&t.category)
        .bind(&t.title)
        .bind(&t.descriptor)
        .execute(pool)
        .await?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct NodeTypeRow {
    pub id: String,
    pub category: String,
    pub title: String,
    pub descriptor: Value,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/", get(list))
}

async fn list(_u: AuthUser, State(st): State<AppState>) -> AppResult<Json<Vec<NodeTypeRow>>> {
    let rows = sqlx::query_as(
        "SELECT id, category, title, descriptor FROM node_types ORDER BY category, id",
    )
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(rows))
}

// ------------------------------------------------------------ validation

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GraphIssue {
    pub code: &'static str,
    pub message: String,
    pub node_id: Option<String>,
}

impl GraphIssue {
    fn new(code: &'static str, message: impl Into<String>, node_id: Option<&str>) -> Self {
        Self {
            code,
            message: message.into(),
            node_id: node_id.map(str::to_string),
        }
    }
}

#[derive(Deserialize)]
struct GNode {
    id: String,
    #[serde(rename = "type")]
    ty: String,
    #[serde(default)]
    config: serde_json::Map<String, Value>,
}

#[derive(Deserialize)]
struct GEdge {
    #[serde(default)]
    id: String,
    source: String,
    target: String,
    #[serde(rename = "sourceHandle", alias = "source_handle")]
    source_handle: String,
    #[serde(rename = "targetHandle", alias = "target_handle")]
    target_handle: String,
}

#[derive(Deserialize)]
struct GGraph {
    #[serde(default)]
    nodes: Vec<GNode>,
    #[serde(default)]
    edges: Vec<GEdge>,
}

fn type_ok(v: &Value, t: &str) -> bool {
    match t {
        "string" => v.is_string(),
        "integer" => v.is_i64() || v.is_u64(),
        "number" => v.is_number(),
        "boolean" => v.is_boolean(),
        "array" => v.is_array(),
        "object" => v.is_object(),
        _ => true,
    }
}

fn check_config(node: &GNode, schema: &Value, out: &mut Vec<GraphIssue>) {
    let id = Some(node.id.as_str());
    for key in schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        match node.config.get(key) {
            None | Some(Value::Null) => out.push(GraphIssue::new(
                "missing_config",
                format!("missing required config '{key}'"),
                id,
            )),
            Some(Value::String(s)) if s.is_empty() => out.push(GraphIssue::new(
                "missing_config",
                format!("missing required config '{key}'"),
                id,
            )),
            _ => {}
        }
    }
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return;
    };
    for (key, spec) in props {
        let Some(v) = node.config.get(key) else {
            continue;
        };
        if let Some(t) = spec.get("type").and_then(Value::as_str) {
            if !type_ok(v, t) {
                out.push(GraphIssue::new(
                    "bad_config",
                    format!("'{key}' must be {t}"),
                    id,
                ));
                continue;
            }
        }
        if let Some(n) = v.as_f64() {
            if spec
                .get("minimum")
                .and_then(Value::as_f64)
                .is_some_and(|m| n < m)
            {
                out.push(GraphIssue::new(
                    "bad_config",
                    format!("'{key}' below minimum"),
                    id,
                ));
            }
            if spec
                .get("maximum")
                .and_then(Value::as_f64)
                .is_some_and(|m| n > m)
            {
                out.push(GraphIssue::new(
                    "bad_config",
                    format!("'{key}' above maximum"),
                    id,
                ));
            }
        }
        if let (Some(arr), Some(it)) = (
            v.as_array(),
            spec.pointer("/items/type").and_then(Value::as_str),
        ) {
            if !arr.iter().all(|x| type_ok(x, it)) {
                out.push(GraphIssue::new(
                    "bad_config",
                    format!("'{key}' items must be {it}"),
                    id,
                ));
            }
        }
    }
}

/// Validate a workflow graph against the registry. Empty result = valid.
/// Rules mirror the worker: known types, required/typed config, known ports,
/// port type compatibility, no dangling required inputs, no cycles.
pub fn validate_graph(graph: &Value, reg: &NodeRegistry) -> Vec<GraphIssue> {
    let mut out = Vec::new();
    let g: GGraph = match serde_json::from_value(graph.clone()) {
        Ok(g) => g,
        Err(e) => return vec![GraphIssue::new("malformed", e.to_string(), None)],
    };

    let mut by_id: HashMap<&str, &GNode> = HashMap::new();
    for n in &g.nodes {
        if by_id.insert(n.id.as_str(), n).is_some() {
            out.push(GraphIssue::new(
                "duplicate_id",
                format!("duplicate node id '{}'", n.id),
                Some(&n.id),
            ));
        }
        match reg.get(&n.ty) {
            None => out.push(GraphIssue::new(
                "unknown_type",
                format!("unknown node type '{}'", n.ty),
                Some(&n.id),
            )),
            Some(t) => check_config(n, &t.config, &mut out),
        }
    }

    let mut wired: HashSet<(&str, &str)> = HashSet::new();
    for e in &g.edges {
        let (Some(src), Some(dst)) = (by_id.get(e.source.as_str()), by_id.get(e.target.as_str()))
        else {
            out.push(GraphIssue::new(
                "bad_edge",
                format!("edge '{}' references unknown node", e.id),
                None,
            ));
            continue;
        };
        let (Some(st), Some(dt)) = (reg.get(&src.ty), reg.get(&dst.ty)) else {
            continue;
        };
        let sp = st.outputs.iter().find(|p| p.id == e.source_handle);
        let dp = dt.inputs.iter().find(|p| p.id == e.target_handle);
        let (Some(sp), Some(dp)) = (sp, dp) else {
            out.push(GraphIssue::new(
                "bad_edge",
                format!("edge '{}' uses unknown port", e.id),
                None,
            ));
            continue;
        };
        wired.insert((dst.id.as_str(), dp.id.as_str()));
        if sp.ty != dp.ty {
            out.push(GraphIssue::new(
                "type_mismatch",
                format!("edge '{}': {} -> {}", e.id, sp.ty, dp.ty),
                Some(&dst.id),
            ));
        }
    }

    for n in &g.nodes {
        let Some(t) = reg.get(&n.ty) else { continue };
        for p in t.inputs.iter().filter(|p| p.required) {
            if !wired.contains(&(n.id.as_str(), p.id.as_str())) {
                out.push(GraphIssue::new(
                    "dangling_input",
                    format!("required input '{}' not wired", p.id),
                    Some(&n.id),
                ));
            }
        }
    }

    if has_cycle(&g, &by_id) {
        out.push(GraphIssue::new("cycle", "graph contains a cycle", None));
    }
    out
}

/// Kahn's algorithm over edges whose endpoints exist.
fn has_cycle(g: &GGraph, ids: &HashMap<&str, &GNode>) -> bool {
    let mut indeg: HashMap<&str, usize> = ids.keys().map(|k| (*k, 0)).collect();
    let mut out: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in &g.edges {
        if ids.contains_key(e.source.as_str()) && ids.contains_key(e.target.as_str()) {
            out.entry(e.source.as_str())
                .or_default()
                .push(e.target.as_str());
            *indeg.get_mut(e.target.as_str()).expect("present") += 1;
        }
    }
    let mut ready: Vec<&str> = indeg
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(k, _)| *k)
        .collect();
    let mut seen = 0;
    while let Some(cur) = ready.pop() {
        seen += 1;
        for nxt in out.get(cur).into_iter().flatten() {
            let d = indeg.get_mut(nxt).expect("present");
            *d -= 1;
            if *d == 0 {
                ready.push(nxt);
            }
        }
    }
    seen != ids.len()
}

/// `Ok` when valid, otherwise a 422 whose `details` lists every issue.
pub fn check_graph(graph: &Value, reg: &NodeRegistry) -> AppResult<()> {
    let issues = validate_graph(graph, reg);
    if issues.is_empty() {
        Ok(())
    } else {
        Err(AppError::Invalid(
            "workflow graph is invalid".into(),
            json!(issues),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg() -> &'static NodeRegistry {
        embedded()
    }

    fn good() -> Value {
        json!({
            "nodes": [
                {"id": "cam", "type": "camera", "config": {"camera_id": "11111111-1111-1111-1111-111111111111", "fps": 5}},
                {"id": "code", "type": "codeblock", "config": {"code": "def process(f): pass"}},
                {"id": "mail", "type": "email", "config": {"to": ["a@b.co"], "subject": "hi"}}
            ],
            "edges": [
                {"id": "e1", "source": "cam", "target": "code", "sourceHandle": "frames", "targetHandle": "frames"},
                {"id": "e2", "source": "code", "target": "mail", "sourceHandle": "actions", "targetHandle": "trigger"}
            ]
        })
    }

    fn codes(g: &Value) -> Vec<&'static str> {
        validate_graph(g, reg()).iter().map(|i| i.code).collect()
    }

    #[test]
    fn embedded_registry_loads() {
        let ids: Vec<_> = reg().iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["camera", "codeblock", "email"]);
    }

    #[test]
    fn valid_graph_passes() {
        assert!(validate_graph(&good(), reg()).is_empty());
        assert!(check_graph(&json!({"nodes": [], "edges": []}), reg()).is_ok());
    }

    #[test]
    fn malformed() {
        assert_eq!(codes(&json!({"nodes": "x"})), ["malformed"]);
        assert_eq!(codes(&json!([1])), ["malformed"]);
    }

    #[test]
    fn unknown_type_and_duplicate_id() {
        let mut g = good();
        g["nodes"][2]["type"] = json!("sms");
        assert!(codes(&g).contains(&"unknown_type"));
        let mut g = good();
        g["nodes"][1]["id"] = json!("cam");
        assert!(codes(&g).contains(&"duplicate_id"));
    }

    #[test]
    fn config_rules() {
        let mut g = good();
        g["nodes"][0]["config"] = json!({});
        assert_eq!(codes(&g), ["missing_config"]);
        let mut g = good();
        g["nodes"][1]["config"]["code"] = json!("");
        assert_eq!(codes(&g), ["missing_config"]);
        let mut g = good();
        g["nodes"][0]["config"]["fps"] = json!(99);
        assert_eq!(codes(&g), ["bad_config"]);
        let mut g = good();
        g["nodes"][0]["config"]["fps"] = json!("fast");
        assert_eq!(codes(&g), ["bad_config"]);
        let mut g = good();
        g["nodes"][2]["config"]["to"] = json!([1]);
        assert_eq!(codes(&g), ["bad_config"]);
    }

    #[test]
    fn edge_rules() {
        let mut g = good();
        g["edges"][0]["target"] = json!("ghost");
        let c = codes(&g);
        assert!(c.contains(&"bad_edge") && c.contains(&"dangling_input"));
        let mut g = good();
        g["edges"][0]["sourceHandle"] = json!("nope");
        assert!(codes(&g).contains(&"bad_edge"));
        // frame -> action port: wrong wiring camera->email
        let mut g = good();
        g["edges"][1] = json!({"id": "e2", "source": "cam", "target": "mail", "sourceHandle": "frames", "targetHandle": "trigger"});
        assert!(codes(&g).contains(&"type_mismatch"));
    }

    #[test]
    fn dangling_required_input() {
        let mut g = good();
        g["edges"].as_array_mut().unwrap().pop();
        assert_eq!(codes(&g), ["dangling_input"]);
        let mut g = good();
        g["edges"] = json!([]);
        assert_eq!(codes(&g), ["dangling_input", "dangling_input"]);
    }

    #[test]
    fn cycle_detected() {
        let g = json!({
            "nodes": [
                {"id": "a", "type": "codeblock", "config": {"code": "x"}},
                {"id": "b", "type": "codeblock", "config": {"code": "x"}}
            ],
            "edges": [
                {"source": "a", "target": "b", "sourceHandle": "result", "targetHandle": "frames"},
                {"source": "b", "target": "a", "sourceHandle": "result", "targetHandle": "frames"}
            ]
        });
        // result(object) -> frames(frame) also mismatches; cycle must still be reported
        assert!(codes(&g).contains(&"cycle"));
    }

    #[test]
    fn check_graph_is_422_with_details() {
        let err = check_graph(&json!({"nodes": "x"}), reg()).unwrap_err();
        assert_eq!(err.status(), axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert!(matches!(err, AppError::Invalid(_, d) if d[0]["code"] == "malformed"));
    }
}
