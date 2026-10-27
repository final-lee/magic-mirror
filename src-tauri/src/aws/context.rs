use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_credential_types::provider::ProvideCredentials;
use aws_smithy_types::error::display::DisplayErrorContext;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::error::{credential_denial, from_sdk, AppError};

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

/// 섹션 헤더 줄 뒤의 주석(`[profile b] # note`)을 뗀다. 헤더가 아닌 줄은 그대로 둔다: 값 안의 `#`은 주석이 아니다.
fn strip_header_comment(line: &str) -> &str {
    if !line.starts_with('[') {
        return line;
    }
    match line.find(']') {
        Some(close) if line[close + 1..].trim_start().starts_with(['#', ';']) => &line[..=close],
        _ => line,
    }
}

/// `~/.aws/config` 형식에서 `[default]`, `[profile X]` 섹션만 프로필로 읽는다.
pub fn parse_profiles(text: &str) -> Vec<ProfileInfo> {
    let mut order: Vec<String> = Vec::new();
    let mut sections: HashMap<String, Section> = HashMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let line = strip_header_comment(line.trim());
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
    if let Some(denied) = credential_denial(&lower) {
        return denied;
    }
    // 자격 증명을 만들 수 없는 프로필은 만료가 아니다. 다시 로그인해도 풀리지 않는데, 만료로 보면 자동 로그인이 브라우저를 연다.
    // SDK는 공급자를 모두 시도하고도 못 찾으면 "no credentials found in chain"(토큰 전용 `sso_session` 프로필, 자격 증명이 없는 프로필)을,
    // 프로필 설정이 잘못됐으면 "not properly configured"를 낸다. 두 chain 모두 "sso"나 "token"이 들어 있어서(공급자 목록의 WebIdentityToken,
    // `sso_account_id`) 아래 검사에 걸리므로 먼저 거른다. 진짜 만료 chain에는 이 문구가 없다.
    if lower.contains("no credentials found in chain") || lower.contains("not properly configured") {
        return AppError::other(chain);
    }
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

/// 다른 모듈의 테스트가 캐시를 심고 들여다보는 길(진짜 자격 증명 없이).
#[cfg(test)]
impl AwsContext {
    /// 이 프로필의 캐시 항목을 하나 심는다.
    pub(crate) async fn cache_profile_for_test(&self, profile: &str) {
        self.cache.lock().await.insert((profile.to_string(), GLOBAL_REGION.to_string()), SdkConfig::builder().build());
    }

    /// 캐시에 남은 프로필 이름(정렬, 중복 없음).
    pub(crate) async fn cached_profiles_for_test(&self) -> Vec<String> {
        let mut names: Vec<String> = self.cache.lock().await.keys().map(|(p, _)| p.clone()).collect();
        names.sort();
        names.dedup();
        names
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
    fn comments_after_a_section_header_do_not_hide_the_section() {
        let text = "\
[profile a]
sso_session = s1
[profile b] # second org
sso_session = s2
[profile c]; note
region = eu-west-1
[default]
region = us-east-2
[sso-session s1] # shared
region = eu-west-3
";
        assert_eq!(
            parse_profiles(text),
            vec![
                info("a", None, Some(("a", "session:s1"))),
                info("b", None, Some(("b", "session:s2"))),
                info("c", Some("eu-west-1"), None),
                info("default", Some("us-east-2"), None),
            ]
        );
    }

    #[test]
    fn a_hash_inside_a_value_is_kept() {
        let text = "[profile old]\nsso_start_url = https://corp.awsapps.com/start/#/\n";
        assert_eq!(parse_profiles(text), vec![info("old", None, Some(("old", "url:https://corp.awsapps.com/start/#/")))]);
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

    // 아래 chain들은 실제 aws-config 1.13이 `provide_credentials()`에서 낸 문자열이다(Debug 꼬리는 줄였고 홈 폴더는 /Users/jane로 바꿨다).
    // 손으로 꾸민 문자열은 실제 문구와 달라서 이 분류를 지키지 못했다. 임시 설정 파일과 임시 HOME에서 SDK를 실제로 돌려 얻었다.

    /// 진짜 만료: 토큰 캐시 파일이 없다(`sso_session` 프로필. 그 위의 `source_profile` 역할 프로필도 같은 문구다)
    const TOKEN_FILE_MISSING_SESSION: &str = "an error occurred while loading credentials: an error occurred while loading credentials: \
        an error occurred while loading an access token: failed to load the cached SSO token (ProviderError(ProviderError { source: \
        ProviderError(ProviderError { source: ProviderError(ProviderError { source: FailedToLoadToken { source: IoError { what: \"read\", \
        path: \"/Users/jane/.aws/sso/cache/ee0bfd2552fbd840c02cc48b6e823320543c450f.json\", source: Os { code: 2, kind: NotFound, \
        message: \"No such file or directory\" } } } }) }) }))";
    /// 진짜 만료: 토큰 파일은 있지만 만료됐고 갱신할 수 없다(`sso_session` 프로필)
    const TOKEN_EXPIRED_SESSION: &str = "an error occurred while loading credentials: an error occurred while loading credentials: \
        an error occurred while loading an access token: the SSO token has expired and cannot be refreshed (ProviderError(ProviderError { \
        source: ProviderError(ProviderError { source: ProviderError(ProviderError { source: ExpiredToken }) }) }))";
    /// 진짜 만료: 토큰 캐시 파일이 없다(레거시 `sso_start_url` 프로필)
    const TOKEN_FILE_MISSING_LEGACY: &str = "an error occurred while loading credentials: an error occurred while loading credentials: \
        failed to read `/Users/jane/.aws/sso/cache/79e435d7a515078e81c9dffc35f38d5687ebd3a7.json`: No such file or directory (os error 2) \
        (ProviderError(ProviderError { source: ProviderError(ProviderError { source: IoError { what: \"read\", \
        path: \"/Users/jane/.aws/sso/cache/79e435d7a515078e81c9dffc35f38d5687ebd3a7.json\", source: Os { code: 2, kind: NotFound, \
        message: \"No such file or directory\" } } }) }))";
    /// 진짜 만료: 레거시 프로필의 토큰을 포털이 거절한다(이 chain의 "sso"는 `server` 헤더에만 있다)
    const PORTAL_REJECTS_TOKEN: &str = "an error occurred while loading credentials: an error occurred while loading credentials: service error: \
        UnauthorizedException: Session token not found or invalid: UnauthorizedException: Session token not found or invalid \
        (ProviderError(ProviderError { source: ProviderError(ProviderError { source: ServiceError(ServiceError { source: \
        UnauthorizedException(UnauthorizedException { message: Some(\"Session token not found or invalid\"), meta: ErrorMetadata { \
        code: Some(\"UnauthorizedException\"), message: Some(\"Session token not found or invalid\"), extras: Some({\"aws_request_id\": \"x\"}) } }), \
        raw: Response { status: StatusCode(401), headers: {\"server\": \"AWS SSO\"} } }) }) }))";

    /// 자격 증명을 만들 수 없는 프로필: 토큰 전용 `sso_session` 프로필(`sso_account_id`와 `sso_role_name`이 없다. CodeCatalyst 설정이 이렇다).
    /// 공급자를 모두 시도하고도 못 찾으면 목록에 늘 `WebIdentityToken`이 들어서 "token"이 보인다
    const NO_CREDENTIALS_TOKEN_ONLY: &str = concat!(
        "the credential provider was not enabled: no credentials found in chain. Attempted:",
        "\n  Environment: the credential provider was not enabled: environment variable not set",
        "\n  Profile: the credential provider was not enabled: selected profile will resolve an access token instead of credentials since it \
         doesn't have `sso_account_id` and `sso_role_name` set. Specify both `sso_account_id` and `sso_role_name` to let this profile resolve credentials.",
        "\n  WebIdentityToken: the credential provider was not enabled: $AWS_WEB_IDENTITY_TOKEN_FILE was not set",
        "\n  EcsContainer: the credential provider was not enabled: ECS provider not configured",
        "\n  Ec2InstanceMetadata: the credential provider was not enabled: could not communicate with IMDS: dispatch failure: io error: \
         client error (Connect): tcp connect error: No route to host (os error 65)",
        " (CredentialsNotLoaded(CredentialsNotLoaded { source: Some(ProviderChainError { attempts: [ProviderAttempt { name: \"Environment\", \
         error: CredentialsNotLoaded(CredentialsNotLoaded { source: Some(\"environment variable not set\") }) }] }) }))",
    );
    /// 자격 증명이 아예 없는 비SSO 프로필(`[profile empty]`에 리전만 있다)
    const NO_CREDENTIALS_AT_ALL: &str = concat!(
        "the credential provider was not enabled: no credentials found in chain. Attempted:",
        "\n  Environment: the credential provider was not enabled: environment variable not set",
        "\n  Profile: the credential provider was not enabled",
        "\n  WebIdentityToken: the credential provider was not enabled: $AWS_WEB_IDENTITY_TOKEN_FILE was not set",
        "\n  EcsContainer: the credential provider was not enabled: ECS provider not configured",
        "\n  Ec2InstanceMetadata: the credential provider was not enabled: could not communicate with IMDS: dispatch failure: io error: \
         client error (Connect): tcp connect error: No route to host (os error 65)",
        " (CredentialsNotLoaded(CredentialsNotLoaded { source: Some(ProviderChainError { attempts: [ProviderAttempt { name: \"Environment\", \
         error: CredentialsNotLoaded(CredentialsNotLoaded { source: Some(\"environment variable not set\") }) }] }) }))",
    );
    /// 설정이 잘못된 프로필: `sso_account_id`만 있고 `sso_role_name`이 없다
    const NOT_CONFIGURED_HALF_SSO: &str = "the credentials provider was not properly configured: ProfileFile provider could not be built: \
        profile `half` has invalid SSO config: if `sso_account_id` is set, then `sso_role_name` must also be set (InvalidConfiguration(\
        InvalidConfiguration { source: \"ProfileFile provider could not be built: profile `half` has invalid SSO config: if `sso_account_id` is set, \
        then `sso_role_name` must also be set\" }))";
    /// 설정이 잘못된 프로필: 없는 `[sso-session]`을 가리킨다(`aws sso login`도 실패한다)
    const NOT_CONFIGURED_SESSION_MISSING: &str = "the credentials provider was not properly configured: ProfileFile provider could not be built: \
        sso-session named `nope` (referenced by profile `dangling`) was not found (InvalidConfiguration(InvalidConfiguration { source: \
        \"ProfileFile provider could not be built: sso-session named `nope` (referenced by profile `dangling`) was not found\" }))";
    /// SSO도 토큰도 아닌 실제 실패: `credential_process`가 0이 아닌 코드로 끝났다
    const CREDENTIAL_PROCESS_FAILED: &str = "an error occurred while loading credentials: an error occurred while loading credentials: \
        Error retrieving credentials: external process exited with code exit status: 1. Stderr:  (ProviderError(ProviderError { source: \
        ProviderError(ProviderError { source: \"Error retrieving credentials: external process exited with code exit status: 1. Stderr: \" }) }))";

    #[test]
    fn credential_errors_mentioning_sso_are_expired() {
        assert_eq!(credentials_error("the SSO session has expired or is invalid"), AppError::SsoExpired);
    }

    #[test]
    fn a_credential_error_that_is_neither_sso_nor_a_token_keeps_its_message() {
        assert_eq!(credentials_error(CREDENTIAL_PROCESS_FAILED), AppError::other(CREDENTIAL_PROCESS_FAILED));
    }

    #[test]
    fn a_real_expired_session_is_still_expired() {
        for (case, chain) in [
            ("sso_session, 토큰 파일 없음", TOKEN_FILE_MISSING_SESSION),
            ("sso_session, 토큰 만료", TOKEN_EXPIRED_SESSION),
            ("레거시, 토큰 파일 없음", TOKEN_FILE_MISSING_LEGACY),
            ("레거시, 포털이 토큰을 거절", PORTAL_REJECTS_TOKEN),
        ] {
            assert_eq!(credentials_error(chain), AppError::SsoExpired, "{case}");
        }
    }

    #[test]
    fn a_token_only_sso_profile_is_not_an_expired_session() {
        // 다시 로그인해도 풀리지 않는다: 이 프로필은 액세스 토큰만 받고 자격 증명을 만들지 않는다
        assert_eq!(credentials_error(NO_CREDENTIALS_TOKEN_ONLY), AppError::other(NO_CREDENTIALS_TOKEN_ONLY));
    }

    #[test]
    fn a_misconfigured_profile_is_not_an_expired_session() {
        for (case, chain) in [("sso_role_name 없음", NOT_CONFIGURED_HALF_SSO), ("없는 sso-session", NOT_CONFIGURED_SESSION_MISSING)] {
            assert_eq!(credentials_error(chain), AppError::other(chain), "{case}");
        }
    }

    #[test]
    fn a_profile_without_any_credentials_is_not_an_expired_session_either() {
        // SSO가 아닌 프로필에도 "SSO 세션이 만료됐어요"가 뜨던 오분류
        assert_eq!(credentials_error(NO_CREDENTIALS_AT_ALL), AppError::other(NO_CREDENTIALS_AT_ALL));
    }

    #[test]
    fn a_denied_role_behind_an_sso_profile_is_not_expired() {
        // 역할 ARN에 AWSReservedSSO_가 들어 있어도 만료가 아니다: 다시 로그인해도 풀리지 않으니 자동 로그인을 열면 안 된다
        let chain = "failed to load credentials: AccessDenied: User: arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_Admin_0123abcd/jane \
            is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::222222222222:role/Deploy";
        assert_eq!(credentials_error(chain), AppError::AccessDenied { action: "sts:AssumeRole".into() });
    }

    #[test]
    fn a_forbidden_sso_role_assignment_is_not_expired_either() {
        // 실제 포털 응답에는 "server": "AWS SSO" 헤더가 있어서, 거부를 먼저 보지 않으면 만료로 읽힌다
        assert_eq!(credentials_error(crate::error::tests::PORTAL_FORBIDDEN), AppError::AccessDenied { action: "sso:GetRoleCredentials".into() });
    }
}
