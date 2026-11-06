use serde_json::json;

use super::*;

#[test]
fn names_are_sorted_unique_and_skip_blanks() {
    let body = json!({"items": [{"name": "slack"}, {"name": ""}, {"name": "email"}, {"name": "slack"}, {}]});
    assert_eq!(names(&body), ["email", "slack"]);
    assert!(names(&json!({})).is_empty());
    assert!(names(&json!({"items": null})).is_empty());
}

#[test]
fn catalog_keeps_the_three_lists_apart() {
    let c = catalog(
        &json!({"items": [{"name": "slack"}]}),
        &json!({"items": [{"name": "on-sync-failed"}, {"name": "on-deployed"}]}),
        &json!({"items": [{"name": "app-deployed"}]}),
    );
    assert_eq!(c.services, ["slack"]);
    assert_eq!(c.triggers, ["on-deployed", "on-sync-failed"]);
    assert_eq!(c.templates, ["app-deployed"]);
    let wire = serde_json::to_value(&c).unwrap();
    assert_eq!(wire["triggers"][0], "on-deployed");
}
