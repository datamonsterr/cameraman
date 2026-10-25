use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    audit::audit_soft,
    error::{AppError, AppResult},
    models::User,
    password::{hash_password, verify_password},
    tokens::{encode_access, hash_refresh_token, new_refresh_token},
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/refresh", post(refresh))
        .route("/logout", post(logout))
}

#[derive(Deserialize)]
pub struct RegisterReq {
    pub email: String,
    pub display_name: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct LoginReq {
    pub email: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct RefreshReq {
    pub refresh_token: String,
}

#[derive(Serialize)]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: &'static str,
    pub expires_in: i64,
}

#[derive(Serialize)]
pub struct LoginResp {
    #[serde(flatten)]
    pub tokens: TokenPair,
    pub user: User,
}

fn normalize_email(e: &str) -> String {
    e.trim().to_lowercase()
}

fn validate_register(r: &RegisterReq) -> AppResult<()> {
    let email = r.email.trim();
    let valid_email = email.len() <= 254
        && email.split_once('@').is_some_and(|(l, d)| {
            !l.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.')
        })
        && !email.contains(char::is_whitespace);
    if !valid_email {
        return Err(AppError::Unprocessable("invalid email".into()));
    }
    if r.display_name.trim().is_empty() || r.display_name.len() > 100 {
        return Err(AppError::Unprocessable(
            "display_name must be 1-100 chars".into(),
        ));
    }
    if r.password.len() < 8 || r.password.len() > 256 {
        return Err(AppError::Unprocessable(
            "password must be 8-256 chars".into(),
        ));
    }
    Ok(())
}

async fn register(
    State(st): State<AppState>,
    Json(req): Json<RegisterReq>,
) -> AppResult<(StatusCode, Json<User>)> {
    validate_register(&req)?;
    let email = normalize_email(&req.email);
    let hash = hash_password(&req.password)?;

    let mut tx = st.pool.begin().await?;
    // Serialise registrations so exactly one "first user" becomes admin.
    sqlx::query("SELECT pg_advisory_xact_lock(7001)")
        .execute(&mut *tx)
        .await?;
    let user: User = sqlx::query_as(
        "INSERT INTO users (email, display_name, password_hash, role) \
         VALUES ($1, $2, $3, CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'viewer'::user_role ELSE 'admin'::user_role END) \
         RETURNING id, email, display_name, role, is_active, created_at",
    )
        .bind(&email)
        .bind(req.display_name.trim())
        .bind(&hash)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d) if d.is_unique_violation() => {
                AppError::Conflict("email already registered".into())
            }
            _ => e.into(),
        })?;
    tx.commit().await?;

    audit_soft(
        &st.pool,
        Some(user.id),
        "auth.register",
        Some(&user.email),
        Some(json!({ "role": user.role })),
    )
    .await;
    Ok((StatusCode::CREATED, Json(user)))
}

async fn issue_tokens(st: &AppState, user: &User) -> AppResult<TokenPair> {
    let access = encode_access(
        &st.config.jwt_secret,
        user.id,
        user.role,
        st.config.access_ttl_secs,
    )?;
    let refresh = new_refresh_token();
    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) \
         VALUES ($1, $2, now() + make_interval(secs => $3))",
    )
    .bind(user.id)
    .bind(hash_refresh_token(&refresh))
    .bind(st.config.refresh_ttl_secs as f64)
    .execute(&st.pool)
    .await?;
    Ok(TokenPair {
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: st.config.access_ttl_secs,
    })
}

fn bad_creds() -> AppError {
    AppError::Unauthorized("invalid email or password".into())
}

async fn login(
    State(st): State<AppState>,
    Json(req): Json<LoginReq>,
) -> AppResult<Json<LoginResp>> {
    let email = normalize_email(&req.email);
    let row: Option<(User, String)> = {
        let r: Option<sqlx::postgres::PgRow> = sqlx::query(
            "SELECT id, email, display_name, role, is_active, created_at, password_hash \
             FROM users WHERE email = $1",
        )
        .bind(&email)
        .fetch_optional(&st.pool)
        .await?;
        match r {
            None => None,
            Some(r) => {
                use sqlx::{FromRow, Row};
                Some((User::from_row(&r)?, r.try_get("password_hash")?))
            }
        }
    };
    let Some((user, phc)) = row else {
        // Burn comparable time so unknown emails are not distinguishable by latency.
        let _ = verify_password(&req.password, dummy_phc());
        audit_soft(&st.pool, None, "auth.login_failed", Some(&email), None).await;
        return Err(bad_creds());
    };
    if !user.is_active || !verify_password(&req.password, &phc) {
        audit_soft(
            &st.pool,
            Some(user.id),
            "auth.login_failed",
            Some(&email),
            None,
        )
        .await;
        return Err(bad_creds());
    }
    let tokens = issue_tokens(&st, &user).await?;
    audit_soft(
        &st.pool,
        Some(user.id),
        "auth.login",
        Some(&user.email),
        None,
    )
    .await;
    Ok(Json(LoginResp { tokens, user }))
}

fn dummy_phc() -> &'static str {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DUMMY.get_or_init(|| hash_password("dummy-password").unwrap_or_default())
}

async fn refresh(
    State(st): State<AppState>,
    Json(req): Json<RefreshReq>,
) -> AppResult<Json<TokenPair>> {
    let hash = hash_refresh_token(&req.refresh_token);
    // Atomic single-use: only one concurrent caller can revoke a live token.
    let uid: Option<Uuid> = sqlx::query_scalar(
        "UPDATE refresh_tokens SET revoked_at = now() \
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING user_id",
    )
    .bind(&hash)
    .fetch_optional(&st.pool)
    .await?;
    let invalid = || AppError::Unauthorized("invalid refresh token".into());
    let uid = uid.ok_or_else(invalid)?;
    let user: User = sqlx::query_as(
        "SELECT id, email, display_name, role, is_active, created_at FROM users WHERE id = $1",
    )
    .bind(uid)
    .fetch_optional(&st.pool)
    .await?
    .filter(|u: &User| u.is_active)
    .ok_or_else(invalid)?;
    Ok(Json(issue_tokens(&st, &user).await?))
}

async fn logout(State(st): State<AppState>, Json(req): Json<RefreshReq>) -> AppResult<StatusCode> {
    let uid: Option<Uuid> = sqlx::query_scalar(
        "UPDATE refresh_tokens SET revoked_at = now() \
         WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id",
    )
    .bind(hash_refresh_token(&req.refresh_token))
    .fetch_optional(&st.pool)
    .await?;
    if let Some(uid) = uid {
        audit_soft(&st.pool, Some(uid), "auth.logout", None, None).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Ensure an admin exists for `email`; idempotent (existing row untouched).
pub async fn ensure_admin(pool: &PgPool, email: &str, password: &str) -> AppResult<()> {
    let email = normalize_email(email);
    let hash = hash_password(password)?;
    let id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO users (email, display_name, password_hash, role) \
         VALUES ($1, 'Administrator', $2, 'admin') ON CONFLICT (email) DO NOTHING RETURNING id",
    )
    .bind(&email)
    .bind(&hash)
    .fetch_optional(pool)
    .await?;
    if let Some(id) = id {
        audit_soft(pool, Some(id), "seed.admin", Some(&email), None).await;
    }
    Ok(())
}
