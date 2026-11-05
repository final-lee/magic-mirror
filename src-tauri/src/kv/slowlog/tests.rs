use fred::types::Value;

use super::*;

fn s(text: &str) -> Value {
    Value::from(text)
}

fn entry(id: i64, time: i64, micros: i64, args: &[&str]) -> Value {
    Value::Array(vec![Value::Integer(id), Value::Integer(time), Value::Integer(micros), Value::Array(args.iter().map(|a| s(a)).collect()), s("10.0.0.9:51234"), s("magic-mirror")])
}

#[test]
fn entries_are_read_with_their_node() {
    let reply = Value::Array(vec![entry(7, 1_700_000_000, 15_000, &["KEYS", "*"]), entry(6, 1_699_999_000, 11_000, &["GET", "k"])]);
    let parsed = parse("n1:6379", &reply);
    assert_eq!(parsed.len(), 2);
    assert_eq!(
        parsed[0],
        KvSlowEntry { node: "n1:6379".into(), id: 7, time: 1_700_000_000, micros: 15_000, args: vec!["KEYS".into(), "*".into()], client: "10.0.0.9:51234".into(), name: "magic-mirror".into() }
    );
}

#[test]
fn long_arguments_keep_their_first_200_characters() {
    let long = "한".repeat(500);
    let parsed = parse("n", &Value::Array(vec![entry(1, 1, 1, &[&long])]));
    assert_eq!(parsed[0].args[0].chars().count(), 201);
    assert!(parsed[0].args[0].ends_with('…'));
    let exact = "x".repeat(200);
    assert_eq!(parse("n", &Value::Array(vec![entry(1, 1, 1, &[&exact])]))[0].args[0], exact);
}

#[test]
fn malformed_entries_are_skipped() {
    let reply = Value::Array(vec![Value::Array(vec![Value::Integer(1)]), s("junk"), entry(2, 2, 2, &["PING"])]);
    assert_eq!(parse("n", &reply).len(), 1);
    assert!(parse("n", &Value::Null).is_empty());
}

#[test]
fn commandlog_is_for_valkey_8_1_and_later() {
    assert!(commandlog_supported("valkey", "8.1.0"));
    assert!(commandlog_supported("valkey", "9.0"));
    assert!(commandlog_supported("valkey", "8.2.1"));
    assert!(!commandlog_supported("valkey", "8.0.2"));
    assert!(!commandlog_supported("valkey", "7.2.6"));
    assert!(!commandlog_supported("redis", "8.1.0"));
    assert!(!commandlog_supported("valkey", ""));
    assert!(!commandlog_supported("valkey", "latest"));
}
