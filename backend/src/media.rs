//! On-disk event snapshots under `${MEDIA_DIR}/snapshots/<uuid>.jpg`.

use std::path::{Component, Path as FsPath, PathBuf};

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    extract::AuthUser,
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/{id}", get(serve))
}

/// Decode a base64 JPEG (tolerates a `data:` URI prefix).
pub fn decode_jpeg(b64: &str) -> AppResult<Vec<u8>> {
    let raw = b64.rsplit(',').next().unwrap_or(b64).trim();
    let bytes = STANDARD
        .decode(raw)
        .map_err(|_| AppError::Unprocessable("snapshot_jpeg is not valid base64".into()))?;
    if bytes.is_empty() {
        return Err(AppError::Unprocessable("snapshot_jpeg is empty".into()));
    }
    Ok(bytes)
}

/// Write the bytes to `<media>/snapshots/<id>.jpg`; returns the media-relative path.
pub async fn save_jpeg(media_dir: &str, id: Uuid, bytes: &[u8]) -> AppResult<String> {
    let rel = format!("snapshots/{id}.jpg");
    let full = FsPath::new(media_dir).join(&rel);
    if let Some(dir) = full.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| AppError::Internal(format!("media dir: {e}")))?;
    }
    tokio::fs::write(&full, bytes)
        .await
        .map_err(|e| AppError::Internal(format!("snapshot write: {e}")))?;
    Ok(rel)
}

/// Resolve a stored path under the media dir; rejects absolute / `..` paths.
pub fn resolve(media_dir: &str, rel: &str) -> Option<PathBuf> {
    let p = FsPath::new(rel);
    p.components()
        .all(|c| matches!(c, Component::Normal(_)))
        .then(|| FsPath::new(media_dir).join(p))
}

async fn serve(
    _u: AuthUser,
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let rel: String = sqlx::query_scalar("SELECT path FROM snapshots WHERE id = $1")
        .bind(id)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("snapshot not found".into()))?;
    let full = resolve(&st.config.media_dir, &rel)
        .ok_or_else(|| AppError::NotFound("snapshot not found".into()))?;
    let bytes = tokio::fs::read(full)
        .await
        .map_err(|_| AppError::NotFound("snapshot file missing".into()))?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "image/jpeg")],
        bytes,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_traversal() {
        assert!(resolve("/m", "snapshots/a.jpg").is_some());
        assert!(resolve("/m", "../etc/passwd").is_none());
        assert!(resolve("/m", "/etc/passwd").is_none());
    }

    #[test]
    fn decode_variants() {
        assert_eq!(decode_jpeg("/9j/").unwrap(), vec![0xff, 0xd8, 0xff]);
        assert_eq!(decode_jpeg("data:image/jpeg;base64,/9j/").unwrap().len(), 3);
        assert!(decode_jpeg("%%%").is_err());
        assert!(decode_jpeg("").is_err());
    }
}
