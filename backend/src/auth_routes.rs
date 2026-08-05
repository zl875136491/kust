use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use futures::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, DateTime};

use crate::{
    auth,
    error::AppError,
    models::{
        AuthCapabilitiesResponse, AuthCodeDocument, AuthStateResponse, ChangePasswordRequest,
        CodeLoginRequest, LoginRequest, PlatformSettingsResponse, RegisterRequest,
        RegistrationProfileResponse, ResetPasswordRequest, RoleDocument, RoleResponse,
        RoleUpdateRequest, TotpSetupResponse, TotpVerifyRequest, UpdatePlatformSettingsRequest,
        UpdateSettingsRequest, UserDocument, UserResponse, UserSettingsDocument,
        UserSettingsResponse, UserStatusRequest, UsernameRequest,
    },
    state::SharedState,
};

pub async fn auth_capabilities(State(state): State<SharedState>) -> Json<AuthCapabilitiesResponse> {
    let settings = state.platform_config.read().await;
    Json(AuthCapabilitiesResponse {
        registration_enabled: settings.registration_enabled,
        oa_login_enabled: settings.oa_login_enabled && state.config.oa_user_info_url.is_some(),
    })
}

pub async fn registration_lookup(
    State(state): State<SharedState>,
    Json(request): Json<UsernameRequest>,
) -> Result<Json<RegistrationProfileResponse>, AppError> {
    ensure_registration_enabled(&state).await?;
    let username = normalized_username(&request.username)?;
    Ok(Json(registration_profile(&state, &username).await?))
}

pub async fn register(
    State(state): State<SharedState>,
    Json(request): Json<RegisterRequest>,
) -> Result<impl IntoResponse, AppError> {
    ensure_registration_enabled(&state).await?;
    let username = normalized_username(&request.username)?;
    if request.password != request.password_confirmation {
        return Err(AppError::bad_request("两次输入的密码不一致"));
    }
    let profile = registration_profile(&state, &username).await?;
    let existing = state
        .users
        .find_one(doc! { "$or": [{ "username": &username }, { "itcode": &username }] })
        .await?;
    let password_hash = auth::hash_password(&request.password)?;
    let now = DateTime::now();
    let default_role = state.platform_config.read().await.default_role.clone();
    let user = match existing {
        Some(mut user) => {
            if !user.password_unset || user.disabled {
                return Err(AppError::conflict("该用户名已注册"));
            }
            user.username = profile.username.clone();
            user.display_name = profile.display_name.clone();
            user.real_name = profile.real_name.clone();
            user.email = profile.email.clone();
            user.itcode = Some(profile.itcode.clone());
            user.source = "oa".into();
            user.password_hash = password_hash;
            user.password_unset = false;
            user.updated_at = now;
            user.last_login_at = Some(now);
            let update = state
                .users
                .replace_one(
                    doc! { "_id": user.id, "password_unset": true, "disabled": false },
                    &user,
                )
                .await?;
            if update.matched_count == 0 {
                return Err(AppError::conflict("该用户名已注册"));
            }
            get_or_create_settings(&state, user.id).await?;
            user
        }
        None => {
            let user = UserDocument {
                id: ObjectId::new(),
                username: profile.username,
                display_name: profile.display_name,
                real_name: profile.real_name,
                email: profile.email,
                itcode: Some(profile.itcode),
                source: "oa".into(),
                password_hash,
                password_unset: false,
                roles: vec![default_role],
                disabled: false,
                totp_secret_encrypted: None,
                totp_enabled: false,
                totp_required_since: None,
                two_factor_remember_days: 30,
                created_at: now,
                updated_at: now,
                last_login_at: Some(now),
            };
            state.users.insert_one(&user).await?;
            state
                .user_settings
                .insert_one(UserSettingsDocument::new(user.id))
                .await?;
            user
        }
    };
    let next = login_stage(&user, false);
    let token = auth::create_session(&state, user.id, next).await?;
    Ok((
        StatusCode::CREATED,
        Json(auth_state(&user, next, Some(token), None)),
    ))
}

pub async fn login(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(request): Json<LoginRequest>,
) -> Result<Json<AuthStateResponse>, AppError> {
    let username = normalized_username(&request.username)?;
    let mut user = state
        .users
        .find_one(doc! {
            "$or": [{ "username": &username }, { "itcode": &username }],
            "disabled": false
        })
        .await?
        .ok_or_else(|| AppError::unauthorized("username or password is incorrect"))?;
    if user.password_unset || !auth::verify_password(&user.password_hash, &request.password) {
        return Err(AppError::unauthorized("username or password is incorrect"));
    }
    let trusted = auth::has_trusted_device(&state, &headers, user.id).await?;
    let next = login_stage(&user, trusted);
    let token = auth::create_session(&state, user.id, next).await?;
    user.last_login_at = Some(DateTime::now());
    user.updated_at = DateTime::now();
    state
        .users
        .replace_one(doc! { "_id": user.id }, &user)
        .await?;
    Ok(Json(auth_state(&user, next, Some(token), None)))
}

pub async fn me(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<AuthStateResponse>, AppError> {
    let auth = auth::authenticate(&state, &headers, "").await?;
    Ok(Json(auth_state(
        &auth.user,
        &auth.session.stage,
        None,
        None,
    )))
}

pub async fn logout(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<StatusCode, AppError> {
    let auth = auth::authenticate(&state, &headers, "").await?;
    state
        .sessions
        .delete_one(doc! { "_id": auth.session.id })
        .await?;
    if let Some(token) = headers
        .get("x-kust-trusted-device")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
    {
        state
            .trusted_devices
            .delete_one(doc! {
                "token_hash": auth::token_hash(token),
                "user_id": auth.user.id,
            })
            .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn oa_request(
    State(state): State<SharedState>,
    Json(request): Json<UsernameRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    {
        let settings = state.platform_config.read().await;
        if !settings.oa_login_enabled || state.config.oa_user_info_url.is_none() {
            return Err(AppError::forbidden("OA login is disabled"));
        }
    }
    let itcode = normalized_username(&request.username)?;
    let user = get_or_import_oa_user(&state, &itcode).await?;
    let code = create_auth_code(&state, user.id, "login").await?;
    send_oa_code(
        &state,
        &user,
        &code,
        "登录 Kust",
        "点击消息中的链接登录 Kust",
    )
    .await?;
    Ok(Json(serde_json::json!({
        "message": "登录链接已发送到 OA",
        "debugCode": state.config.expose_local_reset_codes.then_some(code)
    })))
}

pub async fn code_login(
    State(state): State<SharedState>,
    Json(request): Json<CodeLoginRequest>,
) -> Result<Json<AuthStateResponse>, AppError> {
    let user = consume_code(&state, &request.username, &request.code, "login").await?;
    let next = login_stage(&user, false);
    let token = auth::create_session(&state, user.id, next).await?;
    Ok(Json(auth_state(&user, next, Some(token), None)))
}

pub async fn password_request(
    State(state): State<SharedState>,
    Json(request): Json<UsernameRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let username = normalized_username(&request.username)?;
    let Some(user) = state
        .users
        .find_one(doc! { "$or": [{ "username": &username }, { "itcode": &username }] })
        .await?
    else {
        return Ok(Json(
            serde_json::json!({ "message": "如果账号存在，重置方式已发送" }),
        ));
    };
    let code = create_auth_code(&state, user.id, "password-reset").await?;
    let mut delivery = "administrator";
    if user.source == "oa" {
        send_oa_code(
            &state,
            &user,
            &code,
            "重置 Kust 密码",
            "点击消息中的链接重置密码",
        )
        .await?;
        delivery = "oa";
    }
    Ok(Json(serde_json::json!({
        "message": if delivery == "oa" { "重置链接已发送到 OA" } else { "请联系管理员获取重置码" },
        "delivery": delivery,
        "debugCode": state.config.expose_local_reset_codes.then_some(code)
    })))
}

pub async fn password_reset(
    State(state): State<SharedState>,
    Json(request): Json<ResetPasswordRequest>,
) -> Result<StatusCode, AppError> {
    let user = consume_code(&state, &request.username, &request.code, "password-reset").await?;
    let password_hash = auth::hash_password(&request.new_password)?;
    state
        .users
        .update_one(
            doc! { "_id": user.id },
            doc! { "$set": { "password_hash": password_hash, "password_unset": false, "updated_at": DateTime::now() } },
        )
        .await?;
    state
        .sessions
        .delete_many(doc! { "user_id": user.id })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn totp_setup(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<TotpSetupResponse>, AppError> {
    let auth = auth::authenticate(&state, &headers, "").await?;
    let secret = match auth.user.totp_secret_encrypted.as_deref() {
        Some(value) => state.secrets.decrypt(value)?,
        None => {
            let secret = auth::new_totp_secret();
            state
                .users
                .update_one(
                    doc! { "_id": auth.user.id },
                    doc! { "$set": { "totp_secret_encrypted": state.secrets.encrypt(&secret)?, "updated_at": DateTime::now() } },
                )
                .await?;
            secret
        }
    };
    Ok(Json(TotpSetupResponse {
        uri: auth::provisioning_uri(&auth.user, &secret),
        secret,
    }))
}

pub async fn totp_verify(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(request): Json<TotpVerifyRequest>,
) -> Result<Json<AuthStateResponse>, AppError> {
    let auth_context = auth::authenticate(&state, &headers, "").await?;
    let encrypted = auth_context
        .user
        .totp_secret_encrypted
        .as_deref()
        .ok_or_else(|| AppError::bad_request("two-factor setup has not started"))?;
    let secret = state.secrets.decrypt(encrypted)?;
    if !auth::verify_totp(&secret, &request.code) {
        return Err(AppError::unauthorized("verification code is incorrect"));
    }
    let now = DateTime::now();
    state
        .users
        .update_one(
            doc! { "_id": auth_context.user.id },
            doc! { "$set": { "totp_enabled": true, "totp_required_since": null, "updated_at": now } },
        )
        .await?;
    state
        .sessions
        .update_one(
            doc! { "_id": auth_context.session.id },
            doc! { "$set": {
                "stage": "authenticated",
                "expires_at": DateTime::from_millis(
                    now.timestamp_millis()
                        + state.platform_config.read().await.session_timeout_hours.clamp(1, 72)
                            * 60 * 60 * 1_000
                )
            } },
        )
        .await?;
    let mut user = auth_context.user;
    user.totp_enabled = true;
    user.totp_required_since = None;
    let trusted = auth::create_trusted_device(&state, &user).await?;
    Ok(Json(auth_state(
        &user,
        "authenticated",
        None,
        Some(trusted),
    )))
}

pub async fn settings(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<UserSettingsResponse>, AppError> {
    let auth = auth::authenticate(&state, &headers, "authenticated").await?;
    let settings = get_or_create_settings(&state, auth.user.id).await?;
    Ok(Json(settings_response(&settings, &auth.user)))
}

pub async fn update_settings(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(request): Json<UpdateSettingsRequest>,
) -> Result<Json<UserSettingsResponse>, AppError> {
    let mut auth = auth::authenticate(&state, &headers, "authenticated").await?;
    if !matches!(request.theme.as_str(), "system" | "light" | "dark") {
        return Err(AppError::bad_request("theme is invalid"));
    }
    if !matches!(
        request.shell_theme.as_str(),
        "system"
            | "light"
            | "dark"
            | "one-dark"
            | "dracula"
            | "solarized-dark"
            | "nord"
            | "gruvbox-dark"
            | "tokyo-night"
    ) {
        return Err(AppError::bad_request("shell theme is invalid"));
    }
    if !(10..=200).contains(&request.page_size) {
        return Err(AppError::bad_request(
            "page size must be between 10 and 200",
        ));
    }
    let max_days = if auth.user.is_admin() { 15 } else { 30 };
    if auth.user.is_admin() && !request.two_factor_enabled {
        return Err(AppError::forbidden(
            "administrators cannot disable two-factor authentication",
        ));
    }
    if request.two_factor_enabled && !(1..=max_days).contains(&request.two_factor_remember_days) {
        return Err(AppError::bad_request(format!(
            "two-factor remember period must be between 1 and {max_days} days"
        )));
    }
    if request.two_factor_enabled && !auth.user.totp_enabled {
        return Err(AppError::bad_request(
            "complete two-factor enrollment before enabling it",
        ));
    }
    let mut settings = get_or_create_settings(&state, auth.user.id).await?;
    settings.theme = request.theme;
    settings.shell_theme = request.shell_theme;
    settings.pointer_highlight = request.pointer_highlight;
    settings.refraction = request.refraction;
    settings.backdrop_blur = request.backdrop_blur;
    settings.hover_motion = request.hover_motion;
    settings.auto_refresh = request.auto_refresh;
    settings.page_size = request.page_size;
    settings.window_close_confirmation = request.window_close_confirmation;
    settings.updated_at = DateTime::now();
    state
        .user_settings
        .replace_one(doc! { "_id": settings.id }, &settings)
        .await?;
    auth.user.two_factor_remember_days = request.two_factor_remember_days.clamp(1, max_days);
    if !request.two_factor_enabled {
        auth.user.totp_enabled = false;
        auth.user.totp_secret_encrypted = None;
        state
            .trusted_devices
            .delete_many(doc! { "user_id": auth.user.id })
            .await?;
    }
    auth.user.updated_at = DateTime::now();
    state
        .users
        .replace_one(doc! { "_id": auth.user.id }, &auth.user)
        .await?;
    Ok(Json(settings_response(&settings, &auth.user)))
}

pub async fn change_password(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(request): Json<ChangePasswordRequest>,
) -> Result<StatusCode, AppError> {
    let auth = auth::authenticate(&state, &headers, "authenticated").await?;
    if auth.user.password_unset
        || !auth::verify_password(&auth.user.password_hash, &request.current_password)
    {
        return Err(AppError::unauthorized("current password is incorrect"));
    }
    let password_hash = auth::hash_password(&request.new_password)?;
    state
        .users
        .update_one(
            doc! { "_id": auth.user.id },
            doc! { "$set": { "password_hash": password_hash, "updated_at": DateTime::now() } },
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn admin_users(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<Vec<UserResponse>>, AppError> {
    auth::require_admin(&state, &headers).await?;
    let users: Vec<UserDocument> = state
        .users
        .find(doc! {})
        .sort(doc! { "created_at": 1 })
        .await?
        .try_collect()
        .await?;
    Ok(Json(users.iter().map(UserDocument::response).collect()))
}

pub async fn admin_platform_settings(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<PlatformSettingsResponse>, AppError> {
    auth::require_admin(&state, &headers).await?;
    let settings = state.platform_config.read().await;
    Ok(Json(
        settings.response(state.config.oa_user_info_url.is_some()),
    ))
}

pub async fn update_platform_settings(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(request): Json<UpdatePlatformSettingsRequest>,
) -> Result<Json<PlatformSettingsResponse>, AppError> {
    let actor = auth::require_admin(&state, &headers).await?;
    validate_platform_settings(&request, state.config.oa_user_info_url.is_some())?;
    let role_exists = state
        .roles
        .find_one(doc! { "name": &request.default_role })
        .await?
        .is_some();
    if !role_exists {
        return Err(AppError::bad_request("default role does not exist"));
    }

    let mut settings = state.platform_config.read().await.clone();
    settings.registration_enabled = request.registration_enabled;
    settings.oa_login_enabled = request.oa_login_enabled;
    settings.default_role = request.default_role;
    settings.cache_ttl_seconds = request.cache_ttl_seconds;
    settings.cache_sync_seconds = request.cache_sync_seconds;
    settings.session_timeout_hours = request.session_timeout_hours;
    settings.updated_at = DateTime::now();
    settings.updated_by = Some(actor.user.id);
    state
        .platform_settings
        .replace_one(doc! { "_id": &settings.id }, &settings)
        .await?;
    *state.platform_config.write().await = settings.clone();
    Ok(Json(
        settings.response(state.config.oa_user_info_url.is_some()),
    ))
}

pub async fn admin_roles(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RoleResponse>>, AppError> {
    auth::require_admin(&state, &headers).await?;
    let roles: Vec<RoleDocument> = state
        .roles
        .find(doc! {})
        .sort(doc! { "created_at": 1 })
        .await?
        .try_collect()
        .await?;
    Ok(Json(roles.iter().map(RoleDocument::response).collect()))
}

pub async fn update_roles(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
    Json(request): Json<RoleUpdateRequest>,
) -> Result<Json<UserResponse>, AppError> {
    let actor = auth::require_admin(&state, &headers).await?;
    let user_id =
        ObjectId::parse_str(&user_id).map_err(|_| AppError::bad_request("user id is invalid"))?;
    if request.roles.is_empty()
        || request
            .roles
            .iter()
            .any(|role| !matches!(role.as_str(), "admin" | "operator" | "viewer"))
    {
        return Err(AppError::bad_request("role selection is invalid"));
    }
    if actor.user.id == user_id && !request.roles.iter().any(|role| role == "admin") {
        return Err(AppError::forbidden(
            "you cannot remove your own administrator role",
        ));
    }
    let mut user = state
        .users
        .find_one(doc! { "_id": user_id })
        .await?
        .ok_or_else(|| AppError::not_found("user was not found"))?;
    let becoming_admin = !user.is_admin() && request.roles.iter().any(|role| role == "admin");
    user.roles = request.roles;
    if becoming_admin && !user.totp_enabled {
        user.totp_required_since = Some(DateTime::now());
        user.two_factor_remember_days = user.two_factor_remember_days.clamp(1, 15);
        state
            .sessions
            .delete_many(doc! { "user_id": user.id })
            .await?;
    }
    user.updated_at = DateTime::now();
    state
        .users
        .replace_one(doc! { "_id": user.id }, &user)
        .await?;
    Ok(Json(user.response()))
}

pub async fn update_user_status(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
    Json(request): Json<UserStatusRequest>,
) -> Result<Json<UserResponse>, AppError> {
    let actor = auth::require_admin(&state, &headers).await?;
    let user_id =
        ObjectId::parse_str(&user_id).map_err(|_| AppError::bad_request("user id is invalid"))?;
    if actor.user.id == user_id && request.disabled {
        return Err(AppError::forbidden("you cannot disable your own account"));
    }
    let mut user = state
        .users
        .find_one(doc! { "_id": user_id })
        .await?
        .ok_or_else(|| AppError::not_found("user was not found"))?;
    user.disabled = request.disabled;
    user.updated_at = DateTime::now();
    state
        .users
        .replace_one(doc! { "_id": user.id }, &user)
        .await?;
    if user.disabled {
        state
            .sessions
            .delete_many(doc! { "user_id": user.id })
            .await?;
        state
            .trusted_devices
            .delete_many(doc! { "user_id": user.id })
            .await?;
        state
            .auth_codes
            .delete_many(doc! { "user_id": user.id })
            .await?;
    }
    Ok(Json(user.response()))
}

pub async fn admin_reset_code(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    auth::require_admin(&state, &headers).await?;
    let user_id =
        ObjectId::parse_str(&user_id).map_err(|_| AppError::bad_request("user id is invalid"))?;
    let user = state
        .users
        .find_one(doc! { "_id": user_id })
        .await?
        .ok_or_else(|| AppError::not_found("user was not found"))?;
    if user.source != "local" {
        return Err(AppError::bad_request(
            "OA users must reset their password through OA",
        ));
    }
    let code = create_auth_code(&state, user.id, "password-reset").await?;
    Ok(Json(serde_json::json!({
        "username": user.username,
        "code": code,
        "expiresInMinutes": 30
    })))
}

fn auth_state(
    user: &UserDocument,
    next: &str,
    token: Option<String>,
    trusted_device_token: Option<String>,
) -> AuthStateResponse {
    AuthStateResponse {
        user: user.response(),
        next: next.into(),
        token,
        trusted_device_token,
    }
}

fn login_stage(user: &UserDocument, trusted: bool) -> &'static str {
    if user.is_admin() && !user.totp_enabled {
        "enroll"
    } else if user.totp_enabled && !trusted {
        "two_factor"
    } else {
        "authenticated"
    }
}

async fn ensure_registration_enabled(state: &SharedState) -> Result<(), AppError> {
    if !state.platform_config.read().await.registration_enabled {
        return Err(AppError::forbidden("user registration is disabled"));
    }
    Ok(())
}

fn validate_platform_settings(
    request: &UpdatePlatformSettingsRequest,
    oa_user_source_configured: bool,
) -> Result<(), AppError> {
    if !matches!(request.default_role.as_str(), "operator" | "viewer") {
        return Err(AppError::bad_request(
            "default role must be operator or viewer",
        ));
    }
    if request.oa_login_enabled && !oa_user_source_configured {
        return Err(AppError::bad_request("OA user source is not configured"));
    }
    if !(15..=600).contains(&request.cache_ttl_seconds) {
        return Err(AppError::bad_request(
            "cache TTL must be between 15 and 600 seconds",
        ));
    }
    if !(15..=3_600).contains(&request.cache_sync_seconds) {
        return Err(AppError::bad_request(
            "cache sync period must be between 15 and 3600 seconds",
        ));
    }
    if !(1..=72).contains(&request.session_timeout_hours) {
        return Err(AppError::bad_request(
            "session timeout must be between 1 and 72 hours",
        ));
    }
    Ok(())
}

fn normalized_username(value: &str) -> Result<String, AppError> {
    let value = value.trim().to_lowercase();
    if value.len() < 3
        || value.len() > 64
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err(AppError::bad_request(
            "username must be 3-64 letters, numbers, dots, dashes or underscores",
        ));
    }
    Ok(value)
}

async fn get_or_create_settings(
    state: &SharedState,
    user_id: ObjectId,
) -> Result<UserSettingsDocument, AppError> {
    if let Some(settings) = state
        .user_settings
        .find_one(doc! { "user_id": user_id })
        .await?
    {
        return Ok(settings);
    }
    let settings = UserSettingsDocument::new(user_id);
    state.user_settings.insert_one(&settings).await?;
    Ok(settings)
}

fn settings_response(settings: &UserSettingsDocument, user: &UserDocument) -> UserSettingsResponse {
    UserSettingsResponse {
        theme: settings.theme.clone(),
        shell_theme: settings.shell_theme.clone(),
        pointer_highlight: settings.pointer_highlight,
        refraction: settings.refraction,
        backdrop_blur: settings.backdrop_blur,
        hover_motion: settings.hover_motion,
        auto_refresh: settings.auto_refresh,
        page_size: settings.page_size,
        window_close_confirmation: settings.window_close_confirmation,
        two_factor_enabled: user.totp_enabled,
        two_factor_required: user.is_admin(),
        two_factor_remember_days: user.two_factor_remember_days,
    }
}

async fn get_or_import_oa_user(
    state: &SharedState,
    itcode: &str,
) -> Result<UserDocument, AppError> {
    if let Some(user) = state.users.find_one(doc! { "itcode": itcode }).await? {
        return Ok(user);
    }
    ensure_registration_enabled(state).await?;
    let default_role = state.platform_config.read().await.default_role.clone();
    let profile = fetch_oa_profile(state, itcode).await?;
    let now = DateTime::now();
    let user = UserDocument {
        id: ObjectId::new(),
        username: profile.username,
        display_name: profile.display_name,
        real_name: profile.real_name,
        email: profile.email,
        itcode: Some(profile.itcode),
        source: "oa".into(),
        password_hash: String::new(),
        password_unset: true,
        roles: vec![default_role],
        disabled: false,
        totp_secret_encrypted: None,
        totp_enabled: false,
        totp_required_since: None,
        two_factor_remember_days: 30,
        created_at: now,
        updated_at: now,
        last_login_at: None,
    };
    state.users.insert_one(&user).await?;
    state
        .user_settings
        .insert_one(UserSettingsDocument::new(user.id))
        .await?;
    Ok(user)
}

async fn registration_profile(
    state: &SharedState,
    username: &str,
) -> Result<RegistrationProfileResponse, AppError> {
    let existing = state
        .users
        .find_one(doc! { "$or": [{ "username": username }, { "itcode": username }] })
        .await?;
    if let Some(user) = existing.as_ref() {
        if !user.password_unset || user.disabled {
            return Err(AppError::conflict("该用户名已注册"));
        }
    }
    if state.config.oa_user_info_url.is_some() {
        return fetch_oa_profile(state, username).await;
    }
    existing
        .filter(|user| user.source == "oa")
        .map(|user| RegistrationProfileResponse {
            username: user.username,
            display_name: user.display_name,
            real_name: user.real_name,
            email: user.email,
            itcode: user.itcode.unwrap_or_else(|| username.into()),
            source: "oa".into(),
        })
        .ok_or_else(|| AppError::upstream("OA 用户数据接口未配置"))
}

async fn fetch_oa_profile(
    state: &SharedState,
    itcode: &str,
) -> Result<RegistrationProfileResponse, AppError> {
    let url = state
        .config
        .oa_user_info_url
        .as_deref()
        .ok_or_else(|| AppError::upstream("OA 用户数据接口未配置"))?;
    let response = state
        .http
        .get(url)
        .query(&[("itcode", itcode)])
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .map_err(|error| AppError::upstream(format!("用户信息查询失败：{error}")))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err(AppError::not_found("未查询到该用户"));
    }
    if !response.status().is_success() {
        return Err(AppError::upstream(format!(
            "用户信息接口返回状态 {}",
            response.status()
        )));
    }
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| AppError::upstream(format!("用户信息响应格式无效：{error}")))?;
    parse_oa_profile(itcode, &payload)
}

fn parse_oa_profile(
    itcode: &str,
    payload: &serde_json::Value,
) -> Result<RegistrationProfileResponse, AppError> {
    let info = payload
        .get("user_info")
        .unwrap_or(payload)
        .as_object()
        .ok_or_else(|| AppError::not_found("未查询到该用户"))?;
    let field = |keys: &[&str]| {
        keys.iter().find_map(|key| {
            info.get(*key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
    };
    let display_name = field(&["cn", "display_name", "displayName"]);
    let real_name = field(&["l", "real_name", "realName"]);
    if display_name.is_none() && real_name.is_none() {
        return Err(AppError::not_found("未查询到该用户"));
    }
    Ok(RegistrationProfileResponse {
        username: itcode.into(),
        display_name: display_name.or(real_name).unwrap_or(itcode).into(),
        real_name: real_name.or(display_name).unwrap_or(itcode).into(),
        email: field(&["mail", "email"]).map(str::to_string),
        itcode: itcode.into(),
        source: "oa".into(),
    })
}

async fn create_auth_code(
    state: &SharedState,
    user_id: ObjectId,
    purpose: &str,
) -> Result<String, AppError> {
    state
        .auth_codes
        .delete_many(doc! { "user_id": user_id, "purpose": purpose, "used_at": null })
        .await?;
    let code = auth::random_token(24);
    state
        .auth_codes
        .insert_one(AuthCodeDocument {
            id: ObjectId::new(),
            code_hash: auth::token_hash(&code),
            user_id,
            purpose: purpose.into(),
            created_at: DateTime::now(),
            expires_at: DateTime::from_millis(DateTime::now().timestamp_millis() + 30 * 60 * 1_000),
            used_at: None,
        })
        .await?;
    Ok(code)
}

async fn consume_code(
    state: &SharedState,
    username: &str,
    code: &str,
    purpose: &str,
) -> Result<UserDocument, AppError> {
    let username = normalized_username(username)?;
    let user = state
        .users
        .find_one(
            doc! { "$or": [{ "username": &username }, { "itcode": &username }], "disabled": false },
        )
        .await?
        .ok_or_else(|| AppError::unauthorized("code is invalid or expired"))?;
    let code = state
        .auth_codes
        .find_one(doc! {
            "user_id": user.id,
            "purpose": purpose,
            "code_hash": auth::token_hash(code),
            "used_at": null,
            "expires_at": { "$gt": DateTime::now() }
        })
        .await?
        .ok_or_else(|| AppError::unauthorized("code is invalid or expired"))?;
    state
        .auth_codes
        .update_one(
            doc! { "_id": code.id },
            doc! { "$set": { "used_at": DateTime::now() } },
        )
        .await?;
    Ok(user)
}

async fn send_oa_code(
    state: &SharedState,
    user: &UserDocument,
    code: &str,
    title: &str,
    content: &str,
) -> Result<(), AppError> {
    let itcode = user
        .itcode
        .as_deref()
        .ok_or_else(|| AppError::bad_request("user is not linked to OA"))?;
    let action = if title.contains("重置") {
        "reset-password"
    } else {
        "login-by-code"
    };
    let link = format!(
        "{}/{action}?username={}&code={}",
        state.config.frontend_url.trim_end_matches('/'),
        url::form_urlencoded::byte_serialize(itcode.as_bytes()).collect::<String>(),
        url::form_urlencoded::byte_serialize(code.as_bytes()).collect::<String>()
    );
    let endpoint = format!(
        "{}/send_gquan_msg/{}",
        state.config.oa_springboard_url.trim_end_matches('/'),
        state.config.oa_springboard_app
    );
    let response = state
        .http
        .post(endpoint)
        .form(&[
            ("msg_type", "AGENDA"),
            ("to_itcode", itcode),
            ("title", title),
            ("desc", content),
            ("content_or_url", link.as_str()),
        ])
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| AppError::upstream(format!("unable to send OA message: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::upstream("OA message delivery failed"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::models::UpdatePlatformSettingsRequest;

    use super::{parse_oa_profile, validate_platform_settings};

    #[test]
    fn parses_registration_profile_from_oa_payload() {
        let profile = parse_oa_profile(
            "zhangle",
            &json!({
                "user_info": {
                    "cn": "Zhang Le",
                    "l": "张乐",
                    "mail": "zhangle@example.com"
                }
            }),
        )
        .expect("profile should parse");

        assert_eq!(profile.username, "zhangle");
        assert_eq!(profile.display_name, "Zhang Le");
        assert_eq!(profile.real_name, "张乐");
        assert_eq!(profile.email.as_deref(), Some("zhangle@example.com"));
        assert_eq!(profile.itcode, "zhangle");
    }

    #[test]
    fn rejects_oa_payload_without_identity_fields() {
        assert!(parse_oa_profile("missing", &json!({ "user_info": {} })).is_err());
    }

    #[test]
    fn validates_platform_settings_bounds_and_default_role() {
        let valid = UpdatePlatformSettingsRequest {
            registration_enabled: true,
            oa_login_enabled: true,
            default_role: "viewer".into(),
            cache_ttl_seconds: 45,
            cache_sync_seconds: 60,
            session_timeout_hours: 12,
        };
        assert!(validate_platform_settings(&valid, true).is_ok());

        let invalid = UpdatePlatformSettingsRequest {
            default_role: "admin".into(),
            cache_sync_seconds: 5,
            ..valid
        };
        assert!(validate_platform_settings(&invalid, true).is_err());
    }
}
