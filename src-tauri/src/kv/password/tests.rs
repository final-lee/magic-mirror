use std::collections::HashMap;
use std::sync::Mutex;

use super::*;

#[derive(Default)]
struct Memory(Mutex<HashMap<String, String>>);

impl Store for Memory {
    fn get(&self, account: &str) -> Result<Option<String>, AppError> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), AppError> {
        self.0.lock().unwrap().insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

const ARN: &str = "arn:aws:elasticache:ap-northeast-2:123456789012:replicationgroup:sessions";

#[test]
fn the_account_is_the_arn_and_the_user() {
    assert_eq!(account(ARN, "app"), format!("{ARN}|app"));
    // AUTH 토큰은 사용자가 없어서 빈 글이다
    assert_eq!(account(ARN, ""), format!("{ARN}|"));
}

#[tokio::test]
async fn secrets_are_stored_per_arn_and_user_and_can_be_forgotten() {
    let passwords = Passwords::with_store(Arc::new(Memory::default()));
    assert_eq!(passwords.get(ARN, "app").await.unwrap(), None);
    passwords.set(ARN, "app", "s3cret").await.unwrap();
    passwords.set(ARN, "", "token").await.unwrap();
    assert_eq!(passwords.get(ARN, "app").await.unwrap().as_deref(), Some("s3cret"));
    assert_eq!(passwords.get(ARN, "").await.unwrap().as_deref(), Some("token"));
    assert_eq!(passwords.get(ARN, "other").await.unwrap(), None);
    passwords.delete(ARN, "app").await.unwrap();
    assert_eq!(passwords.get(ARN, "app").await.unwrap(), None);
    // 없는 것을 지워도 오류가 아니다
    passwords.delete(ARN, "app").await.unwrap();
    assert_eq!(passwords.get(ARN, "").await.unwrap().as_deref(), Some("token"));
}

#[test]
fn the_keychain_service_name_is_the_documented_one() {
    assert_eq!(SERVICE, "magic-mirror.elasticache");
}
