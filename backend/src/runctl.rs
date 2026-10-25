//! Redis-backed worker run control (`docs/runtime-protocol.md`, "Run control").
//!
//! Payload assembly is pure (`camera_refs`, `camera_entry`, `landmark_entry`,
//! `control_payload`); `RedisRunControl` loads rows, calls them, then pushes.

use async_trait::async_trait;
use redis::AsyncCommands;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    crypto::decrypt_secret,
    rtsp::build_rtsp_url,
    workflow::{RunAction, RunControl, RunSignal},
};

pub const CONTROL_LIST: &str = "cameraman:runs:control";
pub const DESIRED_HASH: &str = "cameraman:runs:desired";
const DEFAULT_FPS: f64 = 10.0;

/// Camera row with the encrypted secret, as needed to build `rtsp_url`.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CameraRow {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: i32,
    pub rtsp_path: String,
    pub rtsp_username: Option<String>,
    pub rtsp_secret_enc: Option<Vec<u8>>,
    pub transport: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LandmarkRow {
    pub name: String,
    pub camera_id: Uuid,
    #[sqlx(rename = "box")]
    pub bbox: Value,
    pub drift_threshold: f32,
    pub similarity_threshold: f32,
}

/// Distinct `(camera_id, fps)` pairs referenced by `camera` nodes, in graph order.
pub fn camera_refs(graph: &Value) -> Vec<(Uuid, f64)> {
    let mut out: Vec<(Uuid, f64)> = Vec::new();
    let nodes = graph.get("nodes").and_then(Value::as_array);
    for n in nodes.into_iter().flatten() {
        if n.get("type").and_then(Value::as_str) != Some("camera") {
            continue;
        }
        let cfg = n.get("config");
        let Some(id) = cfg
            .and_then(|c| c.get("camera_id"))
            .and_then(Value::as_str)
            .and_then(|s| Uuid::parse_str(s).ok())
        else {
            continue;
        };
        if out.iter().any(|(i, _)| *i == id) {
            continue;
        }
        let fps = cfg
            .and_then(|c| c.get("fps"))
            .and_then(Value::as_f64)
            .filter(|f| *f > 0.0)
            .unwrap_or(DEFAULT_FPS);
        out.push((id, fps));
    }
    out
}

fn num(v: f64) -> Value {
    // Keep integers integral and trim f32 noise (0.15f32 as f64 = 0.1500000059...).
    json!((v * 1e6).round() / 1e6)
}

/// Protocol camera entry; decrypts the stored secret and builds the RTSP URL.
pub fn camera_entry(key: &[u8; 32], c: &CameraRow, fps: f64) -> Result<Value, String> {
    let pass = match &c.rtsp_secret_enc {
        Some(blob) => Some(decrypt_secret(key, blob).map_err(|e| e.to_string())?),
        None => None,
    };
    let url = build_rtsp_url(
        &c.host,
        c.port,
        &c.rtsp_path,
        c.rtsp_username.as_deref(),
        pass.as_deref(),
    );
    Ok(json!({
        "id": c.id,
        "name": c.name,
        "rtsp_url": url,
        "transport": c.transport,
        "fps": fps,
    }))
}

/// Protocol landmark entry; `box` is always emitted as `[x, y, w, h]`.
pub fn landmark_entry(l: &LandmarkRow) -> Value {
    json!({
        "name": l.name,
        "camera_id": l.camera_id,
        "box": box_array(&l.bbox),
        "drift_threshold": num(f64::from(l.drift_threshold)),
        "similarity_threshold": num(f64::from(l.similarity_threshold)),
    })
}

/// Accept `[x,y,w,h]` or `{x,y,w,h}`; anything else is passed through unchanged.
pub fn box_array(b: &Value) -> Value {
    if let Some(o) = b.as_object() {
        let g = |k: &str| o.get(k).and_then(Value::as_f64);
        if let (Some(x), Some(y), Some(w), Some(h)) = (g("x"), g("y"), g("w"), g("h")) {
            return json!([x, y, w, h]);
        }
    }
    b.clone()
}

/// Everything needed to assemble a `start`/`update` command.
pub struct StartInput<'a> {
    pub action: &'a str,
    pub run_id: Uuid,
    pub workflow_id: Uuid,
    pub version_id: Uuid,
    pub graph: &'a Value,
    pub cameras: Vec<Value>,
    pub landmarks: Vec<Value>,
}

pub fn control_payload(i: StartInput<'_>) -> Value {
    json!({
        "action": i.action,
        "run_id": i.run_id,
        "workflow_id": i.workflow_id,
        "version_id": i.version_id,
        "graph": i.graph,
        "cameras": i.cameras,
        "landmarks": i.landmarks,
    })
}

pub fn stop_payload(run_id: Uuid) -> Value {
    json!({ "action": "stop", "run_id": run_id })
}

pub struct RedisRunControl {
    client: redis::Client,
    pool: PgPool,
    key: [u8; 32],
}

impl RedisRunControl {
    pub fn new(redis_url: &str, pool: PgPool, key: [u8; 32]) -> Result<Self, String> {
        let client = redis::Client::open(redis_url).map_err(|e| e.to_string())?;
        Ok(Self { client, pool, key })
    }

    async fn build_start(
        &self,
        action: &str,
        sig: &RunSignal,
        run_id: Uuid,
    ) -> Result<Value, String> {
        let version_id = sig.version_id.ok_or("start/update needs a version")?;
        let graph: Value = sqlx::query_scalar("SELECT graph FROM workflow_versions WHERE id = $1")
            .bind(version_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("workflow version not found")?;
        let refs = camera_refs(&graph);
        let ids: Vec<Uuid> = refs.iter().map(|(i, _)| *i).collect();
        let rows: Vec<CameraRow> = sqlx::query_as(
            "SELECT id, name, host(host) AS host, port, rtsp_path, rtsp_username, \
             rtsp_secret_enc, transport FROM cameras WHERE id = ANY($1)",
        )
        .bind(&ids)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let mut cameras = Vec::new();
        for (id, fps) in &refs {
            match rows.iter().find(|r| r.id == *id) {
                Some(r) => cameras.push(camera_entry(&self.key, r, *fps)?),
                None => tracing::warn!(camera = %id, "graph references a missing camera"),
            }
        }
        let lms: Vec<LandmarkRow> = sqlx::query_as(
            "SELECT name, camera_id, box, drift_threshold, similarity_threshold \
             FROM landmarks WHERE camera_id = ANY($1) ORDER BY camera_id, name",
        )
        .bind(&ids)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(control_payload(StartInput {
            action,
            run_id,
            workflow_id: sig.workflow_id,
            version_id,
            graph: &graph,
            cameras,
            landmarks: lms.iter().map(landmark_entry).collect(),
        }))
    }
}

#[async_trait]
impl RunControl for RedisRunControl {
    async fn signal(&self, sig: RunSignal) -> Result<(), String> {
        let Some(run_id) = sig.run_id else {
            tracing::debug!(?sig, "run signal without run id; nothing to send");
            return Ok(());
        };
        let mut con = self
            .client
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| e.to_string())?;
        match sig.action {
            RunAction::Stop => {
                let cmd = stop_payload(run_id).to_string();
                let _: () = con
                    .lpush(CONTROL_LIST, &cmd)
                    .await
                    .map_err(|e| e.to_string())?;
                let _: () = con
                    .hdel(DESIRED_HASH, run_id.to_string())
                    .await
                    .map_err(|e| e.to_string())?;
            }
            RunAction::Start | RunAction::Update => {
                let action = if sig.action == RunAction::Start {
                    "start"
                } else {
                    "update"
                };
                let cmd = self.build_start(action, &sig, run_id).await?;
                let _: () = con
                    .lpush(CONTROL_LIST, cmd.to_string())
                    .await
                    .map_err(|e| e.to_string())?;
                // Resync state for a freshly booted worker is always a `start`.
                let mut desired = cmd;
                desired["action"] = json!("start");
                let _: () = con
                    .hset(DESIRED_HASH, run_id.to_string(), desired.to_string())
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{dev_key, encrypt_secret};

    fn cam(id: Uuid, secret: Option<Vec<u8>>) -> CameraRow {
        CameraRow {
            id,
            name: "front".into(),
            host: "10.0.0.5".into(),
            port: 554,
            rtsp_path: "/live".into(),
            rtsp_username: Some("admin".into()),
            rtsp_secret_enc: secret,
            transport: "tcp".into(),
        }
    }

    #[test]
    fn refs_dedupe_and_fps_default() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let g = json!({"nodes": [
            {"id":"1","type":"camera","config":{"camera_id": a, "fps": 5}},
            {"id":"2","type":"camera","config":{"camera_id": a, "fps": 7}},
            {"id":"3","type":"camera","config":{"camera_id": b}},
            {"id":"4","type":"codeblock","config":{"camera_id": Uuid::new_v4()}},
            {"id":"5","type":"camera","config":{"camera_id": "not-a-uuid"}}
        ]});
        assert_eq!(camera_refs(&g), vec![(a, 5.0), (b, 10.0)]);
        assert!(camera_refs(&json!({})).is_empty());
    }

    #[test]
    fn camera_entry_decrypts_and_encodes() {
        let key = dev_key();
        let id = Uuid::new_v4();
        let blob = encrypt_secret(&key, "p@ss/w").unwrap();
        let e = camera_entry(&key, &cam(id, Some(blob)), 5.0).unwrap();
        assert_eq!(e["id"], json!(id));
        assert_eq!(e["rtsp_url"], "rtsp://admin:p%40ss%2Fw@10.0.0.5:554/live");
        assert_eq!(e["transport"], "tcp");
        assert_eq!(e["fps"], 5.0);
        let e = camera_entry(&key, &cam(id, None), 10.0).unwrap();
        assert_eq!(e["rtsp_url"], "rtsp://admin@10.0.0.5:554/live");
        assert!(camera_entry(&key, &cam(id, Some(vec![1, 2, 3])), 1.0).is_err());
    }

    #[test]
    fn landmark_box_is_array() {
        let l = LandmarkRow {
            name: "door".into(),
            camera_id: Uuid::nil(),
            bbox: json!({"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}),
            drift_threshold: 0.15,
            similarity_threshold: 0.6,
        };
        let v = landmark_entry(&l);
        assert_eq!(v["box"], json!([0.1, 0.2, 0.3, 0.4]));
        assert_eq!(v["drift_threshold"], 0.15);
        assert_eq!(v["similarity_threshold"], 0.6);
        assert_eq!(box_array(&json!([1, 2, 3, 4])), json!([1, 2, 3, 4]));
    }

    #[test]
    fn payload_shape() {
        let g = json!({"nodes": [], "edges": []});
        let (r, w, v) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let p = control_payload(StartInput {
            action: "update",
            run_id: r,
            workflow_id: w,
            version_id: v,
            graph: &g,
            cameras: vec![],
            landmarks: vec![],
        });
        assert_eq!(p["action"], "update");
        assert_eq!(p["run_id"], json!(r));
        assert_eq!(p["graph"], g);
        assert_eq!(p["cameras"], json!([]));
        assert_eq!(stop_payload(r), json!({"action": "stop", "run_id": r}));
    }
}
