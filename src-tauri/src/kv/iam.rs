//! IAM 인증 토큰: `https://<캐시 이름 소문자>/?Action=connect&User=<user>[&ResourceType=ServerlessCache]`를 서비스 `elasticache`, 리전, 900초로
//! 사전 서명(SigV4, 쿼리 문자열)하고 `https://`를 뗀 글이다. `AUTH <user> <토큰>`의 비밀번호 자리에만 쓰고
//! 로그·오류·반환값 어디에도 넣지 않는다(`Debug`도 가린다). RDS의 `AuthTokenGenerator`와 같은 서명 길이고 서비스 이름과 URL만 다르다.
//!
//! 토큰은 연결할 때마다 새로 만든다. fred의 `CredentialProvider`로 꽂아 두면 재연결, 클러스터의 새 노드 연결마다 새 토큰이 나간다.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_credential_types::provider::ProvideCredentials;
use aws_credential_types::Credentials;
use aws_sigv4::http_request::{self, SignableBody, SignableRequest, SignatureLocation, SigningSettings};
use aws_sigv4::sign::v4;
use aws_smithy_runtime_api::client::identity::Identity;
use aws_smithy_types::error::display::DisplayErrorContext;
use fred::error::{Error as FredError, ErrorKind};
use fred::types::config::{CredentialProvider, Server};

use crate::aws::context::credentials_error;
use crate::error::AppError;

/// 서명에 쓰는 서비스 이름
const SERVICE: &str = "elasticache";
/// 토큰 유효 시간(ElastiCache가 받는 최대)
const EXPIRES: Duration = Duration::from_secs(900);

/// 사용자 이름이 URL 쿼리에 그대로 들어가도 되는지 본다. 사용자 이름은 입력창의 자유 텍스트다. ElastiCache의 사용자 이름은
/// 영문자·숫자·`-`·`_`·`.` 안에서 쓰므로 그 밖의 글자는 서명하지 않고 돌려보낸다(다른 이름으로 서명되어 로그인이 엉뚱한 이유로 실패하는 것을 막는다).
pub fn check_user_name(user: &str) -> Result<(), AppError> {
    if user.is_empty() {
        return Err(AppError::other("IAM 사용자 이름을 입력해 주세요"));
    }
    if !user.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err(AppError::other("IAM 사용자 이름에는 영문자, 숫자, - _ . 만 쓸 수 있어요"));
    }
    Ok(())
}

/// 서명할 URL: 호스트는 캐시 이름(소문자)이다. 서버리스는 `ResourceType=ServerlessCache`를 붙인다
pub fn token_url(cache_name: &str, user: &str, serverless: bool) -> String {
    let resource = if serverless { "&ResourceType=ServerlessCache" } else { "" };
    format!("https://{}/?Action=connect&User={user}{resource}", cache_name.to_lowercase())
}

/// `url`을 쿼리 문자열로 사전 서명해 `https://`를 뗀 글을 돌려준다. 순수 함수라 고정된 자격 증명과 시각으로 시험한다.
pub fn presign(url: &str, service: &str, region: &str, credentials: Credentials, now: SystemTime) -> Result<String, AppError> {
    let failed = |e: &dyn std::error::Error| AppError::other(format!("IAM 인증 토큰을 만들지 못했어요: {e}"));
    let identity: Identity = credentials.into();
    let mut settings = SigningSettings::default();
    settings.expires_in = Some(EXPIRES);
    settings.signature_location = SignatureLocation::QueryParams;
    let params = v4::SigningParams::builder().identity(&identity).region(region).name(service).time(now).settings(settings).build().map_err(|e| failed(&e))?;
    let request = SignableRequest::new("GET", url, std::iter::empty(), SignableBody::empty()).map_err(|e| failed(&e))?;
    let (instructions, _signature) = http_request::sign(request, &params.into()).map_err(|e| failed(&e))?.into_parts();
    let mut signed = url::Url::parse(url).map_err(|e| failed(&e))?;
    for (name, value) in instructions.params() {
        signed.query_pairs_mut().append_pair(name, value);
    }
    Ok(signed.as_str().strip_prefix("https://").unwrap_or(signed.as_str()).to_string())
}

/// 토큰을 만드는 쪽: 어느 캐시에 어느 사용자로 붙는지와 자격 증명을 받아 올 SdkConfig
#[derive(Clone)]
pub struct IamSigner {
    cfg: SdkConfig,
    region: String,
    cache_name: String,
    user: String,
    serverless: bool,
}

impl fmt::Debug for IamSigner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IamSigner").field("cache_name", &self.cache_name).field("user", &self.user).finish_non_exhaustive()
    }
}

impl IamSigner {
    pub fn new(cfg: SdkConfig, region: &str, cache_name: &str, user: &str, serverless: bool) -> Result<IamSigner, AppError> {
        check_user_name(user)?;
        Ok(IamSigner { cfg, region: region.to_string(), cache_name: cache_name.to_string(), user: user.to_string(), serverless })
    }

    pub fn user(&self) -> &str {
        &self.user
    }

    /// 새 토큰(15분 유효). 서명은 로컬에서 하고 네트워크는 자격 증명을 새로 받아야 할 때만 쓴다.
    /// 자격 증명을 얻지 못하면 AWS 호출과 같은 분류를 거친다: 만료된 SSO 세션은 `SsoExpired`가 되어 자동 로그인이 이어받는다.
    pub async fn token(&self) -> Result<String, AppError> {
        let provider = self.cfg.credentials_provider().ok_or_else(|| AppError::other("자격 증명 공급자를 찾을 수 없어요"))?;
        let credentials = provider.provide_credentials().await.map_err(|e| credentials_error(&format!("{}", DisplayErrorContext(&e))))?;
        presign(&token_url(&self.cache_name, &self.user, self.serverless), SERVICE, &self.region, credentials, SystemTime::now())
    }
}

/// fred가 연결(재연결 포함)을 맺을 때마다 새 토큰을 받아 가는 공급자
#[derive(Debug, Clone)]
pub struct IamCredentials(pub Arc<IamSigner>);

#[async_trait]
impl CredentialProvider for IamCredentials {
    async fn fetch(&self, _server: Option<&Server>) -> Result<(Option<String>, Option<String>), FredError> {
        // 오류 문구에는 원인만 넣는다: 토큰도 서명 재료도 들어 있지 않다
        match self.0.token().await {
            Ok(token) => Ok((Some(self.0.user().to_string()), Some(token))),
            Err(e) => Err(FredError::new(ErrorKind::Auth, e.to_string())),
        }
    }
}

#[cfg(test)]
mod tests;
