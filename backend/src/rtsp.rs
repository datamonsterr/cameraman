use std::{process::Stdio, time::Duration};

use async_trait::async_trait;
use serde::Deserialize;
use tokio::process::Command;

/// Stream metadata learned while validating an RTSP source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamMeta {
    pub width: i32,
    pub height: i32,
    pub codec: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidateError {
    /// Credentials missing or rejected (RTSP 401).
    Auth(String),
    /// Anything else (unreachable, timeout, bad stream...).
    Failed(String),
}

impl ValidateError {
    pub fn reason(&self) -> &str {
        match self {
            ValidateError::Auth(m) | ValidateError::Failed(m) => m,
        }
    }
}

/// Boundary for "can we open this RTSP stream?" (real impl shells out to ffprobe).
#[async_trait]
pub trait RtspValidator: Send + Sync {
    async fn validate(&self, url: &str, transport: &str) -> Result<StreamMeta, ValidateError>;
}

fn pct(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Build `rtsp://[user[:pass]@]host:port/path` with credentials percent-encoded.
pub fn build_rtsp_url(
    host: &str,
    port: i32,
    path: &str,
    user: Option<&str>,
    pass: Option<&str>,
) -> String {
    let auth = match (user, pass) {
        (Some(u), Some(p)) => format!("{}:{}@", pct(u), pct(p)),
        (Some(u), None) => format!("{}@", pct(u)),
        _ => String::new(),
    };
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    format!("rtsp://{auth}{host}:{port}{path}")
}

#[derive(Deserialize)]
struct FfStream {
    codec_name: Option<String>,
    width: Option<i32>,
    height: Option<i32>,
}

#[derive(Deserialize)]
struct FfOut {
    #[serde(default)]
    streams: Vec<FfStream>,
}

/// Parse `ffprobe -of json` stdout into stream metadata.
pub fn parse_ffprobe_output(stdout: &str) -> Result<StreamMeta, ValidateError> {
    let out: FfOut = serde_json::from_str(stdout)
        .map_err(|_| ValidateError::Failed("unreadable ffprobe output".into()))?;
    out.streams
        .into_iter()
        .find_map(|s| {
            Some(StreamMeta {
                width: s.width?,
                height: s.height?,
                codec: s.codec_name?,
            })
        })
        .ok_or_else(|| ValidateError::Failed("no video stream found".into()))
}

/// Turn ffprobe stderr into a clear error; `secret_url` is scrubbed from the text.
pub fn classify_ffprobe_error(stderr: &str, secret_url: &str) -> ValidateError {
    let clean = stderr.replace(secret_url, "<rtsp-url>");
    let low = clean.to_lowercase();
    if low.contains("401") || low.contains("unauthorized") {
        ValidateError::Auth("authentication failed (401): check username/password".into())
    } else if low.contains("connection refused") {
        ValidateError::Failed("connection refused".into())
    } else if low.contains("timed out") || low.contains("timeout") {
        ValidateError::Failed("connection timed out".into())
    } else {
        let line = clean.lines().rev().find(|l| !l.trim().is_empty());
        ValidateError::Failed(format!(
            "stream validation failed: {}",
            line.unwrap_or("unknown error").trim()
        ))
    }
}

/// Real validator: `ffprobe -rtsp_transport <tcp|udp> -show_entries stream=...`.
pub struct FfprobeValidator {
    pub timeout: Duration,
}

impl Default for FfprobeValidator {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(15),
        }
    }
}

#[async_trait]
impl RtspValidator for FfprobeValidator {
    async fn validate(&self, url: &str, transport: &str) -> Result<StreamMeta, ValidateError> {
        let transport = if transport == "udp" { "udp" } else { "tcp" };
        let child = Command::new("ffprobe")
            .args(["-v", "error", "-rtsp_transport", transport])
            .args(["-timeout", &(self.timeout.as_micros() / 2).to_string()])
            .args(["-select_streams", "v:0"])
            .args(["-show_entries", "stream=codec_name,width,height"])
            .args(["-of", "json", url])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| ValidateError::Failed(format!("ffprobe unavailable: {e}")))?;
        let out = match tokio::time::timeout(self.timeout, child.wait_with_output()).await {
            Err(_) => return Err(ValidateError::Failed("connection timed out".into())),
            Ok(Err(e)) => return Err(ValidateError::Failed(format!("ffprobe failed: {e}"))),
            Ok(Ok(o)) => o,
        };
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !out.status.success() {
            return Err(classify_ffprobe_error(&stderr, url));
        }
        parse_ffprobe_output(&String::from_utf8_lossy(&out.stdout))
    }
}

/// Test double with a canned result.
pub struct FakeValidator(pub Result<StreamMeta, ValidateError>);

#[async_trait]
impl RtspValidator for FakeValidator {
    async fn validate(&self, _url: &str, _transport: &str) -> Result<StreamMeta, ValidateError> {
        self.0.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_building_encodes_credentials() {
        assert_eq!(
            build_rtsp_url(
                "192.168.1.38",
                554,
                "/tenda",
                Some("ad min"),
                Some("p@ss:/#")
            ),
            "rtsp://ad%20min:p%40ss%3A%2F%23@192.168.1.38:554/tenda"
        );
        assert_eq!(
            build_rtsp_url("10.0.0.1", 8554, "x", None, None),
            "rtsp://10.0.0.1:8554/x"
        );
    }

    #[test]
    fn ffprobe_parse() {
        let ok = r#"{"streams":[{"codec_name":"hevc","width":2304,"height":1296}]}"#;
        assert_eq!(
            parse_ffprobe_output(ok).unwrap(),
            StreamMeta {
                width: 2304,
                height: 1296,
                codec: "hevc".into()
            }
        );
        assert!(parse_ffprobe_output(r#"{"streams":[]}"#).is_err());
        assert!(parse_ffprobe_output("garbage").is_err());
    }

    #[test]
    fn ffprobe_error_classification_and_scrub() {
        let url = "rtsp://u:topsecret@h:554/p";
        let e = classify_ffprobe_error(&format!("{url}: Server returned 401 Unauthorized"), url);
        assert!(matches!(e, ValidateError::Auth(_)));
        let e = classify_ffprobe_error(&format!("{url}: weird failure"), url);
        assert!(matches!(&e, ValidateError::Failed(m) if !m.contains("topsecret")));
        let e = classify_ffprobe_error("Connection refused", url);
        assert_eq!(e, ValidateError::Failed("connection refused".into()));
    }
}
