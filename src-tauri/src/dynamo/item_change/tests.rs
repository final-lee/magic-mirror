use super::*;
use serde_json::json;

#[test]
fn inverse_plans_restore_each_item_change() {
    let table = DynamoTable::fixture("orders");
    let old = json!({"id": {"S": "one"}, "nested": {"M": {"x": {"N": "1"}}}});
    let new = json!({"id": {"S": "one"}, "nested": {"M": {"x": {"N": "2"}}}});
    let moved = json!({"id": {"S": "two"}, "nested": {"M": {"x": {"N": "2"}}}});
    let key = json!({"id": {"S": "one"}});
    let cases = [
        (DynamoChange::PutItem { item: old.clone(), condition: None }, DynamoChange::DeleteItems { items: vec![old.clone()] }),
        (DynamoChange::UpdateItem { key: key.clone(), original: old.clone(), updated: new.clone(), guard_all: false }, DynamoChange::UpdateItem { key, original: new.clone(), updated: old.clone(), guard_all: true }),
        (DynamoChange::MoveItem { original: old.clone(), updated: moved.clone() }, DynamoChange::MoveItem { original: moved, updated: old.clone() }),
        (DynamoChange::DeleteItems { items: vec![old.clone()] }, DynamoChange::RestoreItems { items: vec![old] }),
    ];
    for (change, expected) in cases {
        let plan = preview(&table, &change).unwrap();
        assert!(plan.blocked.is_none());
        assert_eq!(plan.inverse, Some(expected.clone()));
        assert!(preview(&table, &expected).unwrap().blocked.is_none());
    }
}

#[test]
fn move_and_confirmation_rules() {
    let table = DynamoTable::fixture("test");
    let one = json!({"id": {"S": "one"}});
    let two = json!({"id": {"S": "two"}});
    let change = DynamoChange::MoveItem { original: one.clone(), updated: two.clone() };
    let plan = preview(&table, &change).unwrap();
    assert_eq!(plan.calls[0].api, "TransactWriteItems");
    assert!(!plan.warnings.is_empty());
    assert!(plan.confirm_name.is_none());
    assert!(preview(&table, &DynamoChange::DeleteItems { items: vec![one.clone()] }).unwrap().confirm_name.is_none());
    assert_eq!(preview(&table, &DynamoChange::DeleteItems { items: vec![one.clone(), two] }).unwrap().confirm_name.as_deref(), Some("test"));
    assert_eq!(preview(&DynamoTable::fixture("PRD-data"), &DynamoChange::PutItem { item: one, condition: None }).unwrap().confirm_name.as_deref(), Some("PRD-data"));
}
