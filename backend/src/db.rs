use mongodb::{
    bson::doc,
    options::{ClientOptions, IndexOptions},
    Client, IndexModel,
};

use crate::{config::AppConfig, error::AppError, models::ClusterDocument};

pub async fn connect(config: &AppConfig) -> Result<mongodb::Database, AppError> {
    let mut options = ClientOptions::parse(&config.mongodb_uri).await?;
    options.app_name = Some("kust-api".into());
    let client = Client::with_options(options)?;
    let database = client.database(&config.mongodb_database);
    database.run_command(doc! { "ping": 1 }).await?;

    let clusters = database.collection::<ClusterDocument>("clusters");
    let unique_name = IndexModel::builder()
        .keys(doc! { "name": 1 })
        .options(IndexOptions::builder().unique(true).build())
        .build();
    clusters.create_index(unique_name).await?;

    Ok(database)
}
