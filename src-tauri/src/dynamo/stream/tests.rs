use aws_sdk_dynamodbstreams::primitives::{Blob, DateTime};
use aws_sdk_dynamodbstreams::types::{OperationType, SequenceNumberRange, StreamRecord};
use serde_json::json;

use super::*;

/// 열린 샤드(끝 시퀀스 번호 없음)
fn open(id: &str, parent: Option<&str>) -> Shard {
    Shard::builder().shard_id(id).set_parent_shard_id(parent.map(str::to_string)).build()
}

/// 닫힌 샤드(끝 시퀀스 번호 있음)
fn closed(id: &str, parent: Option<&str>) -> Shard {
    let range = SequenceNumberRange::builder().starting_sequence_number("1").ending_sequence_number("9").build();
    Shard::builder().shard_id(id).set_parent_shard_id(parent.map(str::to_string)).sequence_number_range(range).build()
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| v.to_string()).collect()
}

fn set(values: &[&str]) -> HashSet<String> {
    values.iter().map(|v| v.to_string()).collect()
}

fn reading(shard_ids: &[&str]) -> HashMap<String, String> {
    shard_ids.iter().map(|id| (id.to_string(), format!("iterator-{id}"))).collect()
}

// 샤드 고르기 ------------------------------------------------------------------------------

#[test]
fn a_child_shard_waits_until_its_parent_is_read_to_the_end() {
    let shards = vec![closed("a", None), open("b", Some("a")), open("c", Some("b"))];

    assert_eq!(ready_shard_ids(&shards, &reading(&[]), &set(&[])), ids(&["a"]));
    // 부모를 읽는 동안에도 자식은 기다린다
    assert_eq!(ready_shard_ids(&shards, &reading(&["a"]), &set(&[])), ids(&[]));
    assert_eq!(ready_shard_ids(&shards, &reading(&[]), &set(&["a"])), ids(&["b"]));
    // 손자는 부모(b)를 끝까지 읽어야 열린다
    assert_eq!(ready_shard_ids(&shards, &reading(&["b"]), &set(&["a"])), ids(&[]));
    assert_eq!(ready_shard_ids(&shards, &reading(&[]), &set(&["a", "b"])), ids(&["c"]));
}

#[test]
fn a_shard_whose_parent_has_left_the_description_is_not_held_back() {
    // 부모가 24시간이 지나 설명에서 사라졌다
    let shards = vec![open("b", Some("expired")), open("c", Some("b"))];
    assert_eq!(ready_shard_ids(&shards, &reading(&[]), &set(&[])), ids(&["b"]));
}

#[test]
fn shards_already_being_read_or_finished_are_not_opened_again() {
    let shards = vec![closed("a", None), open("b", None), open("c", None), open("d", None)];
    // a는 끝까지 읽었고 b는 읽는 중이다. 남은 것만 설명에 나온 순서로
    assert_eq!(ready_shard_ids(&shards, &reading(&["b"]), &set(&["a"])), ids(&["c", "d"]));
    assert_eq!(ready_shard_ids(&shards, &reading(&["b", "c", "d"]), &set(&["a"])), ids(&[]));
}

#[test]
fn starting_from_latest_skips_closed_shards_but_reads_their_open_children() {
    let shards = vec![closed("a", None), open("b", Some("a")), open("c", None)];
    let skipped = closed_shard_ids(&shards);

    assert_eq!(skipped, set(&["a"]));
    assert_eq!(ready_shard_ids(&shards, &reading(&[]), &skipped), ids(&["b", "c"]));
    // 처음부터 읽을 때는 닫힌 샤드도 읽어야 하고, 그 자식은 기다린다
    assert_eq!(ready_shard_ids(&shards, &reading(&[]), &set(&[])), ids(&["a", "c"]));
}

#[test]
fn at_most_ten_shards_are_read_at_once_and_the_rest_are_counted_as_behind() {
    let twelve: Vec<String> = (0..12).map(|i| format!("s{i}")).collect();

    let (opened, behind) = split_by_capacity(twelve.clone(), 0);
    assert_eq!(opened, twelve[..10]);
    assert_eq!(behind, 2);

    // 이미 8개를 읽는 중이면 2개만 더 연다
    let (opened, behind) = split_by_capacity(twelve[..5].to_vec(), 8);
    assert_eq!(opened, twelve[..2]);
    assert_eq!(behind, 3);

    let (opened, behind) = split_by_capacity(twelve[..3].to_vec(), 10);
    assert!(opened.is_empty());
    assert_eq!(behind, 3);

    let (opened, behind) = split_by_capacity(twelve[..3].to_vec(), 4);
    assert_eq!(opened, twelve[..3]);
    assert_eq!(behind, 0);
}

#[test]
fn only_latest_and_trim_horizon_are_accepted_as_start_points() {
    assert_eq!(StartFrom::parse("LATEST").unwrap(), StartFrom::Latest);
    assert_eq!(StartFrom::parse("TRIM_HORIZON").unwrap(), StartFrom::TrimHorizon);
    assert!(StartFrom::parse("AT_SEQUENCE_NUMBER").is_err());
    assert!(StartFrom::parse("latest").is_err());
}

// 레코드 해석 ------------------------------------------------------------------------------

fn text(value: &str) -> StreamValue {
    StreamValue::S(value.to_string())
}

fn number(value: &str) -> StreamValue {
    StreamValue::N(value.to_string())
}

/// 키 `pk`만 담은 변경 내용. 이미지는 호출하는 쪽이 얹는다
fn change() -> aws_sdk_dynamodbstreams::types::builders::StreamRecordBuilder {
    StreamRecord::builder().keys("pk", text("order#1")).size_bytes(48).approximate_creation_date_time(DateTime::from_secs(1_700_000_000))
}

fn record(event: OperationType, change: StreamRecord) -> SdkRecord {
    SdkRecord::builder().event_id("event-1").event_name(event).dynamodb(change).build()
}

#[test]
fn an_insert_with_both_images_has_only_the_new_image() {
    let change = change().new_image("pk", text("order#1")).new_image("total", number("10.50")).build();
    let parsed = parse_record(&record(OperationType::Insert, change)).unwrap().unwrap();

    assert_eq!(
        parsed,
        Record {
            id: "event-1".into(),
            event: "INSERT".into(),
            time: Some(1_700_000_000),
            keys: Some(json!({"pk": {"S": "order#1"}})),
            size: Some(48),
            old_image: None,
            new_image: Some(json!({"pk": {"S": "order#1"}, "total": {"N": "10.50"}})),
        }
    );
}

#[test]
fn a_modify_carries_both_images_and_a_remove_only_the_old_one() {
    let modify = change().old_image("total", number("10")).new_image("total", number("12")).build();
    let parsed = parse_record(&record(OperationType::Modify, modify)).unwrap().unwrap();
    assert_eq!(parsed.event, "MODIFY");
    assert_eq!(parsed.old_image, Some(json!({"total": {"N": "10"}})));
    assert_eq!(parsed.new_image, Some(json!({"total": {"N": "12"}})));

    let remove = change().old_image("total", number("12")).build();
    let parsed = parse_record(&record(OperationType::Remove, remove)).unwrap().unwrap();
    assert_eq!(parsed.event, "REMOVE");
    assert_eq!(parsed.old_image, Some(json!({"total": {"N": "12"}})));
    assert_eq!(parsed.new_image, None);
}

#[test]
fn a_keys_only_stream_has_keys_and_no_images() {
    let parsed = parse_record(&record(OperationType::Modify, change().build())).unwrap().unwrap();

    assert_eq!(parsed.keys, Some(json!({"pk": {"S": "order#1"}})));
    assert_eq!(parsed.old_image, None);
    assert_eq!(parsed.new_image, None);
}

#[test]
fn a_record_without_a_change_is_skipped() {
    let bare = SdkRecord::builder().event_id("event-2").event_name(OperationType::Insert).build();
    assert_eq!(parse_record(&bare).unwrap(), None);
}

#[test]
fn every_attribute_type_in_an_image_keeps_its_value() {
    let nested = StreamValue::M(HashMap::from([
        ("list".to_string(), StreamValue::L(vec![text("x"), number("1.50"), StreamValue::Null(true), StreamValue::Bool(false)])),
        ("tags".to_string(), StreamValue::Ss(vec!["a".into(), "b".into()])),
    ]));
    let change = change()
        .new_image("nested", nested)
        .new_image("scores", StreamValue::Ns(vec!["1".into(), "2.5".into()]))
        .new_image("raw", StreamValue::B(Blob::new(vec![0, 1, 2, 3])))
        .new_image("blobs", StreamValue::Bs(vec![Blob::new(vec![0, 1]), Blob::new(vec![2, 3])]))
        .build();
    let parsed = parse_record(&record(OperationType::Insert, change)).unwrap().unwrap();

    assert_eq!(
        parsed.new_image,
        Some(json!({
            "nested": {"M": {"list": {"L": [{"S": "x"}, {"N": "1.50"}, {"NULL": true}, {"BOOL": false}]}, "tags": {"SS": ["a", "b"]}}},
            "scores": {"NS": ["1", "2.5"]},
            "raw": {"B": "AAECAw=="},
            "blobs": {"BS": ["AAE=", "AgM="]},
        }))
    );
}
