use mongodb::{
    bson::doc,
    options::{ClientOptions, IndexOptions},
    Client, Database, IndexModel,
};

use crate::{
    config::AppConfig,
    error::AppError,
    models::{PlatformSettingsDocument, USER_SETTINGS_VISUAL_EFFECTS_VERSION},
};

pub async fn connect(config: &AppConfig) -> Result<Database, AppError> {
    let mut options = ClientOptions::parse(&config.mongodb_uri).await?;
    options.app_name = Some("kust-api".into());
    options.connect_timeout = Some(std::time::Duration::from_secs(8));
    options.server_selection_timeout = Some(std::time::Duration::from_secs(8));
    let client = Client::with_options(options)?;
    let database = client.database(&config.mongodb_database);
    database.run_command(doc! { "ping": 1 }).await?;
    create_indexes(&database).await?;
    seed_roles(&database).await?;
    migrate_user_settings(&database).await?;
    Ok(database)
}

pub async fn load_platform_settings(
    database: &Database,
    config: &AppConfig,
) -> Result<PlatformSettingsDocument, AppError> {
    let settings = database.collection::<PlatformSettingsDocument>("platform_settings");
    let cache_ttl_seconds = config.cache_ttl_seconds.clamp(15, 600) as i64;
    let cache_sync_seconds = config.cache_sync_seconds.clamp(15, 3_600) as i64;
    settings
        .update_one(
            doc! { "_id": "global" },
            doc! { "$setOnInsert": {
                "registration_enabled": true,
                "oa_login_enabled": true,
                "default_role": "viewer",
                "cache_ttl_seconds": cache_ttl_seconds,
                "cache_sync_seconds": cache_sync_seconds,
                "session_timeout_hours": 12_i64,
                "updated_at": mongodb::bson::DateTime::now(),
                "updated_by": null,
            } },
        )
        .upsert(true)
        .await?;
    settings
        .find_one(doc! { "_id": "global" })
        .await?
        .ok_or_else(|| AppError::internal("platform settings were not initialized"))
}

async fn create_indexes(database: &Database) -> Result<(), AppError> {
    unique(database, "clusters", doc! { "name": 1 }, None).await?;
    unique(
        database,
        "clusters",
        doc! { "preset_key": 1 },
        Some(doc! { "preset_key": { "$type": "string" } }),
    )
    .await?;
    unique(database, "users", doc! { "username": 1 }, None).await?;
    unique(
        database,
        "users",
        doc! { "itcode": 1 },
        Some(doc! { "itcode": { "$type": "string" } }),
    )
    .await?;
    unique(database, "roles", doc! { "name": 1 }, None).await?;
    unique(database, "sessions", doc! { "token_hash": 1 }, None).await?;
    unique(database, "trusted_devices", doc! { "token_hash": 1 }, None).await?;
    unique(database, "user_settings", doc! { "user_id": 1 }, None).await?;
    unique(
        database,
        "resource_snapshots",
        doc! { "cluster_id": 1, "kind": 1 },
        None,
    )
    .await?;
    index(
        database,
        "resource_snapshots",
        doc! { "cluster_id": 1, "synced_at": -1 },
    )
    .await?;
    index(database, "audit_logs", doc! { "created_at": -1 }).await?;
    index(
        database,
        "audit_logs",
        doc! { "actor_user_id": 1, "action": 1 },
    )
    .await?;
    ttl(database, "sessions", "expires_at").await?;
    ttl(database, "trusted_devices", "expires_at").await?;
    ttl(database, "auth_codes", "expires_at").await?;
    Ok(())
}

async fn migrate_user_settings(database: &Database) -> Result<(), AppError> {
    let settings = database.collection::<mongodb::bson::Document>("user_settings");
    settings
        .update_many(
            doc! { "visual_effects_version": { "$ne": USER_SETTINGS_VISUAL_EFFECTS_VERSION } },
            doc! { "$set": {
                "pointer_highlight": false,
                "refraction": false,
                "backdrop_blur": true,
                "hover_motion": true,
                "visual_effects_version": USER_SETTINGS_VISUAL_EFFECTS_VERSION,
                "updated_at": mongodb::bson::DateTime::now(),
            } },
        )
        .await?;
    settings
        .update_many(
            doc! { "shell_theme": { "$exists": false } },
            doc! { "$set": {
                "shell_theme": "system",
                "updated_at": mongodb::bson::DateTime::now(),
            } },
        )
        .await?;
    Ok(())
}

async fn unique(
    database: &Database,
    collection: &str,
    keys: mongodb::bson::Document,
    partial: Option<mongodb::bson::Document>,
) -> Result<(), AppError> {
    let options = IndexOptions::builder()
        .unique(true)
        .partial_filter_expression(partial)
        .build();
    database
        .collection::<mongodb::bson::Document>(collection)
        .create_index(IndexModel::builder().keys(keys).options(options).build())
        .await?;
    Ok(())
}

async fn index(
    database: &Database,
    collection: &str,
    keys: mongodb::bson::Document,
) -> Result<(), AppError> {
    database
        .collection::<mongodb::bson::Document>(collection)
        .create_index(IndexModel::builder().keys(keys).build())
        .await?;
    Ok(())
}

async fn ttl(database: &Database, collection: &str, field: &str) -> Result<(), AppError> {
    let options = IndexOptions::builder()
        .expire_after(Some(std::time::Duration::from_secs(0)))
        .build();
    let mut keys = mongodb::bson::Document::new();
    keys.insert(field, 1);
    database
        .collection::<mongodb::bson::Document>(collection)
        .create_index(IndexModel::builder().keys(keys).options(options).build())
        .await?;
    Ok(())
}

async fn seed_roles(database: &Database) -> Result<(), AppError> {
    let roles = database.collection::<mongodb::bson::Document>("roles");
    let now = mongodb::bson::DateTime::now();
    for (name, label, permissions) in [
        (
            "admin",
            "管理员",
            vec!["clusters:*", "resources:*", "users:*", "settings:*"],
        ),
        (
            "operator",
            "运维人员",
            vec![
                "clusters:read",
                "resources:read",
                "resources:write",
                "settings:write",
            ],
        ),
        (
            "viewer",
            "只读用户",
            vec!["clusters:read", "resources:read", "settings:write"],
        ),
    ] {
        roles
            .update_one(
                doc! { "name": name },
                doc! {
                    "$set": { "label": label, "permissions": permissions, "built_in": true, "updated_at": now },
                    "$setOnInsert": { "_id": mongodb::bson::oid::ObjectId::new(), "created_at": now }
                },
            )
            .upsert(true)
            .await?;
    }
    Ok(())
}
