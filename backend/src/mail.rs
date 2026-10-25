//! Email: `Mailer` seam (real `SmtpMailer` via lettre, `FakeMailer` for tests)
//! and the admin SMTP settings endpoints (FR-16).

use std::{env, sync::Mutex};

use async_trait::async_trait;
use axum::{extract::State, routing::get, Json, Router};
use chrono::{DateTime, Utc};
use lettre::{
    message::Mailbox,
    transport::smtp::{authentication::Credentials, AsyncSmtpTransport},
    AsyncTransport, Message, Tokio1Executor,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;

use crate::{
    audit::audit_soft,
    crypto::{decrypt_secret, encrypt_secret},
    error::{AppError, AppResult},
    extract::AdminUser,
    AppState,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailMessage {
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
}

/// Outbound email seam. Real impl reads SMTP settings at send time.
#[async_trait]
pub trait Mailer: Send + Sync {
    async fn send(&self, st: &AppState, msg: &EmailMessage) -> Result<(), String>;
}

/// Test double: records messages, optionally failing.
#[derive(Debug, Default)]
pub struct FakeMailer {
    pub sent: Mutex<Vec<EmailMessage>>,
    pub fail_with: Option<String>,
}

impl FakeMailer {
    pub fn failing(msg: &str) -> Self {
        Self {
            sent: Mutex::default(),
            fail_with: Some(msg.into()),
        }
    }
    pub fn recorded(&self) -> Vec<EmailMessage> {
        self.sent.lock().unwrap().clone()
    }
}

#[async_trait]
impl Mailer for FakeMailer {
    async fn send(&self, _st: &AppState, msg: &EmailMessage) -> Result<(), String> {
        if let Some(e) = &self.fail_with {
            return Err(e.clone());
        }
        self.sent.lock().unwrap().push(msg.clone());
        Ok(())
    }
}

/// Resolved SMTP connection settings (password decrypted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub from_addr: String,
    pub use_tls: bool,
}

#[derive(sqlx::FromRow)]
struct SmtpRow {
    host: String,
    port: i32,
    username: Option<String>,
    secret_enc: Option<Vec<u8>>,
    from_addr: String,
    use_tls: bool,
}

/// DB row first, then `SMTP_*` env fallback.
pub async fn load_smtp_config(pool: &PgPool, key: &[u8; 32]) -> AppResult<Option<SmtpConfig>> {
    let row: Option<SmtpRow> = sqlx::query_as(
        "SELECT host, port, username, secret_enc, from_addr, use_tls FROM smtp_settings WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?;
    if let Some(r) = row {
        let password = match r.secret_enc {
            Some(blob) => Some(decrypt_secret(key, &blob)?),
            None => None,
        };
        return Ok(Some(SmtpConfig {
            host: r.host,
            port: u16::try_from(r.port).map_err(|_| AppError::Internal("bad smtp port".into()))?,
            username: r.username,
            password,
            from_addr: r.from_addr,
            use_tls: r.use_tls,
        }));
    }
    Ok(smtp_from_env())
}

fn smtp_from_env() -> Option<SmtpConfig> {
    let get = |k: &str| env::var(k).ok().filter(|v| !v.is_empty());
    Some(SmtpConfig {
        host: get("SMTP_HOST")?,
        port: get("SMTP_PORT").and_then(|p| p.parse().ok()).unwrap_or(587),
        username: get("SMTP_USERNAME"),
        password: get("SMTP_PASSWORD"),
        from_addr: get("SMTP_FROM")?,
        use_tls: get("SMTP_TLS")
            .map(|v| !matches!(v.to_lowercase().as_str(), "false" | "0" | "no"))
            .unwrap_or(true),
    })
}

/// Real mailer over SMTP (lettre, rustls).
#[derive(Debug, Default)]
pub struct SmtpMailer;

#[async_trait]
impl Mailer for SmtpMailer {
    async fn send(&self, st: &AppState, msg: &EmailMessage) -> Result<(), String> {
        let cfg = load_smtp_config(&st.pool, &st.config.camera_enc_key)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("SMTP is not configured")?;
        let from: Mailbox = cfg
            .from_addr
            .parse()
            .map_err(|e| format!("bad from address: {e}"))?;
        let mut b = Message::builder().from(from).subject(&msg.subject);
        for t in &msg.to {
            b = b.to(t.parse().map_err(|e| format!("bad recipient {t}: {e}"))?);
        }
        let email = b.body(msg.body.clone()).map_err(|e| e.to_string())?;

        let mut tb = if !cfg.use_tls {
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host)
        } else if cfg.port == 465 {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host).map_err(|e| e.to_string())?
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)
                .map_err(|e| e.to_string())?
        }
        .port(cfg.port);
        if let (Some(u), Some(p)) = (cfg.username, cfg.password) {
            tb = tb.credentials(Credentials::new(u, p));
        }
        tb.build().send(email).await.map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ------------------------------------------------------------ settings API

pub fn router() -> Router<AppState> {
    Router::new().route("/smtp", get(get_smtp).put(put_smtp))
}

/// Public view: never carries the secret, only whether one is stored.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct SmtpView {
    pub configured: bool,
    pub host: Option<String>,
    pub port: i32,
    pub username: Option<String>,
    pub has_secret: bool,
    pub from_addr: Option<String>,
    pub use_tls: bool,
    pub updated_at: Option<DateTime<Utc>>,
}

async fn view(pool: &PgPool) -> AppResult<SmtpView> {
    let v = sqlx::query_as::<_, SmtpView>(
        "SELECT TRUE AS configured, host, port, username, (secret_enc IS NOT NULL) AS has_secret, \
         from_addr, use_tls, updated_at FROM smtp_settings WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?;
    Ok(v.unwrap_or(SmtpView {
        configured: false,
        host: None,
        port: 587,
        username: None,
        has_secret: false,
        from_addr: None,
        use_tls: true,
        updated_at: None,
    }))
}

async fn get_smtp(_a: AdminUser, State(st): State<AppState>) -> AppResult<Json<SmtpView>> {
    Ok(Json(view(&st.pool).await?))
}

#[derive(Deserialize)]
pub struct PutSmtp {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: i32,
    /// Empty string clears.
    pub username: Option<String>,
    /// Absent keeps the stored secret; non-empty rotates it; empty clears it.
    pub password: Option<String>,
    pub from_addr: String,
    #[serde(default = "yes")]
    pub use_tls: bool,
}

fn default_port() -> i32 {
    587
}
fn yes() -> bool {
    true
}

async fn put_smtp(
    AdminUser(actor): AdminUser,
    State(st): State<AppState>,
    Json(req): Json<PutSmtp>,
) -> AppResult<Json<SmtpView>> {
    let host = req.host.trim();
    if host.is_empty() {
        return Err(AppError::Unprocessable("host is required".into()));
    }
    if !(1..=65535).contains(&req.port) {
        return Err(AppError::Unprocessable("port must be 1-65535".into()));
    }
    let from = req.from_addr.trim();
    if from.parse::<Mailbox>().is_err() {
        return Err(AppError::Unprocessable(
            "from_addr must be an email address".into(),
        ));
    }
    let username = req.username.filter(|u| !u.is_empty());
    let touch_secret = req.password.is_some();
    let secret = match req.password.filter(|p| !p.is_empty()) {
        Some(p) => Some(encrypt_secret(&st.config.camera_enc_key, &p)?),
        None => None,
    };
    sqlx::query(
        "INSERT INTO smtp_settings (id, host, port, username, secret_enc, from_addr, use_tls) \
         VALUES (1, $1, $2, $3, $4, $5, $6) \
         ON CONFLICT (id) DO UPDATE SET host = EXCLUDED.host, port = EXCLUDED.port, \
         username = EXCLUDED.username, from_addr = EXCLUDED.from_addr, use_tls = EXCLUDED.use_tls, \
         secret_enc = CASE WHEN $7 THEN EXCLUDED.secret_enc ELSE smtp_settings.secret_enc END, \
         updated_at = now()",
    )
    .bind(host)
    .bind(req.port)
    .bind(&username)
    .bind(secret)
    .bind(from)
    .bind(req.use_tls)
    .bind(touch_secret)
    .execute(&st.pool)
    .await?;
    audit_soft(
        &st.pool,
        Some(actor.id),
        "settings.smtp.update",
        None,
        Some(json!({"host": host, "port": req.port, "secret_changed": touch_secret})),
    )
    .await;
    Ok(Json(view(&st.pool).await?))
}
