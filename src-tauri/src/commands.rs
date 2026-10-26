use std::io::ErrorKind;
use std::path::PathBuf;

use tauri::State;
use tokio::process::Command;

use crate::adapters::{effective_region, find_adapter, service_info, AdapterRef};
use crate::adapters::s3::{self, S3Listing};
use crate::aws::context::{self, AwsContext, ProfileInfo};
use crate::error::AppError;
use crate::model::{ListResult, ServiceInfo};
use crate::settings::{self, Settings};

pub struct AppState {
    pub ctx: AwsContext,
    pub adapters: Vec<AdapterRef>,
    pub settings_path: PathBuf,
}

impl AppState {
    fn service_ids(&self) -> Vec<&'static str> {
        self.adapters.iter().map(|a| a.service_id()).collect()
    }
}

/// Finder에서 실행하면 PATH가 짧으므로 Homebrew 경로도 시도한다.
const AWS_CLI_CANDIDATES: [&str; 3] = ["aws", "/opt/homebrew/bin/aws", "/usr/local/bin/aws"];

#[tauri::command]
pub fn list_profiles() -> Vec<ProfileInfo> {
    context::list_profiles()
}

#[tauri::command]
pub async fn get_account(state: State<'_, AppState>, profile: String) -> Result<String, AppError> {
    state.ctx.account_id(&profile).await
}

#[tauri::command]
pub fn list_services(state: State<'_, AppState>) -> Vec<ServiceInfo> {
    state.adapters.iter().map(|a| service_info(a.as_ref())).collect()
}

#[tauri::command]
pub async fn list_resources(
    state: State<'_, AppState>,
    profile: String,
    region: String,
    service: String,
    type_id: String,
) -> Result<ListResult, AppError> {
    let adapter = find_adapter(&state.adapters, &service)?;
    let cfg = state.ctx.config(&profile, effective_region(adapter.as_ref(), &region)).await?;
    adapter.list(&cfg, &type_id).await
}

#[tauri::command]
pub async fn sso_login(state: State<'_, AppState>, profile: String) -> Result<(), AppError> {
    for bin in AWS_CLI_CANDIDATES {
        match Command::new(bin).args(["sso", "login", "--profile", &profile]).status().await {
            Ok(status) if status.success() => {
                state.ctx.forget_profile(&profile).await;
                return Ok(());
            }
            Ok(status) => return Err(AppError::other(format!("aws sso login이 실패했어요 ({status})"))),
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return Err(AppError::other(e.to_string())),
        }
    }
    Err(AppError::other("aws CLI를 찾을 수 없어요"))
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    settings::load(&state.settings_path, &state.service_ids())
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), AppError> {
    settings::save(&state.settings_path, &settings)
}

#[tauri::command]
pub async fn list_s3_objects(
    state: State<'_, AppState>,
    profile: String,
    region: String,
    bucket: String,
    prefix: String,
    continuation_token: Option<String>,
) -> Result<S3Listing, AppError> {
    let region = if region.is_empty() { context::GLOBAL_REGION.to_string() } else { region };
    let cfg = state.ctx.config(&profile, &region).await?;
    s3::list_objects(&cfg, &bucket, &prefix, continuation_token).await
}
