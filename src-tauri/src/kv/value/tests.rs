use fred::bytes::Bytes;
use fred::types::{Map, Value};

use super::*;

fn s(text: &str) -> Value {
    Value::from(text)
}

#[test]
fn strings_bytes_and_integers_read_as_bytes() {
    assert_eq!(bytes(&s("abc")), Some(b"abc".to_vec()));
    assert_eq!(bytes(&Value::Bytes(Bytes::from_static(&[0xff, 0x00]))), Some(vec![0xff, 0x00]));
    assert_eq!(bytes(&Value::Integer(42)), Some(b"42".to_vec()));
    assert_eq!(bytes(&Value::Null), None);
}

#[test]
fn text_replaces_invalid_utf8() {
    assert_eq!(text(&Value::Bytes(Bytes::from_static(&[b'a', 0xff]))), Some("a\u{fffd}".to_string()));
}

#[test]
fn numbers_read_from_integers_and_strings() {
    assert_eq!(int(&Value::Integer(-1)), Some(-1));
    assert_eq!(int(&s(" 12 ")), Some(12));
    assert_eq!(int(&s("x")), None);
    assert_eq!(float(&s("1.5")), Some(1.5));
    assert_eq!(float(&s("inf")), Some(f64::INFINITY));
}

#[test]
fn pairs_read_flat_arrays_and_maps_the_same_way() {
    let flat = Value::Array(vec![s("id"), s("n1"), s("port"), Value::Integer(6379)]);
    let from_flat = pairs(&flat);
    assert_eq!(from_flat.len(), 2);
    assert_eq!(field(&flat, "port").and_then(int), Some(6379));

    let mut map = Map::new();
    map.insert("id".into(), s("n1"));
    map.insert("port".into(), Value::Integer(6379));
    let resp3 = Value::Map(map);
    assert_eq!(field(&resp3, "id").and_then(text).as_deref(), Some("n1"));
    assert_eq!(field(&resp3, "missing"), None);
    // 배열이 아니면 빈 목록
    assert!(items(&Value::Integer(1)).is_empty());
    assert!(pairs(&Value::Null).is_empty());
}
