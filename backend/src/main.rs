use std::sync::Arc;

use cameraman::{app, config::Config, connect_db, init_tracing, seed, AppState};

#[tokio::main]
async fn main() {
    init_tracing();
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("config error: {e}");
            std::process::exit(2);
        }
    };
    let pool = connect_db(&config.database_url)
        .await
        .expect("database connect/migrate failed");
    let state = AppState {
        pool,
        config: Arc::new(config),
    };
    seed(&state).await.expect("seeding failed");
    let listener = tokio::net::TcpListener::bind(&state.config.bind)
        .await
        .expect("bind failed");
    tracing::info!(addr = %state.config.bind, "listening");
    axum::serve(listener, app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server error");
}
