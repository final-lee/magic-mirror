use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_credential_types::provider::ProvideCredentials;
use aws_smithy_types::error::display::DisplayErrorContext;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::error::{from_sdk, AppError};

pub const GLOBAL_REGION: &str = "us-east-1";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProfileInfo {
    pub name: String,
    pub region: Option<String>,
}

/// `~/.aws/config` 형식에서 `[default]`, `[profile X]` 섹션만 프로필로 읽는다.
pub fn parse_profiles(text: &str) -> Vec<ProfileInfo> {
    let mut out: Vec<ProfileInfo> = Vec::new();
    let mut in_profile = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            let header = line[1..line.len() - 1].trim();
            let name = if header == "default" {
                Some("default")
            } else {
                header.strip_prefix("profile ").map(str::trim)
            };
            in_profile = name.is_some();
            if let Some(name) = name {
                out.push(ProfileInfo { name: name.to_string(), region: None });
            }
        } else if in_profile {
            if let Some((k, v)) = line.split_once('=') {
                if k.trim() == "region" {
                    if let Some(last) = out.last_mut() {
                        last.region = Some(v.trim().to_string());
                    }
                }
            }
        }
    }
    out
}

fn config_file_path() -> Option<PathBuf> {
    std::env::var_os("AWS_CONFIG_FILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".aws").join("config")))
}

pub fn list_profiles() -> Vec<ProfileInfo> {
    config_file_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|t| parse_profiles(&t))
        .unwrap_or_default()
}

pub fn credentials_error(chain: &str) -> AppError {
    let lower = chain.to_lowercase();
    if lower.contains("sso") || lower.contains("token") {
        AppError::SsoExpired
    } else {
        AppError::other(chain)
    }
}

#[derive(Default)]
pub struct AwsContext {
    cache: Mutex<HashMap<(String, String), SdkConfig>>,
}

impl AwsContext {
    /// (profile, region) 조합의 SdkConfig를 만들고 자격 증명을 한 번 확인한 뒤 캐시한다.
    pub async fn config(&self, profile: &str, region: &str) -> Result<SdkConfig, AppError> {
        let key = (profile.to_string(), region.to_string());
        if let Some(cfg) = self.cache.lock().await.get(&key) {
            return Ok(cfg.clone());
        }
        let cfg = aws_config::defaults(BehaviorVersion::latest())
            .profile_name(profile)
            .region(Region::new(region.to_string()))
            .load()
            .await;
        let provider = cfg
            .credentials_provider()
            .ok_or_else(|| AppError::other("자격 증명 공급자를 찾을 수 없어요"))?;
        provider
            .provide_credentials()
            .await
            .map_err(|e| credentials_error(&format!("{}", DisplayErrorContext(&e))))?;
        self.cache.lock().await.insert(key, cfg.clone());
        Ok(cfg)
    }

    /// SSO 재로그인 후 새 토큰을 읽도록 해당 프로필의 캐시를 비운다.
    pub async fn forget_profile(&self, profile: &str) {
        self.cache.lock().await.retain(|(p, _), _| p != profile);
    }

    pub async fn account_id(&self, profile: &str) -> Result<String, AppError> {
        let cfg = self.config(profile, GLOBAL_REGION).await?;
        let out = aws_sdk_sts::Client::new(&cfg)
            .get_caller_identity()
            .send()
            .await
            .map_err(|e| from_sdk(e, "sts:GetCallerIdentity"))?;
        Ok(out.account().unwrap_or_default().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
[default]
region = us-west-2

[profile prod-sso]
sso_session = my-sso
sso_account_id = 123456789012
region=ap-northeast-2

[sso-session my-sso]
sso_region = us-east-1
region = eu-west-1

[profile localstack]
endpoint_url = http://localhost:4566

[services dev]
region = eu-central-1
"#;

    #[test]
    fn parses_profiles_and_regions() {
        assert_eq!(
            parse_profiles(SAMPLE),
            vec![
                ProfileInfo { name: "default".into(), region: Some("us-west-2".into()) },
                ProfileInfo { name: "prod-sso".into(), region: Some("ap-northeast-2".into()) },
                ProfileInfo { name: "localstack".into(), region: None },
            ]
        );
    }

    #[test]
    fn empty_config_has_no_profiles() {
        assert!(parse_profiles("").is_empty());
    }

    #[test]
    fn credential_errors_mentioning_sso_are_expired() {
        assert_eq!(credentials_error("the SSO session has expired or is invalid"), AppError::SsoExpired);
        assert_eq!(credentials_error("no providers in chain"), AppError::other("no providers in chain"));
    }
}
