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
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub name: String,
    pub region: Option<String>,
    /// `aws sso login`에 넘길 프로필: 자기 자신이거나 `source_profile` 체인에서 처음 나오는 SSO 프로필. SSO가 아니면 None
    pub sso_login: Option<String>,
    /// 같은 SSO 세션을 쓰는 프로필끼리 같은 값: `session:<이름>` 또는 `url:<start url>`
    pub sso_key: Option<String>,
}

/// `source_profile`을 따라가는 최대 단계
const MAX_SOURCE_STEPS: usize = 5;

#[derive(Default)]
struct Section {
    region: Option<String>,
    sso_session: Option<String>,
    sso_start_url: Option<String>,
    source_profile: Option<String>,
}

/// `~/.aws/config` 형식에서 `[default]`, `[profile X]` 섹션만 프로필로 읽는다.
pub fn parse_profiles(text: &str) -> Vec<ProfileInfo> {
    let mut order: Vec<String> = Vec::new();
    let mut sections: HashMap<String, Section> = HashMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            let header = line[1..line.len() - 1].trim();
            let name = if header == "default" { Some("default") } else { header.strip_prefix("profile ").map(str::trim) };
            current = name.map(str::to_string);
            if let Some(name) = &current {
                if !sections.contains_key(name) {
                    order.push(name.clone());
                    sections.insert(name.clone(), Section::default());
                }
            }
        } else if let (Some(name), Some((k, v))) = (&current, line.split_once('=')) {
            let Some(section) = sections.get_mut(name) else { continue };
            let v = v.trim().to_string();
            match k.trim() {
                "region" => section.region = Some(v),
                "sso_session" => section.sso_session = Some(v),
                "sso_start_url" => section.sso_start_url = Some(v),
                "source_profile" => section.source_profile = Some(v),
                _ => {}
            }
        }
    }
    order
        .iter()
        .map(|name| {
            let (sso_login, sso_key) = sso_target(&sections, name).unzip();
            ProfileInfo { name: name.clone(), region: sections[name].region.clone(), sso_login, sso_key }
        })
        .collect()
}

/// 이 프로필이 기대는 SSO 프로필과 그 세션 키. 자신이 SSO가 아니면 `source_profile`을 따라간다(최대 5단계, 순환이면 None).
fn sso_target(sections: &HashMap<String, Section>, name: &str) -> Option<(String, String)> {
    let mut current = name;
    let mut seen: Vec<&str> = Vec::new();
    for _ in 0..=MAX_SOURCE_STEPS {
        if seen.contains(&current) {
            return None;
        }
        seen.push(current);
        let section = sections.get(current)?;
        if let Some(session) = &section.sso_session {
            return Some((current.to_string(), format!("session:{session}")));
        }
        if let Some(url) = &section.sso_start_url {
            return Some((current.to_string(), format!("url:{url}")));
        }
        current = section.source_profile.as_deref()?;
    }
    None
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

    /// SSO 재로그인 뒤 새 토큰을 읽도록 그 프로필들의 캐시를 비운다(같은 SSO 세션을 쓰는 프로필 모두).
    pub async fn forget_profiles(&self, names: &[String]) {
        self.cache.lock().await.retain(|(p, _), _| !names.iter().any(|n| n == p));
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

    fn info(name: &str, region: Option<&str>, sso: Option<(&str, &str)>) -> ProfileInfo {
        ProfileInfo {
            name: name.into(),
            region: region.map(Into::into),
            sso_login: sso.map(|(login, _)| login.to_string()),
            sso_key: sso.map(|(_, key)| key.to_string()),
        }
    }

    #[test]
    fn parses_profiles_and_regions() {
        assert_eq!(
            parse_profiles(SAMPLE),
            vec![
                info("default", Some("us-west-2"), None),
                info("prod-sso", Some("ap-northeast-2"), Some(("prod-sso", "session:my-sso"))),
                info("localstack", None, None),
            ]
        );
    }

    #[test]
    fn legacy_start_url_profiles_are_sso() {
        let text = "[profile old]\nsso_start_url = https://corp.awsapps.com/start\nsso_region = us-east-1\n";
        assert_eq!(parse_profiles(text), vec![info("old", None, Some(("old", "url:https://corp.awsapps.com/start")))]);
    }

    #[test]
    fn role_profiles_log_in_through_their_sso_source() {
        let text = "\
[profile base]
sso_session = corp
[profile admin]
role_arn = arn:aws:iam::111111111111:role/Admin
source_profile = base
[profile deeper]
role_arn = arn:aws:iam::222222222222:role/Ops
source_profile = admin
";
        let parsed = parse_profiles(text);
        assert_eq!(parsed[1], info("admin", None, Some(("base", "session:corp"))));
        assert_eq!(parsed[2], info("deeper", None, Some(("base", "session:corp"))));
    }

    #[test]
    fn source_profile_cycles_and_plain_keys_are_not_sso() {
        let text = "\
[profile a]
source_profile = b
[profile b]
source_profile = a
[profile keys]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
";
        assert!(parse_profiles(text).iter().all(|p| p.sso_login.is_none() && p.sso_key.is_none()));
    }

    #[test]
    fn source_chains_longer_than_five_steps_are_not_followed() {
        let mut text = String::from("[profile p0]\nsso_session = corp\n");
        for i in 1..=6 {
            text.push_str(&format!("[profile p{i}]\nsource_profile = p{}\n", i - 1));
        }
        let parsed = parse_profiles(&text);
        assert_eq!(parsed[5].sso_key.as_deref(), Some("session:corp")); // p5 → p0: 5 steps
        assert_eq!(parsed[6].sso_key, None); // p6 → p0: 6 steps
    }

    #[test]
    fn profile_info_serializes_camel_case() {
        let v = serde_json::to_value(info("p", None, Some(("p", "session:s")))).unwrap();
        assert_eq!(v, serde_json::json!({ "name": "p", "region": null, "ssoLogin": "p", "ssoKey": "session:s" }));
    }

    #[tokio::test]
    async fn forget_profiles_drops_only_the_named_profiles() {
        let ctx = AwsContext::default();
        {
            let mut cache = ctx.cache.lock().await;
            for p in ["a", "b", "c"] {
                cache.insert((p.to_string(), "us-east-1".to_string()), SdkConfig::builder().build());
            }
        }
        ctx.forget_profiles(&["a".to_string(), "c".to_string()]).await;
        let left: Vec<String> = ctx.cache.lock().await.keys().map(|(p, _)| p.clone()).collect();
        assert_eq!(left, vec!["b".to_string()]);
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
