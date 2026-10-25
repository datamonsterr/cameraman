use axum::{extract::State, routing::post, Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    extract::AuthUser,
    AppState,
};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Device {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token: String,
    pub platform: String,
    pub created_at: DateTime<Utc>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/", post(register))
}

#[derive(Deserialize)]
pub struct RegisterReq {
    pub token: String,
    pub platform: String,
}

/// Mobile push registration. A token belongs to one user: re-registering
/// from another account moves it.
async fn register(
    AuthUser(user): AuthUser,
    State(st): State<AppState>,
    Json(req): Json<RegisterReq>,
) -> AppResult<Json<Device>> {
    let token = req.token.trim();
    let platform = req.platform.trim().to_lowercase();
    if token.is_empty() {
        return Err(AppError::Unprocessable("token is required".into()));
    }
    if platform.is_empty() {
        return Err(AppError::Unprocessable("platform is required".into()));
    }
    let d = sqlx::query_as(
        "INSERT INTO devices (user_id, token, platform) VALUES ($1, $2, $3) \
         ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform \
         RETURNING id, user_id, token, platform, created_at",
    )
    .bind(user.id)
    .bind(token)
    .bind(&platform)
    .fetch_one(&st.pool)
    .await?;
    Ok(Json(d))
}
