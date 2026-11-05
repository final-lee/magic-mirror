use crate::error::AppError;
use crate::tailscale::{self, Diagnosis};

#[tauri::command]
pub async fn tailscale_diagnose(url: String) -> Result<Diagnosis, AppError> {
    tailscale::diagnose(url).await
}

#[tauri::command]
pub async fn tailscale_accept_routes(enabled: bool) -> Result<(), AppError> {
    tailscale::accept_routes(enabled).await
}
