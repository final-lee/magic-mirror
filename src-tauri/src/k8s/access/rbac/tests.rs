use std::collections::BTreeMap;

use k8s_openapi::api::rbac::v1 as k;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, LabelSelectorRequirement, ObjectMeta};

use super::*;
use crate::k8s::access::fixtures::*;

fn labels(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

#[test]
fn an_empty_selector_matches_everything_and_conditions_must_all_hold() {
    assert!(selector_matches(&Selector::default(), &labels(&[])));
    let both = Selector { match_labels: labels(&[("a", "1")]), match_expressions: vec![Requirement { key: "b".into(), operator: "Exists".into(), values: vec![] }] };
    assert!(selector_matches(&both, &labels(&[("a", "1"), ("b", "x")])));
    assert!(!selector_matches(&both, &labels(&[("a", "1")])));
    assert!(!selector_matches(&both, &labels(&[("a", "2"), ("b", "x")])));
}

#[test]
fn expression_operators_follow_the_kubernetes_meaning() {
    let l = labels(&[("tier", "web")]);
    assert!(selector_matches(&expression("tier", "In", &["web", "db"]), &l));
    assert!(!selector_matches(&expression("tier", "In", &["db"]), &l));
    assert!(selector_matches(&expression("tier", "NotIn", &["db"]), &l));
    // 키가 없으면 NotIn은 맞고 In은 틀리다
    assert!(selector_matches(&expression("missing", "NotIn", &["db"]), &l));
    assert!(!selector_matches(&expression("missing", "In", &["db"]), &l));
    assert!(selector_matches(&expression("missing", "DoesNotExist", &[]), &l));
    assert!(!selector_matches(&expression("tier", "DoesNotExist", &[]), &l));
    assert!(!selector_matches(&expression("tier", "Bogus", &[]), &l));
}

fn names(rules: &[SourcedRule]) -> Vec<(Option<&str>, &str)> {
    rules.iter().map(|r| (r.aggregated_from.as_deref(), r.rule.resources[0].as_str())).collect()
}

#[test]
fn an_aggregated_role_takes_the_rules_of_the_roles_its_selector_matches_in_name_order() {
    let roles = vec![
        aggregate("agg", "agg/me", "true"),
        labeled(cluster_role("b-role", vec![rule(&["get"], &[""], &["b"])]), "agg/me", "true"),
        labeled(cluster_role("a-role", vec![rule(&["get"], &[""], &["a"])]), "agg/me", "true"),
        cluster_role("unlabeled", vec![rule(&["get"], &[""], &["x"])]),
    ];
    let resolved = resolve_cluster_roles(&roles);
    assert_eq!(names(&resolved["agg"]), vec![(Some("a-role"), "a"), (Some("b-role"), "b")]);
    // 합쳐지는 쪽 자신의 규칙은 그대로다
    assert_eq!(names(&resolved["a-role"]), vec![(None, "a")]);
}

#[test]
fn rules_written_on_an_aggregated_role_are_replaced_by_the_aggregation() {
    let mut agg = aggregate("agg", "agg/me", "true");
    agg.rules = vec![rule(&["*"], &["*"], &["*"])];
    let resolved = resolve_cluster_roles(&[agg]);
    assert!(resolved["agg"].is_empty());
}

#[test]
fn aggregation_follows_several_levels_and_does_not_repeat_equal_rules() {
    let resolved = resolve_cluster_roles(&builtin_roles());
    let admin: Vec<&str> = resolved["admin"].iter().flat_map(|r| r.rule.resources.iter().map(String::as_str)).collect();
    // admin ← (edit ← (view ← aggregate-to-view) + aggregate-to-edit) + aggregate-to-admin
    assert!(admin.contains(&"roles") && admin.contains(&"deployments") && admin.contains(&"pods/log"), "{admin:?}");
    let get_pods = rule(&["get", "list", "watch"], &[""], &["pods", "services", "configmaps", "persistentvolumeclaims", "endpoints", "pods/log"]);
    assert_eq!(resolved["admin"].iter().filter(|r| r.rule == get_pods).count(), 1);
    let from_edit = resolved["admin"].iter().find(|r| r.rule == get_pods).unwrap();
    assert_eq!(from_edit.aggregated_from.as_deref(), Some("edit"));
}

#[test]
fn an_aggregation_that_matches_itself_or_loops_terminates() {
    let mut a = aggregate("a", "loop", "true");
    a.labels = labels(&[("loop", "true")]);
    let mut b = aggregate("b", "loop", "true");
    b.labels = labels(&[("loop", "true")]);
    b.rules = vec![];
    let c = labeled(cluster_role("c", vec![rule(&["get"], &[""], &["c"])]), "loop", "true");
    let resolved = resolve_cluster_roles(&[a, b, c]);
    // 스스로는 빼고 서로와 c를 합친다. 순환은 끊는다
    assert!(names(&resolved["a"]).iter().any(|(_, r)| *r == "c"));
    assert!(names(&resolved["b"]).iter().any(|(_, r)| *r == "c"));
}

fn meta(name: &str) -> ObjectMeta {
    ObjectMeta { name: Some(name.into()), ..Default::default() }
}

#[test]
fn k8s_objects_convert_keeping_aggregation_subjects_and_dropping_the_unusable() {
    let cr = k::ClusterRole {
        metadata: ObjectMeta { labels: Some(labels(&[("x", "y")])), ..meta("agg") },
        aggregation_rule: Some(k::AggregationRule {
            cluster_role_selectors: Some(vec![LabelSelector {
                match_labels: Some(labels(&[("a", "b")])),
                match_expressions: Some(vec![LabelSelectorRequirement { key: "k".into(), operator: "In".into(), values: Some(vec!["v".into()]) }]),
            }]),
        }),
        rules: None,
    };
    let converted = cluster_role_of(&cr);
    assert_eq!(converted.aggregation.as_ref().unwrap()[0].match_expressions[0].values, vec!["v".to_string()]);
    assert_eq!(converted.labels["x"], "y");

    let binding = k::ClusterRoleBinding {
        metadata: meta("b"),
        role_ref: k::RoleRef { api_group: "rbac.authorization.k8s.io".into(), kind: "ClusterRole".into(), name: "view".into() },
        subjects: Some(vec![
            k::Subject { kind: "User".into(), name: "alice".into(), ..Default::default() },
            k::Subject { kind: "ServiceAccount".into(), name: "sa".into(), namespace: Some("ns".into()), ..Default::default() },
            // 네임스페이스가 없는 ServiceAccount와 모르는 종류는 어떤 주체에도 맞지 않는다
            k::Subject { kind: "ServiceAccount".into(), name: "lost".into(), ..Default::default() },
            k::Subject { kind: "Robot".into(), name: "r2".into(), ..Default::default() },
        ]),
    };
    let b = cluster_binding_of(&binding).unwrap();
    assert_eq!(b.subjects, vec![Subject::user("alice"), Subject::service_account("ns", "sa")]);

    let bad = k::ClusterRoleBinding { role_ref: k::RoleRef { api_group: String::new(), kind: "Weird".into(), name: "x".into() }, ..binding };
    assert!(cluster_binding_of(&bad).is_none());
}

#[test]
fn subject_keys_keep_kinds_apart() {
    assert_ne!(Subject::user("dev").key(), Subject::group("dev").key());
    assert_eq!(Subject::service_account("a", "b").key(), "sa:a/b");
}
