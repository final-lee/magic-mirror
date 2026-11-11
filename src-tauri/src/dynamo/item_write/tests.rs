use super::*;
use serde_json::json;

fn placeholder<'a>(plan: &'a ItemExpressions, name: &str) -> &'a str {
    plan.expressions.names.iter().find(|(_, value)| value.as_str() == name).unwrap().0
}

#[test]
fn update_only_changes_differences_and_guards_old_new_and_version() {
    let original = json!({
        "id": {"S": "one"}, "stable": {"S": "same"},
        "change": {"N": "1"}, "remove": {"BOOL": true}, "version": {"N": "7"}
    });
    let updated = json!({
        "id": {"S": "one"}, "stable": {"S": "same"},
        "change": {"N": "2"}, "added": {"S": "new"}, "version": {"N": "7"}
    });
    let plan = update(&original, &updated, &["id".into()]).unwrap();
    let update = plan.update.as_ref().unwrap();
    let added = placeholder(&plan, "added");
    let changed = placeholder(&plan, "change");
    let removed = placeholder(&plan, "remove");
    let version = placeholder(&plan, "version");
    assert!(update.contains(&format!("{changed} =")));
    assert!(update.contains(&format!("{added} =")));
    assert!(update.contains(&format!("REMOVE {removed}")));
    assert!(plan.condition.contains(&format!("attribute_not_exists({added})")));
    for name in [changed, removed, version] {
        assert!(plan.condition.contains(&format!("{name} =")));
    }
    assert!(!plan.expressions.names.values().any(|name| name == "stable"));
    assert!(plan.condition.contains(&format!("{} =", placeholder(&plan, "id"))));
    assert_eq!(plan.expressions.values.len(), 6);
}

#[test]
fn update_rejects_no_change_and_key_mutations() {
    let original = json!({"id": {"S": "one"}, "value": {"N": "1"}});
    assert!(update(&original, &original, &["id".into()]).is_err());
    let moved = json!({"id": {"S": "two"}, "value": {"N": "2"}});
    assert!(update(&original, &moved, &["id".into()]).is_err());
    assert!(update(&original, &moved, &[]).is_err());
}

#[test]
fn reverse_update_guards_new_values_and_restores_old_ones() {
    let old = json!({"id": {"S": "one"}, "removed": {"S": "before"}});
    let new = json!({"id": {"S": "one"}, "added": {"S": "after"}});
    let inverse = update(&new, &old, &["id".into()]).unwrap();
    let removed = placeholder(&inverse, "removed");
    let added = placeholder(&inverse, "added");
    assert!(inverse.condition.contains(&format!("attribute_not_exists({removed})")));
    assert!(inverse.condition.contains(&format!("{added} =")));
    assert!(inverse.update.as_ref().unwrap().contains(&format!("REMOVE {added}")));
}

#[test]
fn delete_and_new_item_conditions_use_placeholders() {
    let item = json!({"id": {"S": "one"}, "order": {"N": "12345678901234567890"}});
    let same = same_item_condition(&item).unwrap();
    assert_eq!(same.expressions.values.len(), 2);
    for attribute in ["id", "order"] {
        assert!(same.condition.contains(&format!("{} =", placeholder(&same, attribute))));
    }
    let absent = not_exists_condition("id").unwrap();
    assert!(absent.condition.contains(&format!("attribute_not_exists({})", placeholder(&absent, "id"))));
    assert!(absent.expressions.values.is_empty());
    assert!(same_item_condition(&json!({})).is_err());
}

#[test]
fn key_extraction_requires_all_valid_keys_and_omits_non_keys() {
    let item = json!({"pk": {"S": "a"}, "sk": {"N": "1"}, "other": {"S": "x"}});
    assert_eq!(key(&item, &["pk".into(), "sk".into()]).unwrap(), json!({"pk": {"S": "a"}, "sk": {"N": "1"}}));
    assert!(key(&item, &["missing".into()]).is_err());
    assert!(key(&json!({"pk": "plain"}), &["pk".into()]).is_err());
}

#[test]
fn nested_changes_set_the_top_level_attribute() {
    let old = json!({"id": {"S": "one"}, "details": {"M": {"values": {"L": [{"N": "1"}]}}}});
    let new = json!({"id": {"S": "one"}, "details": {"M": {"values": {"L": [{"N": "2"}]}}}});
    let plan = update(&old, &new, &["id".into()]).unwrap();
    let details = placeholder(&plan, "details");
    assert!(plan.update.as_ref().unwrap().contains(&format!("{details} =")));
    assert!(plan.condition.contains(&format!("{details} =")));
    assert_eq!(plan.expressions.names.len(), 2);
}

#[test]
fn undo_guards_unchanged_attributes_as_well() {
    let before = json!({"id": {"S": "one"}, "value": {"N": "2"}, "other": {"S": "kept"}});
    let after = json!({"id": {"S": "one"}, "value": {"N": "1"}, "other": {"S": "kept"}});
    let plan = update_guarded(&before, &after, &["id".into()], true).unwrap();
    assert!(plan.condition.contains(&format!("{} =", placeholder(&plan, "other"))));
}
