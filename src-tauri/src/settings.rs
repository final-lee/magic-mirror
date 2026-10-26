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
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| defaults(all_services)),
        Err(_) => defaults(all_services),
    }
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::other(format!("설정 폴더를 만들 수 없어요: {e}")))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| AppError::other(e.to_string()))?;
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
            favorites: vec![Favorite { service: "ec2".into(), type_id: "instances".into() }],
            last_profile: Some("prod".into()),
            last_region: Some("ap-northeast-2".into()),
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path, &["ec2", "iam"]), s);
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["favorites"][0]["type"], "instances");
        assert_eq!(json["lastProfile"], "prod");
    }
}
