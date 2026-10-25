//! Redis pub/sub fan-out and the WebSocket / live-snapshot endpoints
//! (`docs/runtime-protocol.md`, "Live frames" and "Events").

use async_trait::async_trait;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::StreamExt;
use redis::AsyncCommands;
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    events::{EventDetail, EventSink},
    extract::{user_from_token, AuthUser},
    AppState,
};

pub const EVENTS_CHANNEL: &str = "cameraman:events";

pub fn frames_channel(camera: Uuid) -> String {
    format!("cameraman:camera:{camera}:frames")
}

pub fn latest_key(camera: Uuid) -> String {
    format!("cameraman:camera:{camera}:latest")
}

fn client(st: &AppState) -> AppResult<redis::Client> {
    if st.config.redis_url.is_empty() {
        return Err(AppError::Internal("redis is not configured".into()));
    }
    redis::Client::open(st.config.redis_url.as_str())
        .map_err(|e| AppError::Internal(format!("redis: {e}")))
}

fn redis_err(e: redis::RedisError) -> AppError {
    AppError::Internal(format!("redis: {e}"))
}

/// `PUBLISH cameraman:events <json>` for every ingested event.
pub struct RedisEventSink {
    client: redis::Client,
}

impl RedisEventSink {
    pub fn new(redis_url: &str) -> Result<Self, String> {
        Ok(Self {
            client: redis::Client::open(redis_url).map_err(|e| e.to_string())?,
        })
    }
}

#[async_trait]
impl EventSink for RedisEventSink {
    async fn publish(&self, event: &EventDetail) -> Result<(), String> {
        let json = serde_json::to_string(event).map_err(|e| e.to_string())?;
        let mut con = self
            .client
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| e.to_string())?;
        let _: i64 = con
            .publish(EVENTS_CHANNEL, json)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub fn router() -> Router<AppState> {
    Router::new().route("/ws/events", get(ws_events))
}

pub fn camera_router() -> Router<AppState> {
    Router::new()
        .route("/{id}/stream", get(ws_stream))
        .route("/{id}/snapshot", get(live_snapshot))
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

/// Auth for query-token endpoints: absent/bad token -> 401 before any upgrade.
async fn auth_query(st: &AppState, q: &TokenQuery) -> AppResult<()> {
    let token = q
        .token
        .as_deref()
        .ok_or_else(|| AppError::Unauthorized("missing token".into()))?;
    user_from_token(st, token).await.map(|_| ())
}

type WsReq = Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>;

// WS handlers return Response in both arms; the "large Err" lint is irrelevant here.
#[allow(clippy::result_large_err)]
async fn ws_events(
    State(st): State<AppState>,
    Query(q): Query<TokenQuery>,
    ws: WsReq,
) -> Result<Response, Response> {
    auth_query(&st, &q)
        .await
        .map_err(IntoResponse::into_response)?;
    let ws = ws.map_err(IntoResponse::into_response)?;
    let sub = subscribe(&st, EVENTS_CHANNEL)
        .await
        .map_err(IntoResponse::into_response)?;
    Ok(ws.on_upgrade(move |s| pump(s, sub, false)))
}

#[allow(clippy::result_large_err)]
async fn ws_stream(
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<TokenQuery>,
    ws: WsReq,
) -> Result<Response, Response> {
    auth_query(&st, &q)
        .await
        .map_err(IntoResponse::into_response)?;
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM cameras WHERE id = $1")
        .bind(id)
        .fetch_optional(&st.pool)
        .await
        .map_err(|e| AppError::from(e).into_response())?;
    if exists.is_none() {
        return Err(AppError::NotFound("camera not found".into()).into_response());
    }
    let ws = ws.map_err(IntoResponse::into_response)?;
    let sub = subscribe(&st, &frames_channel(id))
        .await
        .map_err(IntoResponse::into_response)?;
    Ok(ws.on_upgrade(move |s| pump(s, sub, true)))
}

/// Subscribe before the upgrade completes so no message after the handshake is missed.
async fn subscribe(st: &AppState, channel: &str) -> AppResult<redis::aio::PubSub> {
    let mut ps = client(st)?.get_async_pubsub().await.map_err(redis_err)?;
    ps.subscribe(channel).await.map_err(redis_err)?;
    Ok(ps)
}

/// Forward Redis messages to the socket until either side closes.
async fn pump(mut socket: WebSocket, ps: redis::aio::PubSub, binary: bool) {
    let mut msgs = ps.into_on_message();
    loop {
        tokio::select! {
            m = msgs.next() => {
                let Some(m) = m else { break };
                let bytes = m.get_payload_bytes().to_vec();
                let out = if binary {
                    Message::Binary(bytes.into())
                } else {
                    match String::from_utf8(bytes) {
                        Ok(t) => Message::Text(t.into()),
                        Err(_) => continue,
                    }
                };
                if socket.send(out).await.is_err() {
                    break;
                }
            }
            c = socket.recv() => match c {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            },
        }
    }
}

async fn live_snapshot(
    _u: AuthUser,
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let mut con = client(&st)?
        .get_multiplexed_async_connection()
        .await
        .map_err(redis_err)?;
    let img: Option<Vec<u8>> = con.get(latest_key(id)).await.map_err(redis_err)?;
    match img {
        Some(b) if !b.is_empty() => Ok((
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            b,
        )
            .into_response()),
        _ => Err(AppError::NotFound("no recent frame".into())),
    }
}
