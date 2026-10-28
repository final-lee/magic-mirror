use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
    /// PostgreSQL 탭의 로그인 사용자: 대상(클러스터·인스턴스) ARN → DB 사용자 이름
    pub pg_logins: BTreeMap<String, String>,
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
    pg_logins: BTreeMap<String, String>,
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
                pg_logins: raw.pg_logins,
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

    const ARN: &str = "arn:aws:rds:ap-northeast-2:123456789012:cluster:orders-aurora";

    #[test]
    fn pg_logins_roundtrip_and_an_old_file_without_them_still_loads() {
        // PostgreSQL 탭이 생기기 전에 저장한 파일에는 `pgLogins`가 없다
        let old = load_text(r#"{"enabledServices":["ec2"],"lastProfile":"p"}"#);
        assert!(old.pg_logins.is_empty());
        assert_eq!(old.last_profile.as_deref(), Some("p"));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let s = Settings { pg_logins: BTreeMap::from([(ARN.to_string(), "iam_admin".to_string())]), ..old };
        save(&path, &s).unwrap();
        assert_eq!(load(&path, &["ec2", "s3"]), s);
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["pgLogins"][ARN], "iam_admin");
    }

    #[test]
    fn a_file_with_pg_logins_keeps_them_through_a_load_and_a_save() {
        // 프런트엔드가 `save_settings`로 보낸 모양 그대로다: 대상 ARN → DB 사용자
        let text = format!(r#"{{"enabledServices":["ec2"],"pgLogins":{{"{ARN}":"iam_admin","arn:aws:rds:us-east-1:123456789012:db:legacy":"reader"}}}}"#);
        let loaded = load_text(&text);
        assert_eq!(loaded.pg_logins.len(), 2);
        assert_eq!(loaded.pg_logins.get(ARN).map(String::as_str), Some("iam_admin"));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        save(&path, &loaded).unwrap();
        let again = load(&path, &["ec2", "s3"]);
        assert_eq!(again.pg_logins, loaded.pg_logins);
        // 설정 화면의 다른 값을 바꿔 저장해도 로그인 사용자는 남는다
        let changed = Settings { last_profile: Some("prod".into()), ..again };
        save(&path, &changed).unwrap();
        assert_eq!(load(&path, &["ec2", "s3"]).pg_logins, loaded.pg_logins);
    }

    #[test]
    fn pg_logins_of_the_wrong_shape_make_the_file_corrupt_like_any_other_wrong_field() {
        assert!(load_text(r#"{"pgLogins":["iam_admin"]}"#).pg_logins.is_empty());
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
