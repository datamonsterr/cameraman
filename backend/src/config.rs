use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    pub database_url: String,
    pub redis_url: String,
    pub jwt_secret: String,
    pub access_ttl_secs: i64,
    pub refresh_ttl_secs: i64,
    pub admin_email: Option<String>,
    pub admin_password: Option<String>,
    pub seed_on_start: bool,
    /// Comma separated origins, or `*` for any.
    pub cors_origins: String,
    /// 32-byte key for RTSP credential encryption at rest.
    pub camera_enc_key: [u8; 32],
    /// Shared secret the worker presents in `X-Worker-Token`; ingest is disabled when unset.
    pub worker_token: Option<String>,
    /// Root directory for stored media (snapshots under `snapshots/`).
    pub media_dir: String,
}

fn var(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.is_empty())
}

fn parse_i64(name: &str, default: i64) -> Result<i64, String> {
    match var(name) {
        None => Ok(default),
        Some(v) => v.parse().map_err(|_| format!("{name} must be an integer")),
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            bind: var("BACKEND_BIND").unwrap_or_else(|| "0.0.0.0:8080".into()),
            database_url: var("DATABASE_URL").ok_or("DATABASE_URL is required")?,
            redis_url: var("REDIS_URL").unwrap_or_else(|| "redis://localhost:6379".into()),
            jwt_secret: var("JWT_SECRET").ok_or("JWT_SECRET is required")?,
            access_ttl_secs: parse_i64("ACCESS_TOKEN_TTL_SECS", 900)?,
            refresh_ttl_secs: parse_i64("REFRESH_TOKEN_TTL_SECS", 2_592_000)?,
            admin_email: var("ADMIN_EMAIL"),
            admin_password: var("ADMIN_PASSWORD"),
            seed_on_start: var("SEED_ON_START")
                .map(|v| matches!(v.to_lowercase().as_str(), "true" | "1" | "yes"))
                .unwrap_or(false),
            cors_origins: var("CORS_ORIGINS").unwrap_or_else(|| "*".into()),
            worker_token: var("WORKER_TOKEN"),
            media_dir: var("MEDIA_DIR").unwrap_or_else(|| "/media".into()),
            camera_enc_key: match var("CAMERA_ENC_KEY") {
                Some(k) => crate::crypto::parse_key(&k)?,
                None => {
                    tracing::warn!(
                        "CAMERA_ENC_KEY not set; using an INSECURE built-in dev key. \
                         Set a base64 32-byte key in production"
                    );
                    crate::crypto::dev_key()
                }
            },
        })
    }

    /// Deterministic config for tests.
    pub fn for_test() -> Self {
        Self {
            bind: "127.0.0.1:0".into(),
            database_url: String::new(),
            redis_url: String::new(),
            jwt_secret: "test-secret-test-secret-test-secret".into(),
            access_ttl_secs: 900,
            refresh_ttl_secs: 3600,
            admin_email: None,
            admin_password: None,
            seed_on_start: false,
            cors_origins: "*".into(),
            camera_enc_key: crate::crypto::dev_key(),
            worker_token: Some("test-worker-token".into()),
            media_dir: "/media".into(),
        }
    }
}
