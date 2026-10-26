use std::path::PathBuf;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::aws::context::GLOBAL_REGION;
use crate::commands::AppState;
use crate::error::AppError;
use crate::topology::{fetch, VpcTopology};

const MAX_PNG_BYTES: usize = 50 * 1024 * 1024;

fn region_or_default(region: &str) -> &str {
    if region.is_empty() { GLOBAL_REGION } else { region }
}

#[tauri::command]
pub async fn vpc_topology(
    state: State<'_, AppState>,
    profile: String,
    region: String,
    vpc_id: String,
) -> Result<VpcTopology, AppError> {
    let region = region_or_default(&region);
    let cfg = state.ctx.config(&profile, region).await?;
    fetch::fetch(&cfg, region, &vpc_id).await
}

fn with_png_extension(mut path: PathBuf) -> PathBuf {
    let is_png = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("png"));
    if !is_png {
        let mut name = path.as_os_str().to_owned();
        name.push(".png");
        path = PathBuf::from(name);
    }
    path
}

/// 네이티브 저장 대화상자를 Rust에서 띄우고, 사용자가 고른 경로에만 쓴다.
#[tauri::command]
pub async fn save_png(app: AppHandle, default_name: String, data: Vec<u8>) -> Result<bool, AppError> {
    if data.len() > MAX_PNG_BYTES {
        return Err(AppError::other("이미지가 너무 커요"));
    }
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(default_name)
            .add_filter("PNG", &["png"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?;
    let Some(picked) = picked else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| AppError::other(e.to_string()))?;
    let path = with_png_extension(path);
    tokio::fs::write(&path, &data)
        .await
        .map_err(|e| AppError::other(format!("파일을 저장하지 못했어요: {e}")))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_png_extension_when_missing() {
        assert_eq!(with_png_extension(PathBuf::from("/tmp/a")), PathBuf::from("/tmp/a.png"));
        assert_eq!(with_png_extension(PathBuf::from("/tmp/a.jpg")), PathBuf::from("/tmp/a.jpg.png"));
        assert_eq!(with_png_extension(PathBuf::from("/tmp/a.PNG")), PathBuf::from("/tmp/a.PNG"));
    }
}
