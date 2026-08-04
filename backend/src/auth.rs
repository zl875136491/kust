use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{rand_core::RngCore, OsRng};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::http::HeaderMap;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use mongodb::bson::{doc, oid::ObjectId, DateTime};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::{
    error::AppError,
    models::{SessionDocument, TrustedDeviceDocument, UserDocument},
    state::SharedState,
};

const CHALLENGE_MINUTES: i64 = 10;

#[derive(Clone, Debug)]
pub struct AuthenticatedUser {
    pub user: UserDocument,
    pub session: SessionDocument,
}

pub fn hash_password(password: &str) -> Result<String, AppError> {
    if password.len() < 10 || password.len() > 256 {
        return Err(AppError::bad_request(
            "password must contain between 10 and 256 characters",
        ));
    }
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|value| value.to_string())
        .map_err(|_| AppError::internal("unable to hash password"))
}

pub fn verify_password(encoded: &str, password: &str) -> bool {
    PasswordHash::new(encoded).ok().is_some_and(|hash| {
        Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok()
    })
}

pub fn random_token(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub async fn create_session(
    state: &SharedState,
    user_id: ObjectId,
    stage: &str,
) -> Result<String, AppError> {
    let token = random_token(32);
    let minutes = if stage == "authenticated" {
        state
            .platform_config
            .read()
            .await
            .session_timeout_hours
            .clamp(1, 72)
            * 60
    } else {
        CHALLENGE_MINUTES
    };
    state
        .sessions
        .insert_one(SessionDocument {
            id: ObjectId::new(),
            token_hash: token_hash(&token),
            user_id,
            stage: stage.into(),
            created_at: DateTime::now(),
            expires_at: DateTime::from_millis(
                DateTime::now().timestamp_millis() + minutes * 60 * 1_000,
            ),
        })
        .await?;
    Ok(token)
}

pub async fn authenticate(
    state: &SharedState,
    headers: &HeaderMap,
    required_stage: &str,
) -> Result<AuthenticatedUser, AppError> {
    let token = bearer(headers)?;
    authenticate_token(state, token, required_stage).await
}

pub async fn authenticate_token(
    state: &SharedState,
    token: &str,
    required_stage: &str,
) -> Result<AuthenticatedUser, AppError> {
    let session = state
        .sessions
        .find_one(doc! {
            "token_hash": token_hash(token),
            "expires_at": { "$gt": DateTime::now() }
        })
        .await?
        .ok_or_else(|| AppError::unauthorized("session is invalid or expired"))?;
    if required_stage == "authenticated" && session.stage != required_stage {
        return Err(AppError::unauthorized(
            "additional authentication is required",
        ));
    }
    let user = state
        .users
        .find_one(doc! { "_id": session.user_id, "disabled": false })
        .await?
        .ok_or_else(|| AppError::unauthorized("user is unavailable"))?;
    Ok(AuthenticatedUser { user, session })
}

pub async fn has_trusted_device(
    state: &SharedState,
    headers: &HeaderMap,
    user_id: ObjectId,
) -> Result<bool, AppError> {
    let Some(token) = headers
        .get("x-kust-trusted-device")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
    else {
        return Ok(false);
    };
    Ok(state
        .trusted_devices
        .find_one(doc! {
            "token_hash": token_hash(token),
            "user_id": user_id,
            "expires_at": { "$gt": DateTime::now() }
        })
        .await?
        .is_some())
}

pub async fn create_trusted_device(
    state: &SharedState,
    user: &UserDocument,
) -> Result<String, AppError> {
    let max_days = if user.is_admin() { 15 } else { 30 };
    let days = user.two_factor_remember_days.clamp(1, max_days);
    let token = random_token(32);
    state
        .trusted_devices
        .insert_one(TrustedDeviceDocument {
            id: ObjectId::new(),
            token_hash: token_hash(&token),
            user_id: user.id,
            created_at: DateTime::now(),
            expires_at: DateTime::from_millis(
                DateTime::now().timestamp_millis() + i64::from(days) * 86_400_000,
            ),
        })
        .await?;
    Ok(token)
}

pub fn new_totp_secret() -> String {
    let mut value = [0_u8; 20];
    OsRng.fill_bytes(&mut value);
    BASE32_NOPAD.encode(&value)
}

pub fn verify_totp(secret: &str, code: &str) -> bool {
    let code = code.trim();
    if code.len() != 6 || !code.bytes().all(|value| value.is_ascii_digit()) {
        return false;
    }
    let expected = code.parse::<u32>().unwrap_or(u32::MAX);
    let step = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 30;
    (-1_i64..=1).any(|offset| totp(secret, step.saturating_add_signed(offset)) == Some(expected))
}

fn totp(secret: &str, step: u64) -> Option<u32> {
    let key = BASE32_NOPAD.decode(secret.as_bytes()).ok()?;
    let mut mac = Hmac::<Sha1>::new_from_slice(&key).ok()?;
    mac.update(&step.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = usize::from(digest[19] & 0x0f);
    let binary = (u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    Some(binary % 1_000_000)
}

pub fn provisioning_uri(user: &UserDocument, secret: &str) -> String {
    let issuer = encode_component("Kust");
    let account = encode_component(&user.username);
    format!(
        "otpauth://totp/{issuer}:{account}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits=6&period=30"
    )
}

fn encode_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn bearer(headers: &HeaderMap) -> Result<&str, AppError> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::unauthorized("authentication is required"))
}

pub async fn require_admin(
    state: &SharedState,
    headers: &HeaderMap,
) -> Result<AuthenticatedUser, AppError> {
    let auth = authenticate(state, headers, "authenticated").await?;
    if !auth.user.is_admin() {
        return Err(AppError::forbidden("administrator permission is required"));
    }
    Ok(auth)
}
