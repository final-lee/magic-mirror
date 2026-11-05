//! 로그인 재료로 접속 계획을 만든다: 방식별로 필요한 값(AUTH 토큰, 사용자 이름, IAM 서명기)을 갖추고, 모자라면 `LoginRequired`로 돌려보낸다.

use aws_config::SdkConfig;

use super::connect::{Auth, Plan, Secret};
use super::iam::IamSigner;
use super::model::{KvAuthMode, KvLoginSaved};
use super::target::Resolved;
use crate::error::AppError;

fn login_required(message: &str) -> AppError {
    AppError::LoginRequired { message: message.to_string() }
}

/// 데이터베이스 번호(0~255). 클러스터 모드·서버리스는 데이터베이스를 고를 수 없어 0이다
pub fn database_of(login: &KvLoginSaved, resolved: &Resolved) -> Result<u8, AppError> {
    if resolved.info.cluster_mode || resolved.info.serverless {
        return Ok(0);
    }
    u8::try_from(login.database).map_err(|_| AppError::other("데이터베이스 번호는 0부터 255까지예요"))
}

/// 접속 계획. `password`는 입력받은 값이거나 키체인에서 읽은 값이다(없으면 `None`).
/// IAM이면 `cfg`(프로필의 자격 증명)와 `region`으로 토큰을 서명한다.
pub fn plan_for(login: &KvLoginSaved, password: Option<String>, resolved: Resolved, cfg: Option<&SdkConfig>, region: &str) -> Result<Plan, AppError> {
    let database = database_of(login, &resolved)?;
    let auth = match login.mode {
        KvAuthMode::None => Auth::None,
        KvAuthMode::Password => match password.filter(|p| !p.is_empty()) {
            Some(token) => Auth::Password(Secret::new(token)),
            None => return Err(login_required("AUTH 토큰을 입력해 주세요")),
        },
        KvAuthMode::User => {
            let name = login.user.trim();
            if name.is_empty() {
                return Err(login_required("사용자 이름을 입력해 주세요"));
            }
            // 비밀번호가 필요 없는 사용자(no-password-required)는 빈 비밀번호로 붙는다
            Auth::User { name: name.to_string(), password: Secret::new(password.unwrap_or_default()) }
        }
        KvAuthMode::Iam => {
            if !resolved.info.iam_supported {
                return Err(AppError::other("이 캐시는 IAM 인증을 쓸 수 없어요. Valkey 7.2 이상 또는 Redis OSS 7.0 이상이고 전송 중 암호화(TLS)가 켜져 있어야 해요"));
            }
            let cfg = cfg.ok_or_else(|| AppError::other("자격 증명 공급자를 찾을 수 없어요"))?;
            Auth::Iam(std::sync::Arc::new(IamSigner::new(cfg.clone(), region, &resolved.info.identifier, login.user.trim(), resolved.info.serverless)?))
        }
    };
    Ok(Plan { resolved, auth, database })
}

#[cfg(test)]
mod tests;
