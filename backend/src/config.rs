use std::{collections::HashMap, env, fs, net::SocketAddr, path::PathBuf};

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub listen_addr: SocketAddr,
    pub mongodb_uri: String,
    pub mongodb_database: String,
    pub encryption_key: String,
    pub cors_origin: String,
    pub preset_config_path: PathBuf,
    pub cache_ttl_seconds: u64,
    pub cache_sync_seconds: u64,
    pub oa_user_info_url: Option<String>,
    pub oa_springboard_url: String,
    pub oa_springboard_app: String,
    pub frontend_url: String,
    pub expose_local_reset_codes: bool,
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

        let mongo_file_path = env::var_os("MONGODB_CONFIG_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../mongodb.txt"));
        let mongo_file = if mongo_file_path.exists() {
            read_key_value_file(&mongo_file_path)?
        } else {
            HashMap::new()
        };
        let oa_file_path = env::var_os("OA_CONFIG_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../oa_auth.txt"));
        let oa_file = if oa_file_path.exists() {
            read_loose_assignments(&oa_file_path)?
        } else {
            HashMap::new()
        };
        let mongodb_database = env::var("MONGODB_DATABASE")
            .ok()
            .or_else(|| mongo_file.get("MONGO_DB_NAME").cloned())
            .unwrap_or_else(|| "kust".into());
        let mongodb_uri = match env::var("MONGODB_URI") {
            Ok(uri) => uri,
            Err(_) if !mongo_file.is_empty() => {
                mongo_uri_from_file(&mongo_file, &mongodb_database)?
            }
            Err(_) => "mongodb://127.0.0.1:27017".into(),
        };
        let cors_origin =
            env::var("CORS_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".into());

        Ok(Self {
            listen_addr,
            mongodb_uri,
            mongodb_database,
            encryption_key,
            frontend_url: configured_value("FRONT_URL", &["FRONT_URL"], &oa_file)
                .unwrap_or_else(|| cors_origin.clone()),
            cors_origin,
            preset_config_path: preset_config_path_from_env(),
            cache_ttl_seconds: env_u64("KUST_CACHE_TTL_SECONDS", 45)?,
            cache_sync_seconds: env_u64("KUST_CACHE_SYNC_SECONDS", 60)?,
            oa_user_info_url: configured_value(
                "OA_USER_INFO_URL",
                &["OA_USER_INFO_URL", "USER_INFO_URL"],
                &oa_file,
            )
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
            oa_springboard_url: configured_value("SPRINGBOARD_URL", &["SPRINGBOARD_URL"], &oa_file)
                .unwrap_or_else(|| "http://tl.cooacloud.com/springboard_v3".into()),
            oa_springboard_app: configured_value("SPRINGBOARD_APP", &["SPRINGBOARD_APP"], &oa_file)
                .unwrap_or_else(|| "kust".into()),
            expose_local_reset_codes: env_bool("KUST_EXPOSE_LOCAL_RESET_CODES", false),
        })
    }
}

fn configured_value(
    environment_key: &str,
    file_keys: &[&str],
    values: &HashMap<String, String>,
) -> Option<String> {
    env::var(environment_key)
        .ok()
        .or_else(|| file_keys.iter().find_map(|key| values.get(*key).cloned()))
}

fn read_loose_assignments(path: &PathBuf) -> Result<HashMap<String, String>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("unable to read {}: {error}", path.display()))?;
    Ok(parse_loose_assignments(&content))
}

fn parse_loose_assignments(content: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for line in content.lines() {
        let Some((key, raw_value)) = line.trim().split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|character| character.is_ascii_uppercase() || character == '_')
        {
            continue;
        }
        let raw_value = raw_value.trim().trim_end_matches(',').trim();
        let quoted = raw_value.len() >= 2
            && matches!(
                (
                    raw_value.as_bytes()[0],
                    raw_value.as_bytes()[raw_value.len() - 1]
                ),
                (b'"', b'"') | (b'\'', b'\'')
            );
        if quoted {
            values
                .entry(key.to_string())
                .or_insert_with(|| unquote(raw_value).to_string());
        }
    }
    values
}

fn read_key_value_file(path: &PathBuf) -> Result<HashMap<String, String>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("unable to read {}: {error}", path.display()))?;
    let mut values = HashMap::new();
    for (index, raw) in content.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| format!("{} line {} is not KEY=VALUE", path.display(), index + 1))?;
        values.insert(key.trim().to_string(), unquote(value.trim()).to_string());
    }
    Ok(values)
}

fn unquote(value: &str) -> &str {
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if matches!(
            (bytes[0], bytes[value.len() - 1]),
            (b'"', b'"') | (b'\'', b'\'')
        ) {
            return &value[1..value.len() - 1];
        }
    }
    value
}

fn mongo_uri_from_file(values: &HashMap<String, String>, database: &str) -> Result<String, String> {
    let required = |key: &str| {
        values
            .get(key)
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or_else(|| format!("mongodb config is missing {key}"))
    };
    let host = required("MONGO_DB_HOST")?;
    let port = required("MONGO_DB_PORT")?;
    let username = required("MONGO_DB_USER")?;
    let password = required("MONGO_DB_PASSWD")?;
    let auth_source = env::var("MONGODB_AUTH_SOURCE")
        .ok()
        .or_else(|| values.get("MONGO_DB_AUTH_SOURCE").cloned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "admin".into());
    let encode =
        |value: &str| url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
    Ok(format!(
        "mongodb://{}:{}@{}:{}/{}?authSource={}",
        encode(&username),
        encode(&password),
        host,
        port,
        encode(database),
        encode(&auth_source)
    ))
}

fn env_u64(key: &str, default: u64) -> Result<u64, String> {
    env::var(key)
        .ok()
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|error| format!("{key} is invalid: {error}"))
        })
        .transpose()
        .map(|value| value.unwrap_or(default))
}

fn env_bool(key: &str, default: bool) -> bool {
    env::var(key)
        .ok()
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}

fn preset_config_path_from_env() -> PathBuf {
    env::var_os("KUST_PRESET_CONFIG_DIR")
        .or_else(|| env::var_os("KUST_PRESET_CONFIG_PATH"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tj_config"))
}

#[cfg(test)]
mod tests {
    use super::{parse_loose_assignments, unquote};

    #[test]
    fn strips_matching_config_quotes() {
        assert_eq!(unquote("\"mongo.internal\""), "mongo.internal");
        assert_eq!(unquote("'kust'"), "kust");
        assert_eq!(unquote("plain"), "plain");
    }

    #[test]
    fn reads_only_literal_assignments_from_oa_notes() {
        let values = parse_loose_assignments(
            "SPRINGBOARD_URL = \"https://oa.example\"\nSPRINGBOARD_URL = settings.URL\nignored = \"x\"",
        );
        assert_eq!(
            values.get("SPRINGBOARD_URL").map(String::as_str),
            Some("https://oa.example")
        );
        assert!(!values.contains_key("ignored"));
    }
}
