use super::*;
use crate::kv::model::{KvKind, KvTargetInfo};

fn resolved(cluster_mode: bool, serverless: bool, iam: bool) -> Resolved {
    Resolved {
        info: KvTargetInfo {
            arn: "arn:aws:elasticache:ap-northeast-2:111111111111:replicationgroup:sessions".into(),
            identifier: "Sessions".into(),
            kind: if serverless { KvKind::ServerlessCache } else { KvKind::ReplicationGroup },
            engine: "valkey".into(),
            engine_version: "8.0".into(),
            endpoint: "master.sessions.cache.amazonaws.com".into(),
            port: 6379,
            reader_endpoint: None,
            tls: true,
            cluster_mode,
            serverless,
            auth_token_enabled: false,
            user_group_ids: vec![],
            users: None,
            iam_supported: iam,
        },
        members: vec![],
    }
}

fn login(mode: KvAuthMode, user: &str, database: u32) -> KvLoginSaved {
    KvLoginSaved { mode, user: user.into(), database }
}

#[test]
fn no_login_needs_nothing() {
    let plan = plan_for(&login(KvAuthMode::None, "", 0), None, resolved(false, false, true), None, "ap-northeast-2").unwrap();
    assert!(matches!(plan.auth, Auth::None));
    assert_eq!(plan.database, 0);
}

#[test]
fn an_auth_token_is_required_for_the_password_mode() {
    let missing = plan_for(&login(KvAuthMode::Password, "", 0), None, resolved(false, false, true), None, "r").unwrap_err();
    assert_eq!(missing, AppError::LoginRequired { message: "AUTH 토큰을 입력해 주세요".into() });
    let empty = plan_for(&login(KvAuthMode::Password, "", 0), Some(String::new()), resolved(false, false, true), None, "r").unwrap_err();
    assert!(matches!(empty, AppError::LoginRequired { .. }));
    let plan = plan_for(&login(KvAuthMode::Password, "", 0), Some("tok".into()), resolved(false, false, true), None, "r").unwrap();
    assert!(matches!(plan.auth, Auth::Password(_)));
    // 토큰은 Debug에 찍히지 않는다
    assert!(!format!("{plan:?}").contains("tok\""));
}

#[test]
fn a_user_needs_a_name_but_not_necessarily_a_password() {
    let nameless = plan_for(&login(KvAuthMode::User, "  ", 0), Some("x".into()), resolved(false, false, true), None, "r").unwrap_err();
    assert_eq!(nameless, AppError::LoginRequired { message: "사용자 이름을 입력해 주세요".into() });
    // 비밀번호가 필요 없는 사용자
    let nopass = plan_for(&login(KvAuthMode::User, "reader", 0), None, resolved(false, false, true), None, "r").unwrap();
    match nopass.auth {
        Auth::User { name, password } => {
            assert_eq!(name, "reader");
            assert_eq!(password, Secret::new(""));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn iam_needs_support_and_credentials_and_a_clean_user_name() {
    let unsupported = plan_for(&login(KvAuthMode::Iam, "u", 0), None, resolved(false, false, false), None, "r").unwrap_err();
    assert!(matches!(unsupported, AppError::Other { .. }));
    let no_cfg = plan_for(&login(KvAuthMode::Iam, "u", 0), None, resolved(false, false, true), None, "r").unwrap_err();
    assert_eq!(no_cfg, AppError::other("자격 증명 공급자를 찾을 수 없어요"));
    let cfg = aws_config::SdkConfig::builder().build();
    let bad_name = plan_for(&login(KvAuthMode::Iam, "a b", 0), None, resolved(false, false, true), Some(&cfg), "r").unwrap_err();
    assert!(matches!(bad_name, AppError::Other { .. }));
    let plan = plan_for(&login(KvAuthMode::Iam, "reader", 0), None, resolved(false, true, true), Some(&cfg), "ap-northeast-2").unwrap();
    assert_eq!(plan.auth.mode(), KvAuthMode::Iam);
    assert_eq!(plan.auth.user(), "reader");
}

#[test]
fn the_database_only_applies_to_cluster_mode_disabled_caches() {
    assert_eq!(plan_for(&login(KvAuthMode::None, "", 5), None, resolved(false, false, true), None, "r").unwrap().database, 5);
    assert_eq!(plan_for(&login(KvAuthMode::None, "", 5), None, resolved(true, false, true), None, "r").unwrap().database, 0);
    assert_eq!(plan_for(&login(KvAuthMode::None, "", 5), None, resolved(true, true, true), None, "r").unwrap().database, 0);
    assert!(plan_for(&login(KvAuthMode::None, "", 256), None, resolved(false, false, true), None, "r").is_err());
}

#[test]
fn the_mode_follows_the_target() {
    assert_eq!(plan_for(&login(KvAuthMode::None, "", 0), None, resolved(false, false, true), None, "r").unwrap().mode(), crate::kv::model::KvMode::Standalone);
    assert_eq!(plan_for(&login(KvAuthMode::None, "", 0), None, resolved(true, false, true), None, "r").unwrap().mode(), crate::kv::model::KvMode::Cluster);
    assert_eq!(plan_for(&login(KvAuthMode::None, "", 0), None, resolved(true, true, true), None, "r").unwrap().mode(), crate::kv::model::KvMode::Serverless);
}
