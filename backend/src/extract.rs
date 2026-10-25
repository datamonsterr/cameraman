use axum::{extract::FromRequestParts, http::request::Parts};

use crate::{
    error::AppError,
    models::{Role, User},
    tokens::decode_access,
    AppState,
};

/// Authenticated caller: validates the bearer access token, then loads the
/// user's *current* role/active flag from the DB (role never trusted from JWT).
#[derive(Debug, Clone)]
pub struct AuthUser(pub User);

impl AuthUser {
    /// Per-route guard: Ok when the caller's role is at least `min`.
    pub fn require(&self, min: Role) -> Result<(), AppError> {
        require_role(&self.0, min)
    }
}

/// admin > operator > viewer.
pub fn require_role(user: &User, min: Role) -> Result<(), AppError> {
    if user.role >= min {
        Ok(())
    } else {
        Err(AppError::Forbidden("insufficient role".into()))
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| AppError::Unauthorized("missing bearer token".into()))?;
        let token = header
            .strip_prefix("Bearer ")
            .or_else(|| header.strip_prefix("bearer "))
            .ok_or_else(|| AppError::Unauthorized("missing bearer token".into()))?;
        let claims = decode_access(&state.config.jwt_secret, token)?;
        let user: Option<User> = sqlx::query_as(
            "SELECT id, email, display_name, role, is_active, created_at FROM users WHERE id = $1",
        )
        .bind(claims.sub)
        .fetch_optional(&state.pool)
        .await?;
        match user {
            Some(u) if u.is_active => Ok(AuthUser(u)),
            _ => Err(AppError::Unauthorized("invalid or expired token".into())),
        }
    }
}

macro_rules! role_extractor {
    ($name:ident, $role:expr) => {
        /// Extractor that additionally enforces a minimum role.
        pub struct $name(pub User);
        impl FromRequestParts<AppState> for $name {
            type Rejection = AppError;
            async fn from_request_parts(
                parts: &mut Parts,
                state: &AppState,
            ) -> Result<Self, AppError> {
                let AuthUser(u) = AuthUser::from_request_parts(parts, state).await?;
                require_role(&u, $role)?;
                Ok($name(u))
            }
        }
    };
}
role_extractor!(OperatorUser, Role::Operator);
role_extractor!(AdminUser, Role::Admin);

/// Internal caller (the worker): shared secret in `X-Worker-Token`.
/// Rejected with 401 when missing, wrong, or when no `WORKER_TOKEN` is configured.
pub struct WorkerAuth;

impl FromRequestParts<AppState> for WorkerAuth {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let given = parts
            .headers
            .get("x-worker-token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        match state.config.worker_token.as_deref() {
            Some(expected)
                if !expected.is_empty() && ct_eq(expected.as_bytes(), given.as_bytes()) =>
            {
                Ok(WorkerAuth)
            }
            _ => Err(AppError::Unauthorized("invalid worker token".into())),
        }
    }
}

/// Length-leaking but otherwise constant-time comparison.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
