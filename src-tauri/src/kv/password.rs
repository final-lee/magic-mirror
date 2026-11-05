//! 비밀번호·AUTH 토큰의 영구 저장소: macOS 키체인(서비스 `magic-mirror.elasticache`, 계정 `<대상 ARN>|<사용자 또는 빈 글>`).
//! 설정 파일에는 비밀을 두지 않는다. 키체인 호출은 블로킹이라 `spawn_blocking`에서만 한다(ArgoCD 토큰과 같은 길).

use std::sync::Arc;

use crate::error::AppError;

const SERVICE: &str = "magic-mirror.elasticache";
const KEYCHAIN_ERROR: &str = "키체인에 접근하지 못했어요";

/// 계정 이름: 대상 ARN과 사용자. 사용자가 없는 방식(AUTH 토큰)은 빈 글이다
pub fn account(arn: &str, user: &str) -> String {
    format!("{arn}|{user}")
}

/// 저장소. 호출은 블로킹 작업에서만 한다.
pub trait Store: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, AppError>;
    fn set(&self, account: &str, secret: &str) -> Result<(), AppError>;
    fn delete(&self, account: &str) -> Result<(), AppError>;
}

pub struct Keychain;

impl Store for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, AppError> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|_| AppError::other(KEYCHAIN_ERROR))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AppError::other(KEYCHAIN_ERROR)),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), AppError> {
        keyring::Entry::new(SERVICE, account).and_then(|entry| entry.set_password(secret)).map_err(|_| AppError::other(KEYCHAIN_ERROR))
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|_| AppError::other(KEYCHAIN_ERROR))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AppError::other(KEYCHAIN_ERROR)),
        }
    }
}

/// 비동기로 쓰는 저장소 손잡이
#[derive(Clone)]
pub struct Passwords {
    store: Arc<dyn Store>,
}

impl Default for Passwords {
    fn default() -> Self {
        Passwords { store: Arc::new(Keychain) }
    }
}

impl Passwords {
    #[cfg(test)]
    pub fn with_store(store: Arc<dyn Store>) -> Passwords {
        Passwords { store }
    }

    pub async fn get(&self, arn: &str, user: &str) -> Result<Option<String>, AppError> {
        let (store, account) = (self.store.clone(), account(arn, user));
        tokio::task::spawn_blocking(move || store.get(&account)).await.map_err(|_| AppError::other(KEYCHAIN_ERROR))?
    }

    pub async fn set(&self, arn: &str, user: &str, secret: &str) -> Result<(), AppError> {
        let (store, account, secret) = (self.store.clone(), account(arn, user), secret.to_string());
        tokio::task::spawn_blocking(move || store.set(&account, &secret)).await.map_err(|_| AppError::other(KEYCHAIN_ERROR))?
    }

    pub async fn delete(&self, arn: &str, user: &str) -> Result<(), AppError> {
        let (store, account) = (self.store.clone(), account(arn, user));
        tokio::task::spawn_blocking(move || store.delete(&account)).await.map_err(|_| AppError::other(KEYCHAIN_ERROR))?
    }
}

#[cfg(test)]
mod tests;
