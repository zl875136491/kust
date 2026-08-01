mod config;
mod crypto;
mod db;
mod error;
mod kubernetes;
mod models;
mod routes;
mod state;

use std::sync::Arc;

use config::AppConfig;
use crypto::SecretBox;
use state::AppState;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "kust_api=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = AppConfig::from_env().unwrap_or_else(|error| {
        eprintln!("configuration error: {error}");
        std::process::exit(2);
    });
    if config.encryption_key == "kust-local-development-key-change-me" {
        tracing::warn!(
            "using the development encryption key; set KUST_ENCRYPTION_KEY in production"
        );
    }

    let database = db::connect(&config).await.unwrap_or_else(|error| {
        eprintln!("database connection failed: {error}");
        std::process::exit(2);
    });
    let state = Arc::new(AppState {
        clusters: database.collection("clusters"),
        database,
        secrets: SecretBox::new(&config.encryption_key),
    });
    let app = routes::router(state, &config).unwrap_or_else(|error| {
        eprintln!("router configuration failed: {error}");
        std::process::exit(2);
    });

    let listener = tokio::net::TcpListener::bind(config.listen_addr)
        .await
        .unwrap_or_else(|error| {
            eprintln!("unable to listen on {}: {error}", config.listen_addr);
            std::process::exit(2);
        });
    tracing::info!(address = %config.listen_addr, "kust API is ready");
    axum::serve(listener, app)
        .await
        .expect("HTTP server failed");
}
