use serde_json::json;

use super::*;
use crate::k8s::change::apply::MASK_CHANGED;
use crate::k8s::read::secret::MASK;

const MANIFEST: &str = "---\n# Source: demo/templates/configmap.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo-config\ndata:\n  message: \"hi\"\n---\n# Source: demo/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: demo-web\n  namespace: apps\nspec:\n  replicas: 1\n";

fn secret(value: &str) -> String {
    format!("---\n# Source: demo/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: db\ndata:\n  password: {value}\n  user: YWRtaW4=\n")
}

#[test]
fn documents_split_on_separators_and_comment_only_chunks_are_skipped() {
    let docs = parse(&format!("{MANIFEST}---\n# 빈 문서\n---\n")).unwrap();
    let names: Vec<_> = docs.iter().map(|d| (d.kind.as_str(), d.name.as_str(), d.namespace.as_deref())).collect();
    assert_eq!(names, [("ConfigMap", "demo-config", None), ("Deployment", "demo-web", Some("apps"))]);
    assert_eq!(docs[1].group(), "apps");
    assert_eq!(docs[0].group(), "");
    assert!(parse("").unwrap().is_empty());
}

#[test]
fn a_list_document_is_expanded_into_its_items() {
    let docs = parse("apiVersion: v1\nkind: List\nitems:\n  - {apiVersion: v1, kind: Service, metadata: {name: a}}\n  - {apiVersion: v1, kind: Service, metadata: {name: b}}\n").unwrap();
    assert_eq!(docs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
}

#[test]
fn an_unparseable_manifest_is_an_error_not_a_partial_result() {
    assert_eq!(parse("kind: [unclosed\n").unwrap_err(), AppError::other(MANIFEST_UNREADABLE));
    assert!(masked_text("kind: [unclosed\n").is_err());
}

#[test]
fn resources_carry_the_group_version_kind_and_declared_namespace() {
    let found = resources(&parse(MANIFEST).unwrap());
    assert_eq!(found[1], Resource { api_version: "apps/v1".into(), kind: "Deployment".into(), name: "demo-web".into(), namespace: Some("apps".into()) });
    assert_eq!(found[0].namespace, None);
}

#[test]
fn the_displayed_manifest_hides_secret_values_but_keeps_everything_else_verbatim() {
    let text = masked_text(&format!("{MANIFEST}{}", secret("c3VwZXItc2VjcmV0"))).unwrap();
    assert!(!text.contains("c3VwZXItc2VjcmV0") && !text.contains("YWRtaW4="), "{text}");
    assert!(text.contains(MASK) && text.contains("password") && text.contains("# Source: demo/templates/secret.yaml"));
    assert!(text.contains("# Source: demo/templates/configmap.yaml\napiVersion: v1\nkind: ConfigMap"));
    assert!(text.contains("message: \"hi\""));
    // 가린 글도 다시 해석된다
    assert_eq!(parse(&text).unwrap().len(), 3);
}

#[test]
fn objects_are_compared_by_group_kind_namespace_and_name_not_by_order_or_api_version() {
    let before = parse(MANIFEST).unwrap();
    let mut shuffled = before.clone();
    shuffled.reverse();
    assert_eq!(diff(&before, &shuffled), (vec![], Counts::default()));
    // 같은 객체의 apiVersion만 올라가면 삭제+추가가 아니라 한 객체의 변경이다
    let mut upgraded = before.clone();
    upgraded[1].api_version = "apps/v1beta1".into();
    upgraded[1].object["apiVersion"] = json!("apps/v1beta1");
    let (fields, counts) = diff(&before, &upgraded);
    assert_eq!(counts, Counts { added: 0, changed: 1, removed: 0 });
    assert_eq!(fields[0].path, "Deployment demo-web · apiVersion");
}

#[test]
fn added_changed_and_removed_objects_become_whole_object_or_field_entries() {
    let before = parse(MANIFEST).unwrap();
    let mut after = parse(MANIFEST).unwrap();
    after[1].object["spec"]["replicas"] = json!(3);
    after.remove(0);
    after.push(parse("apiVersion: v1\nkind: Service\nmetadata: {name: svc}\n").unwrap().remove(0));
    let (fields, counts) = diff(&before, &after);
    assert_eq!(counts, Counts { added: 1, changed: 1, removed: 1 });
    let by_path: std::collections::BTreeMap<_, _> = fields.iter().map(|f| (f.path.as_str(), f)).collect();
    assert_eq!(by_path["Deployment demo-web · spec.replicas"].before, json!(1));
    assert_eq!(by_path["Deployment demo-web · spec.replicas"].after, json!(3));
    assert_eq!(by_path["Service svc"].before, Value::Null);
    assert_eq!(by_path["Service svc"].after["metadata"]["name"], "svc");
    assert_eq!(by_path["ConfigMap demo-config"].after, Value::Null);
    assert_eq!(by_path["ConfigMap demo-config"].before["data"]["message"], "hi");
    assert_eq!(counts.total(), 3);
}

#[test]
fn secret_diffs_name_the_changed_keys_without_ever_carrying_a_value() {
    let before = parse(&secret("b2xk")).unwrap();
    let after = parse(&secret("bmV3")).unwrap();
    let (fields, counts) = diff(&before, &after);
    assert_eq!(counts.changed, 1);
    assert_eq!(fields.len(), 1, "{fields:?}");
    assert_eq!(fields[0].path, "Secret db · data.password");
    assert_eq!((fields[0].before.clone(), fields[0].after.clone()), (json!(MASK), json!(MASK_CHANGED)));
    // 새 Secret과 지워지는 Secret도 값이 가려진다
    let (added, _) = diff(&[], &after);
    let (removed, _) = diff(&before, &[]);
    for text in [serde_json::to_string(&added).unwrap(), serde_json::to_string(&removed).unwrap()] {
        assert!(!text.contains("bmV3") && !text.contains("b2xk") && !text.contains("YWRtaW4="), "{text}");
    }
}

#[test]
fn values_diff_lists_each_changed_key_with_a_values_prefix() {
    let fields = values_diff(&json!({"a": 1, "nested": {"x": "old", "keep": true}}), &json!({"a": 2, "nested": {"x": "new", "keep": true}, "added": [1]}));
    let paths: Vec<_> = fields.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["values · a", "values · added", "values · nested.x"]);
    assert!(values_diff(&json!({"a": 1}), &json!({"a": 1})).is_empty());
}
