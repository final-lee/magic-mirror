use serde_json::json;

use super::*;

#[test]
fn a_target_uses_camel_case_kinds() {
    let target: KvTarget = serde_json::from_value(json!({ "profile": "p", "region": "ap-northeast-2", "kind": "serverlessCache", "id": "c" })).unwrap();
    assert_eq!(target.kind, KvKind::ServerlessCache);
    assert_eq!(serde_json::to_value(KvKind::ReplicationGroup).unwrap(), json!("replicationGroup"));
    assert_eq!(serde_json::to_value(KvKind::CacheCluster).unwrap(), json!("cacheCluster"));
}

#[test]
fn a_login_is_flat_like_the_typescript_contract_and_hides_its_password_from_debug() {
    let login: KvLogin = serde_json::from_value(json!({ "mode": "user", "user": "app", "database": 2, "password": "s3cret", "rememberPassword": true })).unwrap();
    assert_eq!(login.saved, KvLoginSaved { mode: KvAuthMode::User, user: "app".into(), database: 2 });
    assert_eq!(login.password.as_deref(), Some("s3cret"));
    assert!(login.remember_password);
    assert!(!format!("{login:?}").contains("s3cret"));
    let null_password: KvLogin = serde_json::from_value(json!({ "mode": "none", "user": "", "database": 0, "password": null, "rememberPassword": false })).unwrap();
    assert_eq!(null_password.password, None);
}

#[test]
fn key_names_are_binary_safe() {
    let text = KvKeyName::from_bytes("user:42".as_bytes());
    assert_eq!(text, KvKeyName { text: "user:42".into(), base64: None });
    assert_eq!(text.to_bytes().unwrap(), b"user:42");

    let binary = KvKeyName::from_bytes(&[0x75, 0xff, 0x00, 0x42]);
    assert!(binary.base64.is_some());
    assert_eq!(binary.to_bytes().unwrap(), vec![0x75, 0xff, 0x00, 0x42]);
    // 같은 값을 돌려주면 정확한 바이트가 나온다
    let echoed: KvKeyName = serde_json::from_value(serde_json::to_value(&binary).unwrap()).unwrap();
    assert_eq!(echoed.to_bytes().unwrap(), vec![0x75, 0xff, 0x00, 0x42]);
    assert!(KvKeyName { text: String::new(), base64: Some("!!!".into()) }.to_bytes().is_err());
}

#[test]
fn types_are_named_like_the_server_and_the_contract() {
    assert_eq!(KvType::from_type_name("ReJSON-RL"), KvType::Json);
    assert_eq!(KvType::from_type_name("zset"), KvType::Zset);
    assert_eq!(KvType::from_type_name("MBbloom--"), KvType::Other);
    assert_eq!(KvType::Json.scan_name(), Some("ReJSON-RL"));
    assert_eq!(KvType::Other.scan_name(), None);
    assert_eq!(serde_json::to_value(KvType::Zset).unwrap(), json!("zset"));
}

#[test]
fn values_serialize_with_a_type_tag_and_camel_case_fields() {
    let other = serde_json::to_value(KvValue::Other { type_name: "MBbloom--".into() }).unwrap();
    assert_eq!(other, json!({ "type": "other", "typeName": "MBbloom--" }));
    let string = serde_json::to_value(KvValue::String { value: KvBytes::from_bytes(b"hi"), truncated: false }).unwrap();
    assert_eq!(string, json!({ "type": "string", "value": { "text": "hi", "base64": "aGk=", "bytes": 2 }, "truncated": false }));
    let stream = serde_json::to_value(KvValue::Stream {
        summary: Some(KvStreamSummary { length: 2, groups: 0, first_id: Some("1-0".into()), last_id: None }),
        entries: vec![],
    })
    .unwrap();
    assert_eq!(stream, json!({ "type": "stream", "summary": { "length": 2, "groups": 0, "firstId": "1-0", "lastId": null }, "entries": [] }));
}

#[test]
fn bytes_that_are_not_utf8_have_no_text() {
    let bytes = KvBytes::from_bytes(&[0xff, 0xfe]);
    assert_eq!(bytes.text, None);
    assert_eq!(bytes.bytes, 2);
    assert_eq!(bytes.base64, "//4=");
}

#[test]
fn rows_and_messages_use_the_contract_field_names() {
    let row = serde_json::to_value(KvKeyRow { name: KvKeyName::from_bytes(b"k"), kind: KvType::Hash, ttl_ms: Some(1500) }).unwrap();
    assert_eq!(row, json!({ "name": { "text": "k", "base64": null }, "type": "hash", "ttlMs": 1500 }));
    let done = serde_json::to_value(KvBigKeysMessage::Done(KvBigKeysReport { basis: KvBigKeysBasis::Length, keys: vec![], scanned: 10, stopped: true, generated_at: 7 })).unwrap();
    assert_eq!(done, json!({ "type": "done", "basis": "length", "keys": [], "scanned": 10, "stopped": true, "generatedAt": 7 }));
    // 중간 결과가 없으면 keys를 보내지 않는다
    let progress = serde_json::to_value(KvBigKeysMessage::Progress { scanned: 1, total: 2, keys: None }).unwrap();
    assert_eq!(progress, json!({ "type": "progress", "scanned": 1, "total": 2 }));
    let partial = serde_json::to_value(KvBigKeysMessage::Progress { scanned: 50_000, total: 90_000, keys: Some(vec![]) }).unwrap();
    assert_eq!(partial, json!({ "type": "progress", "scanned": 50_000, "total": 90_000, "keys": [] }));
    assert_eq!(serde_json::to_value([KvFeature::Slowlog, KvFeature::Encoding]).unwrap(), json!(["slowlog", "encoding"]));
    assert_eq!(serde_json::to_value(KvMode::Serverless).unwrap(), json!("serverless"));
}

#[test]
fn a_login_error_serializes_with_its_kind() {
    let error = serde_json::to_value(AppError::LoginRequired { message: "비밀번호가 맞지 않아요".into() }).unwrap();
    assert_eq!(error, json!({ "kind": "loginRequired", "message": "비밀번호가 맞지 않아요" }));
}
