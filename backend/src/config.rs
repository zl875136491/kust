use std::{env, net::SocketAddr};

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub listen_addr: SocketAddr,
    pub mongodb_uri: String,
    pub mongodb_database: String,
    pub encryption_key: String,
    pub cors_origin: String,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, String> {
        let listen_addr = env::var("LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8080".into())
            .parse()
            .map_err(|error| format!("LISTEN_ADDR is invalid: {error}"))?;
        let encryption_key = env::var("KUST_ENCRYPTION_KEY")
            .unwrap_or_else(|_| "kust-local-development-key-change-me".into());

        if encryption_key.len() < 24 {
            return Err("KUST_ENCRYPTION_KEY must contain at least 24 characters".into());
        }

        Ok(Self {
            listen_addr,
            mongodb_uri: env::var("MONGODB_URI")
                .unwrap_or_else(|_| "mongodb://127.0.0.1:27017".into()),
            mongodb_database: env::var("MONGODB_DATABASE").unwrap_or_else(|_| "kust".into()),
            encryption_key,
            cors_origin: env::var("CORS_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".into()),
        })
    }
}
