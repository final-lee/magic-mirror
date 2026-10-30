use serde_json::json;

use super::*;

fn secret() -> Value {
    json!({
        "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
        "metadata": { "name": "db", "namespace": "web", "annotations": {
            "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"password\":\"aHVudGVyMg==\"}}",
            "team": "a"
        } },
        "data": { "password": "aHVudGVyMg==", "blob": "//4=" },
        "stringData": { "token": "plain-secret" }
    })
}

#[test]
fn mask_hides_values_and_the_last_applied_annotation_but_keeps_keys() {
    let mut s = secret();
    mask(&mut s);
    assert_eq!(s["data"], json!({ "password": MASK, "blob": MASK }));
    assert_eq!(s["stringData"], json!({ "token": MASK }));
    assert_eq!(s["metadata"]["annotations"][LAST_APPLIED], json!(MASK));
    assert_eq!(s["metadata"]["annotations"]["team"], json!("a"));
    let text = s.to_string();
    for leak in ["aHVudGVyMg==", "hunter2", "plain-secret", "//4="] {
        assert!(!text.contains(leak), "{leak}");
    }
    let once = s.clone();
    mask(&mut s);
    assert_eq!(s, once);
}

#[test]
fn keys_report_decoded_sizes_sorted() {
    assert_eq!(
        keys(&secret()),
        [SecretKey { key: "blob".into(), size: 2 }, SecretKey { key: "password".into(), size: 7 }, SecretKey { key: "token".into(), size: 12 }]
    );
    assert!(keys(&json!({ "kind": "Secret" })).is_empty());
}

#[test]
fn value_of_decodes_text_and_falls_back_to_base64() {
    assert_eq!(value_of(&secret(), "password").unwrap(), SecretValue { text: "hunter2".into(), encoding: Encoding::Utf8 });
    assert_eq!(value_of(&secret(), "blob").unwrap(), SecretValue { text: "//4=".into(), encoding: Encoding::Base64 });
    assert_eq!(value_of(&secret(), "token").unwrap(), SecretValue { text: "plain-secret".into(), encoding: Encoding::Utf8 });
}

#[test]
fn errors_name_the_key_and_never_the_value() {
    assert_eq!(value_of(&secret(), "nope").unwrap_err(), AppError::other(key_missing("nope")));
    assert_eq!(key_missing("nope"), "이 Secret에 nope 키가 없어요");
    let bad = json!({ "data": { "k": "not base64 hunter2!" } });
    let err = value_of(&bad, "k").unwrap_err();
    assert_eq!(err, AppError::other(SECRET_UNREADABLE));
    assert!(!format!("{err:?}").contains("hunter2"));
}

#[test]
fn debug_and_json_shapes() {
    let v = value_of(&secret(), "password").unwrap();
    assert_eq!(format!("{v:?}"), "SecretValue(••••)");
    assert_eq!(serde_json::to_value(&v).unwrap(), json!({ "text": "hunter2", "encoding": "utf8" }));
    assert_eq!(serde_json::to_value(SecretKey { key: "a".into(), size: 1 }).unwrap(), json!({ "key": "a", "size": 1 }));
}

#[test]
fn secret_kind_detection() {
    assert!(is_secret(&secrets_kind()));
    let cm = KindRef { group: "".into(), version: "v1".into(), kind: "ConfigMap".into(), plural: "configmaps".into(), namespaced: true };
    assert!(!is_secret(&cm));
}
