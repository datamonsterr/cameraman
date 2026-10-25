use sqlx::PgPool;
use uuid::Uuid;

/// Append a row to the append-only audit log.
pub async fn audit(
    pool: &PgPool,
    actor: Option<Uuid>,
    action: &str,
    target: Option<&str>,
    detail: Option<serde_json::Value>,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO audit_log (actor_id, action, target, detail) VALUES ($1, $2, $3, $4)")
        .bind(actor)
        .bind(action)
        .bind(target)
        .bind(detail)
        .execute(pool)
        .await?;
    Ok(())
}

/// Best-effort variant for handlers: failures are logged, never surfaced.
pub async fn audit_soft(
    pool: &PgPool,
    actor: Option<Uuid>,
    action: &str,
    target: Option<&str>,
    detail: Option<serde_json::Value>,
) {
    if let Err(e) = audit(pool, actor, action, target, detail).await {
        tracing::warn!(error = %e, action, "audit write failed");
    }
}
