use super::*;
use serde_json::json;

#[test]
fn partial_delete_restores_only_successful_before_images() {
    let first = json!({"id": {"S": "one"}});
    let second = json!({"id": {"S": "two"}});
    let before = json!({"id": {"S": "one"}, "extra": {"S": "actual"}});
    let change = DynamoChange::DeleteItems { items: vec![first.clone(), second.clone()] };
    let results = vec![
        ItemResult { item: first, ok: true, error: None, latest: None, before_image: Some(before.clone()) },
        ItemResult { item: second, ok: false, error: Some("충돌".into()), latest: None, before_image: None },
    ];
    assert_eq!(inverse(&change, &results, None), Some(DynamoChange::RestoreItems { items: vec![before] }));
    assert_eq!(inverse(&change, &results[1..], None), None);
}
