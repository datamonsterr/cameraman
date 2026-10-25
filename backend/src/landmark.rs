//! Landmark CRUD (SPEC FR-13). Landmarks feed the run-control payload.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    audit::audit_soft,
    error::{AppError, AppResult},
    extract::{AuthUser, OperatorUser},
    AppState,
};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Landmark {
    pub id: Uuid,
    pub camera_id: Uuid,
    pub name: String,
    #[sqlx(rename = "box")]
    #[serde(rename = "box")]
    pub bbox: Value,
    pub polygon: Option<Value>,
    pub drift_threshold: f32,
    pub similarity_threshold: f32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const COLS: &str = "id, camera_id, name, box, polygon, drift_threshold, similarity_threshold, \
    created_at, updated_at";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", axum::routing::patch(update).delete(remove))
}

fn validate_name(n: &str) -> AppResult<String> {
    let n = n.trim();
    if n.is_empty() {
        Err(AppError::Unprocessable("name is required".into()))
    } else {
        Ok(n.to_string())
    }
}

fn unit(v: &Value) -> bool {
    v.as_f64().is_some_and(|f| (0.0..=1.0).contains(&f))
}

/// `[x,y,w,h]` or `{x,y,w,h}`, all normalized to 0..1.
pub fn validate_box(b: &Value) -> AppResult<()> {
    let ok = match b {
        Value::Array(a) => a.len() == 4 && a.iter().all(unit),
        Value::Object(o) => ["x", "y", "w", "h"]
            .iter()
            .all(|k| o.get(*k).is_some_and(unit)),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(AppError::Unprocessable(
            "box must be [x,y,w,h] or {x,y,w,h} with values in 0..1".into(),
        ))
    }
}

fn validate_polygon(p: &Value) -> AppResult<()> {
    let ok = p.as_array().is_some_and(|pts| {
        pts.len() >= 3
            && pts.iter().all(|pt| match pt {
                Value::Array(a) => a.len() == 2 && a.iter().all(unit),
                Value::Object(o) => ["x", "y"].iter().all(|k| o.get(*k).is_some_and(unit)),
                _ => false,
            })
    });
    if ok {
        Ok(())
    } else {
        Err(AppError::Unprocessable(
            "polygon must be a list of at least 3 [x,y] points in 0..1".into(),
        ))
    }
}

fn validate_threshold(name: &str, v: f32) -> AppResult<f32> {
    if (0.0..=1.0).contains(&v) {
        Ok(v)
    } else {
        Err(AppError::Unprocessable(format!(
            "{name} must be within 0..1"
        )))
    }
}

fn map_write_err(e: sqlx::Error) -> AppError {
    if let Some(db) = e.as_database_error() {
        if db.is_unique_violation() {
            return AppError::Conflict("a landmark with this name already exists".into());
        }
        if db.is_foreign_key_violation() {
            return AppError::Unprocessable("camera does not exist".into());
        }
    }
    e.into()
}

async fn fetch(pool: &PgPool, id: Uuid) -> AppResult<Landmark> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM landmarks WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("landmark not found".into()))
}

#[derive(Deserialize)]
struct ListQuery {
    camera: Option<Uuid>,
}

async fn list(
    _u: AuthUser,
    State(st): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<Landmark>>> {
    let rows = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM landmarks WHERE ($1::uuid IS NULL OR camera_id = $1) \
         ORDER BY camera_id, name"
    )))
    .bind(q.camera)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateReq {
    pub camera_id: Uuid,
    pub name: String,
    #[serde(rename = "box")]
    pub bbox: Value,
    pub polygon: Option<Value>,
    pub drift_threshold: Option<f32>,
    pub similarity_threshold: Option<f32>,
}

async fn create(
    OperatorUser(actor): OperatorUser,
    State(st): State<AppState>,
    Json(req): Json<CreateReq>,
) -> AppResult<(StatusCode, Json<Landmark>)> {
    let name = validate_name(&req.name)?;
    validate_box(&req.bbox)?;
    if let Some(p) = &req.polygon {
        validate_polygon(p)?;
    }
    let drift = req
        .drift_threshold
        .map(|v| validate_threshold("drift_threshold", v))
        .transpose()?;
    let sim = req
        .similarity_threshold
        .map(|v| validate_threshold("similarity_threshold", v))
        .transpose()?;
    let lm: Landmark = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "INSERT INTO landmarks (camera_id, name, box, polygon, drift_threshold, similarity_threshold) \
         VALUES ($1, $2, $3, $4, COALESCE($5, 0.15), COALESCE($6, 0.6)) RETURNING {COLS}"
    )))
    .bind(req.camera_id)
    .bind(&name)
    .bind(&req.bbox)
    .bind(&req.polygon)
    .bind(drift)
    .bind(sim)
    .fetch_one(&st.pool)
    .await
    .map_err(map_write_err)?;
    audit_soft(
        &st.pool,
        Some(actor.id),
        "landmark.create",
        Some(&lm.id.to_string()),
        Some(json!({"camera_id": lm.camera_id, "name": lm.name})),
    )
    .await;
    Ok((StatusCode::CREATED, Json(lm)))
}

#[derive(Deserialize)]
pub struct UpdateReq {
    pub name: Option<String>,
    #[serde(rename = "box")]
    pub bbox: Option<Value>,
    pub polygon: Option<Value>,
    pub drift_threshold: Option<f32>,
    pub similarity_threshold: Option<f32>,
}

async fn update(
    OperatorUser(actor): OperatorUser,
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateReq>,
) -> AppResult<Json<Landmark>> {
    let cur = fetch(&st.pool, id).await?;
    let name = validate_name(req.name.as_deref().unwrap_or(&cur.name))?;
    let bbox = match req.bbox {
        Some(b) => {
            validate_box(&b)?;
            b
        }
        None => cur.bbox.clone(),
    };
    let polygon = match req.polygon {
        Some(p) => {
            validate_polygon(&p)?;
            Some(p)
        }
        None => cur.polygon.clone(),
    };
    let drift = validate_threshold(
        "drift_threshold",
        req.drift_threshold.unwrap_or(cur.drift_threshold),
    )?;
    let sim = validate_threshold(
        "similarity_threshold",
        req.similarity_threshold.unwrap_or(cur.similarity_threshold),
    )?;
    let lm: Landmark = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE landmarks SET name = $2, box = $3, polygon = $4, drift_threshold = $5, \
         similarity_threshold = $6, updated_at = now() WHERE id = $1 RETURNING {COLS}"
    )))
    .bind(id)
    .bind(&name)
    .bind(&bbox)
    .bind(&polygon)
    .bind(drift)
    .bind(sim)
    .fetch_one(&st.pool)
    .await
    .map_err(map_write_err)?;
    audit_soft(
        &st.pool,
        Some(actor.id),
        "landmark.update",
        Some(&id.to_string()),
        Some(json!({"name": lm.name})),
    )
    .await;
    Ok(Json(lm))
}

async fn remove(
    OperatorUser(actor): OperatorUser,
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let n = sqlx::query("DELETE FROM landmarks WHERE id = $1")
        .bind(id)
        .execute(&st.pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound("landmark not found".into()));
    }
    audit_soft(
        &st.pool,
        Some(actor.id),
        "landmark.delete",
        Some(&id.to_string()),
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_validation() {
        assert!(validate_box(&json!([0.1, 0.2, 0.3, 0.4])).is_ok());
        assert!(validate_box(&json!({"x":0,"y":0,"w":1,"h":1})).is_ok());
        assert!(validate_box(&json!([0.1, 0.2, 0.3])).is_err());
        assert!(validate_box(&json!([0.1, 0.2, 0.3, 1.5])).is_err());
        assert!(validate_box(&json!("x")).is_err());
        assert!(validate_polygon(&json!([[0, 0], [1, 0], [1, 1]])).is_ok());
        assert!(validate_polygon(&json!([[0, 0], [1, 0]])).is_err());
    }
}
