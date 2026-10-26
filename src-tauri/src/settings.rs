use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Favorite {
    pub service: String,
    #[serde(rename = "type")]
    pub type_id: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled_services: Vec<String>,
    pub favorites: Vec<Favorite>,
    pub last_profile: Option<String>,
    pub last_region: Option<String>,
    pub explorer_local_path: Option<String>,
    pub diff_tool: Option<String>,
    pub diff_tool_command: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawSettings {
    enabled_services: Option<Vec<String>>,
    favorites: Vec<Favorite>,
    last_profile: Option<String>,
    last_region: Option<String>,
    explorer_local_path: Option<String>,
    diff_tool: Option<String>,
    diff_tool_command: Option<String>,
}

fn defaults(all_services: &[&str]) -> Settings {
    Settings {
        enabled_services: all_services.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}

/// 파일이 없거나 깨져 있으면 기본값(모든 서비스 활성화)을 돌려준다.
pub fn load(path: &Path, all_services: &[&str]) -> Settings {
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<RawSettings>(&text) {
            // enabledServices 키가 없으면 모든 서비스를 켠다. 빈 배열은 사용자가 모두 끈 상태다.
            Ok(raw) => Settings {
                enabled_services: raw
                    .enabled_services
                    .unwrap_or_else(|| all_services.iter().map(|s| s.to_string()).collect()),
                favorites: raw.favorites,
                last_profile: raw.last_profile,
                last_region: raw.last_region,
                explorer_local_path: raw.explorer_local_path,
                diff_tool: raw.diff_tool,
                diff_tool_command: raw.diff_tool_command,
            },
            Err(_) => defaults(all_services),
        },
        Err(_) => defaults(all_services),
    }
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::other(format!("설정 폴더를 만들 수 없어요: {e}")))?;
    }
    let text =
        serde_json::to_string_pretty(settings).map_err(|e| AppError::other(e.to_string()))?;
    fs::write(path, text).map_err(|e| AppError::other(format!("설정을 저장할 수 없어요: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = load(&dir.path().join("settings.json"), &["ec2", "s3"]);
        assert_eq!(s.enabled_services, vec!["ec2", "s3"]);
        assert!(s.favorites.is_empty());
        assert_eq!(s.last_profile, None);
    }

    fn load_text(text: &str) -> Settings {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, text).unwrap();
        load(&path, &["ec2", "s3"])
    }

    #[test]
    fn missing_enabled_services_key_enables_all() {
        assert_eq!(load_text("{}").enabled_services, vec!["ec2", "s3"]);
        let s = load_text(r#"{"lastProfile":"x"}"#);
        assert_eq!(s.enabled_services, vec!["ec2", "s3"]);
        assert_eq!(s.last_profile.as_deref(), Some("x"));
    }

    #[test]
    fn explicit_empty_enabled_services_stays_empty() {
        assert!(load_text(r#"{"enabledServices": []}"#)
            .enabled_services
            .is_empty());
    }

    #[test]
    fn corrupt_file_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path, &["ec2"]).enabled_services, vec!["ec2"]);
    }

    #[test]
    fn save_then_load_roundtrip_creates_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        let s = Settings {
            enabled_services: vec!["iam".into()],
            favorites: vec![Favorite {
                service: "ec2".into(),
                type_id: "instances".into(),
            }],
            last_profile: Some("prod".into()),
            last_region: Some("ap-northeast-2".into()),
            ..Default::default()
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path, &["ec2", "iam"]), s);
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["favorites"][0]["type"], "instances");
        assert_eq!(json["lastProfile"], "prod");
    }

    #[test]
    fn explorer_fields_roundtrip_and_default_to_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"lastProfile":"p"}"#).unwrap();
        let s = load(&path, &["ec2"]);
        assert_eq!(s.explorer_local_path, None);
        assert_eq!(s.diff_tool, None);
        let s = Settings {
            explorer_local_path: Some("/Users/me".into()),
            diff_tool: Some("vscode".into()),
            diff_tool_command: None,
            ..s
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path, &["ec2"]), s);
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["explorerLocalPath"], "/Users/me");
        assert_eq!(json["diffTool"], "vscode");
    }
}
