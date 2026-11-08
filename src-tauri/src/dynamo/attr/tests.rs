use serde_json::json;

use super::*;

fn round_trip(value: Value) -> Value {
    to_json(&from_json(&value).unwrap()).unwrap()
}

#[test]
fn every_type_survives_a_round_trip() {
    let item = json!({
        "id": {"S": "user#1"},
        "count": {"N": "42"},
        "raw": {"B": "AAECAw=="},
        "tags": {"SS": ["a", "b"]},
        "scores": {"NS": ["1", "2.5"]},
        "blobs": {"BS": ["AAE=", "AgM="]},
        "nested": {"M": {"deep": {"L": [{"S": "x"}, {"N": "1"}, {"NULL": true}, {"BOOL": false}]}}},
        "none": {"NULL": true},
        "flag": {"BOOL": true},
    });
    let parsed = item_from_json(&item).unwrap();
    assert_eq!(item_to_json(&parsed).unwrap(), item);
}

#[test]
fn numbers_keep_every_digit_and_their_spelling() {
    for n in ["1.50", "0.1000000000000000055511151231257827", "12345678901234567890123456789012345678", "-0", "1E+2", "9.9999999999999999999999999999999999999E+125"] {
        assert_eq!(round_trip(json!({"N": n})), json!({"N": n}));
    }
    let set = json!({"NS": ["1.50", "01", "3E2"]});
    assert_eq!(round_trip(set.clone()), set);
}

#[test]
fn binary_is_decoded_to_bytes_and_encoded_back() {
    match from_json(&json!({"B": "AAECAw=="})).unwrap() {
        AttributeValue::B(b) => assert_eq!(b.as_ref(), &[0u8, 1, 2, 3]),
        other => panic!("바이너리여야 해요: {other:?}"),
    }
    match from_json(&json!({"BS": ["AAE=", "AgM="]})).unwrap() {
        AttributeValue::Bs(v) => assert_eq!(v.iter().map(|b| b.as_ref().to_vec()).collect::<Vec<_>>(), vec![vec![0, 1], vec![2, 3]]),
        other => panic!("바이너리 집합이어야 해요: {other:?}"),
    }
    // 빈 바이너리도 그대로
    assert_eq!(round_trip(json!({"B": ""})), json!({"B": ""}));
}

#[test]
fn sets_keep_their_members_in_order() {
    assert_eq!(round_trip(json!({"SS": ["z", "a", "m"]})), json!({"SS": ["z", "a", "m"]}));
}

#[test]
fn a_number_given_as_a_json_number_is_refused() {
    // 숫자를 JSON 숫자로 받으면 이미 정밀도를 잃은 뒤라 문자열만 받는다
    assert!(from_json(&json!({"N": 1.5})).is_err());
    assert!(from_json(&json!({"NS": [1, 2]})).is_err());
}

#[test]
fn malformed_values_are_refused() {
    for bad in [
        json!({"S": 1}),
        json!({"N": "abc"}),
        json!({"N": "NaN"}),
        json!({"N": "inf"}),
        json!({"N": ""}),
        json!({"N": " 1"}),
        json!({"NS": ["1", "x"]}),
        json!({"B": "***"}),
        json!({"BS": ["AAE=", "!"]}),
        json!({"SS": "a"}),
        json!({"SS": [1]}),
        json!({"NULL": false}),
        json!({"NULL": "true"}),
        json!({"BOOL": "yes"}),
        json!({"L": {"S": "a"}}),
        json!({"M": [1]}),
        json!({"M": {"a": "plain"}}),
        json!({"X": "?"}),
        json!({"S": "a", "N": "1"}),
        json!({}),
        json!("plain"),
        json!(["S"]),
    ] {
        assert!(from_json(&bad).is_err(), "받아들이면 안 돼요: {bad}");
    }
    assert!(item_from_json(&json!([])).is_err());
}

#[test]
fn an_error_inside_a_nested_value_fails_the_whole_item() {
    let item = json!({"ok": {"S": "x"}, "m": {"M": {"deep": {"L": [{"N": "1"}, {"N": "nope"}]}}}});
    assert!(item_from_json(&item).is_err());
}

#[test]
fn an_empty_item_and_empty_containers_round_trip() {
    assert_eq!(item_to_json(&item_from_json(&json!({})).unwrap()).unwrap(), json!({}));
    assert_eq!(round_trip(json!({"M": {}})), json!({"M": {}}));
    assert_eq!(round_trip(json!({"L": []})), json!({"L": []}));
}
