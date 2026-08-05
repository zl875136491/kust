mod auth;
mod auth_routes;
mod cache;
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

    let presets = match state::load_preset_clusters(&config.preset_config_path) {
        Ok(presets) => presets,
        Err(error) if config.preset_config_path.exists() => {
            eprintln!(
                "preset configuration error at {}: {error}",
                config.preset_config_path.display()
            );
            std::process::exit(2);
        }
        Err(error) => {
            tracing::warn!(%error, path = %config.preset_config_path.display(), "unable to load preset kubeconfigs");
            Vec::new()
        }
    };
    tracing::info!(count = presets.len(), path = %config.preset_config_path.display(), "loaded preset kubeconfigs");
    let database = db::connect(&config).await.unwrap_or_else(|error| {
        eprintln!("database connection failed: {error}");
        std::process::exit(2);
    });
    let platform_config = db::load_platform_settings(&database, &config)
        .await
        .unwrap_or_else(|error| {
            eprintln!("unable to initialize platform settings: {error}");
            std::process::exit(2);
        });
    let config = Arc::new(config);
    let state = Arc::new(AppState {
        clusters: database.collection("clusters"),
        resource_snapshots: database.collection("resource_snapshots"),
        users: database.collection("users"),
        roles: database.collection("roles"),
        sessions: database.collection("sessions"),
        trusted_devices: database.collection("trusted_devices"),
        auth_codes: database.collection("auth_codes"),
        user_settings: database.collection("user_settings"),
        platform_settings: database.collection("platform_settings"),
        notifications: database.collection("notifications"),
        platform_config: Arc::new(tokio::sync::RwLock::new(platform_config)),
        database,
        secrets: SecretBox::new(&config.encryption_key),
        config: config.clone(),
        http: reqwest::Client::builder()
            .user_agent("Kust/0.1")
            .build()
            .unwrap_or_else(|error| {
                eprintln!("unable to create HTTP client: {error}");
                std::process::exit(2);
            }),
    });
    let preset_count = state::sync_preset_clusters(&state, presets)
        .await
        .unwrap_or_else(|error| {
            eprintln!("unable to synchronize preset clusters: {error}");
            std::process::exit(2);
        });
    tracing::info!(
        count = preset_count,
        "preset clusters synchronized to MongoDB"
    );
    cache::start_background_sync(state.clone());
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
