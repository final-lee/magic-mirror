use std::time::{Duration, UNIX_EPOCH};

use aws_credential_types::Credentials;

use super::*;

fn fixed_time() -> SystemTime {
    // aws-sdk-rds의 토큰 서명 시험과 같은 시각: 2024-08-26T22:00:00Z
    UNIX_EPOCH + Duration::from_secs(1_724_709_600)
}

fn credentials() -> Credentials {
    Credentials::new("akid", "secret", None, None, "test")
}

#[test]
fn the_signing_path_reproduces_the_aws_sdk_rds_known_answer() {
    // 같은 서명 길(`presign`)이 aws-sdk-rds의 시험 벡터를 그대로 내는지 본다: 서비스 이름과 URL만 다르다
    let token = presign(
        "https://prod-instance.us-east-1.rds.amazonaws.com:3306/?Action=connect&DBUser=peccy",
        "rds-db",
        "us-east-1",
        credentials(),
        fixed_time(),
    )
    .unwrap();
    assert_eq!(
        token,
        "prod-instance.us-east-1.rds.amazonaws.com:3306/?Action=connect&DBUser=peccy&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=akid%2F20240826%2Fus-east-1%2Frds-db%2Faws4_request&X-Amz-Date=20240826T220000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=dd0cba843009474347af724090233265628ace491ea17ce3eb3da098b983ad89"
    );
}

#[test]
fn an_elasticache_token_has_the_documented_shape() {
    let url = token_url("My-Cache", "app-user", false);
    assert_eq!(url, "https://my-cache/?Action=connect&User=app-user");
    let token = presign(&url, SERVICE, "ap-northeast-2", credentials(), fixed_time()).unwrap();
    assert_eq!(
        token,
        EXPECTED_ELASTICACHE,
    );
    assert!(!token.starts_with("https://"));
}

#[test]
fn a_serverless_token_carries_the_resource_type() {
    let url = token_url("Sessions-Cache", "reader", true);
    assert_eq!(url, "https://sessions-cache/?Action=connect&User=reader&ResourceType=ServerlessCache");
    let token = presign(&url, SERVICE, "us-east-1", credentials(), fixed_time()).unwrap();
    assert!(token.starts_with("sessions-cache/?Action=connect&User=reader&ResourceType=ServerlessCache&X-Amz-Algorithm=AWS4-HMAC-SHA256&"), "{token}");
    assert!(token.contains("X-Amz-Credential=akid%2F20240826%2Fus-east-1%2Felasticache%2Faws4_request"));
    assert!(token.contains("X-Amz-Expires=900"));
    assert!(token.contains("X-Amz-SignedHeaders=host"));
}

#[test]
fn a_session_token_is_part_of_the_signed_query() {
    let creds = Credentials::new("akid", "secret", Some("tok/en+1=".to_string()), None, "test");
    let token = presign(&token_url("c", "u", false), SERVICE, "us-east-1", creds, fixed_time()).unwrap();
    assert!(token.contains("X-Amz-Security-Token=tok%2Fen%2B1%3D"), "{token}");
}

#[test]
fn user_names_that_would_change_the_signed_url_are_refused() {
    assert!(check_user_name("app-user_1.v2").is_ok());
    for bad in ["", "a b", "a&b", "a#b", "a%b", "a+b", "a/b", "a\"b", "한글"] {
        assert!(check_user_name(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn the_signer_does_not_print_secrets() {
    let signer = IamSigner::new(aws_config::SdkConfig::builder().build(), "us-east-1", "cache", "user", false).unwrap();
    let shown = format!("{signer:?} {:?}", IamCredentials(Arc::new(signer.clone())));
    assert!(shown.contains("cache") && shown.contains("user"));
    assert!(!shown.to_lowercase().contains("secret"));
}

#[tokio::test]
async fn a_signer_without_a_credentials_provider_says_so() {
    let signer = IamSigner::new(aws_config::SdkConfig::builder().build(), "us-east-1", "cache", "user", false).unwrap();
    let error = signer.token().await.unwrap_err();
    assert_eq!(error, AppError::other("자격 증명 공급자를 찾을 수 없어요"));
}

#[tokio::test]
async fn the_credential_provider_hands_fred_the_user_and_a_fresh_token() {
    use aws_credential_types::provider::SharedCredentialsProvider;
    let cfg = aws_config::SdkConfig::builder().credentials_provider(SharedCredentialsProvider::new(credentials())).build();
    let signer = Arc::new(IamSigner::new(cfg, "us-east-1", "Cache", "reader", false).unwrap());
    let (user, token) = IamCredentials(signer).fetch(None).await.unwrap();
    assert_eq!(user.as_deref(), Some("reader"));
    let token = token.unwrap();
    assert!(token.starts_with("cache/?Action=connect&User=reader&X-Amz-Algorithm=AWS4-HMAC-SHA256&"), "{token}");
}

const EXPECTED_ELASTICACHE: &str = "my-cache/?Action=connect&User=app-user&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=akid%2F20240826%2Fap-northeast-2%2Felasticache%2Faws4_request&X-Amz-Date=20240826T220000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=677e3bae54e978b752e61e9bcf04776b51cbee7ddbb900593943dc5f3ae05f03";
