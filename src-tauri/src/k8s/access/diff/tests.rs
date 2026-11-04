use super::*;
use crate::k8s::access::engine::evaluate;
use crate::k8s::access::fixtures::*;
use crate::k8s::access::rbac::{Binding, Rbac, Role, Subject};

fn eval(roles: Vec<Role>, bindings: Vec<Binding>, cluster_bindings: Vec<Binding>) -> Evaluation {
    evaluate(Rbac { roles: vec![], cluster_roles: roles, bindings, cluster_bindings }, vec![])
}

fn u(name: &str) -> Subject {
    Subject::user(name)
}

fn cap(namespace: Option<&str>, group: &str, resource: &str, verbs: &[&str]) -> Capability {
    Capability { namespace: namespace.map(str::to_string), group: group.into(), resource: resource.into(), verbs: verbs.iter().map(|v| v.to_string()).collect() }
}

fn pods_reader() -> Role {
    cluster_role("pods-reader", vec![rule(&["get", "list"], &[""], &["pods"])])
}

#[test]
fn nothing_changes_means_no_entries() {
    let a = eval(vec![pods_reader()], vec![], vec![clusterbinding("b", "pods-reader", vec![u("x")])]);
    let b = eval(vec![pods_reader()], vec![], vec![clusterbinding("b", "pods-reader", vec![u("x")])]);
    assert!(diff(&a, &b).is_empty());
}

#[test]
fn a_new_binding_gains_exactly_what_its_role_gives_in_its_scope() {
    let before = eval(vec![pods_reader()], vec![], vec![]);
    let after = eval(vec![pods_reader()], vec![rolebinding("dev", "b", cluster_ref("pods-reader"), vec![u("alice")])], vec![]);
    let d = diff(&before, &after);
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].subject, u("alice"));
    assert_eq!(d[0].gained, vec![cap(Some("dev"), "", "pods", &["get", "list"])]);
    assert!(d[0].lost.is_empty());
}

#[test]
fn removing_a_binding_loses_what_it_gave() {
    let before = eval(vec![pods_reader()], vec![], vec![clusterbinding("b", "pods-reader", vec![u("alice")])]);
    let after = eval(vec![pods_reader()], vec![], vec![]);
    let d = diff(&before, &after);
    assert_eq!(d[0].lost, vec![cap(None, "", "pods", &["get", "list"])]);
    assert!(d[0].gained.is_empty());
}

#[test]
fn only_the_changed_subject_is_listed_even_when_others_share_the_role() {
    let before = eval(vec![pods_reader()], vec![], vec![clusterbinding("b", "pods-reader", vec![u("alice"), u("bob")])]);
    let after = eval(vec![pods_reader()], vec![], vec![clusterbinding("b", "pods-reader", vec![u("alice")])]);
    let d = diff(&before, &after);
    assert_eq!(d.iter().map(|x| x.subject.clone()).collect::<Vec<_>>(), vec![u("bob")]);
}

#[test]
fn editing_a_role_changes_every_subject_bound_to_it() {
    let wider = cluster_role("pods-reader", vec![rule(&["get", "list", "delete"], &[""], &["pods"])]);
    let bound = |r: Role| eval(vec![r], vec![], vec![clusterbinding("b", "pods-reader", vec![u("a"), Subject::group("g")])]);
    let d = diff(&bound(pods_reader()), &bound(wider));
    assert_eq!(d.len(), 2);
    assert!(d.iter().all(|x| x.gained == vec![cap(None, "", "pods", &["delete"])]));
}

#[test]
fn a_wildcard_grant_is_reported_as_star_for_what_the_snapshots_do_not_name() {
    let before = eval(vec![pods_reader()], vec![], vec![clusterbinding("b", "pods-reader", vec![u("a")])]);
    let admin = cluster_role("admin-all", vec![rule(&["*"], &["*"], &["*"])]);
    let after = eval(vec![pods_reader(), admin], vec![], vec![clusterbinding("b", "pods-reader", vec![u("a")]), clusterbinding("c", "admin-all", vec![u("a")])]);
    let d = diff(&before, &after);
    let gained = &d[0].gained;
    assert!(gained.iter().any(|c| c.group == "*" && c.resource == "*" && c.verbs.contains(&"*".to_string()) && c.verbs.contains(&"delete".to_string())), "{gained:?}");
    // 이미 있던 get·list pods는 얻은 것이 아니다
    assert!(!gained.iter().any(|c| c.resource == "pods" && c.verbs.contains(&"get".to_string())));
}

#[test]
fn a_cluster_wide_grant_hides_the_namespace_entries_it_already_explains() {
    let before = eval(vec![pods_reader()], vec![rolebinding("dev", "rb", cluster_ref("pods-reader"), vec![u("a")])], vec![]);
    let after = eval(vec![pods_reader()], vec![rolebinding("dev", "rb", cluster_ref("pods-reader"), vec![u("a")])], vec![clusterbinding("cb", "pods-reader", vec![u("a")])]);
    let d = diff(&before, &after);
    assert_eq!(d[0].gained, vec![cap(None, "", "pods", &["get", "list"])]);
}

#[test]
fn moving_a_grant_between_roles_with_the_same_effect_changes_nothing() {
    let one = eval(vec![pods_reader()], vec![], vec![clusterbinding("b", "pods-reader", vec![u("a")])]);
    let renamed = cluster_role("pods-reader-2", vec![rule(&["get", "list"], &[""], &["pods"])]);
    let two = eval(vec![renamed], vec![], vec![clusterbinding("other", "pods-reader-2", vec![u("a")])]);
    assert!(diff(&one, &two).is_empty());
}

#[test]
fn subresources_and_non_resource_urls_are_diffed_too() {
    let exec = cluster_role("exec", vec![rule(&["create"], &[""], &["pods/exec"]), urls(&["get"], &["/metrics"])]);
    let before = eval(vec![exec.clone()], vec![], vec![]);
    let after = eval(vec![exec], vec![], vec![clusterbinding("b", "exec", vec![u("a")])]);
    let d = diff(&before, &after);
    assert_eq!(d[0].gained, vec![cap(None, "", "pods/exec", &["create"])]);
    assert_eq!(d[0].gained_urls, vec![UrlCapability { url: "/metrics".into(), verbs: vec!["get".into()] }]);
}

#[test]
fn a_subject_that_exists_only_after_is_all_gain_and_only_before_is_all_loss() {
    let none = eval(vec![pods_reader()], vec![], vec![]);
    let some = eval(vec![pods_reader()], vec![], vec![clusterbinding("b", "pods-reader", vec![u("new")])]);
    assert_eq!(diff(&none, &some)[0].gained.len(), 1);
    assert_eq!(diff(&some, &none)[0].lost.len(), 1);
}
