use super::*;
use crate::k8s::access::engine::evaluate;
use crate::k8s::access::fixtures::*;
use crate::k8s::access::rbac::{Rbac, Subject};

fn eval(roles: Vec<crate::k8s::access::rbac::Role>, bindings: Vec<crate::k8s::access::rbac::Binding>, cluster_bindings: Vec<crate::k8s::access::rbac::Binding>) -> Evaluation {
    evaluate(rbac_with(vec![], roles, bindings, cluster_bindings), vec![])
}

fn u(name: &str) -> Subject {
    Subject::user(name)
}

fn row(e: &Evaluation, s: &Subject, ns: Option<&str>) -> Vec<u8> {
    levels(&e.rules_of(s).grants, ns)
}

const FULL: u8 = 2;
const SOME: u8 = 1;
const NONE: u8 = 0;

#[test]
fn view_reads_everything_ordinary_but_not_secrets_and_writes_nothing() {
    let e = eval(vec![], vec![rolebinding("dev", "b", cluster_ref("view"), vec![u("v")])], vec![]);
    // 읽기, 쓰기, 삭제, exec, Secret, RBAC, 권한 상승
    assert_eq!(row(&e, &u("v"), Some("dev")), vec![FULL, NONE, NONE, NONE, NONE, NONE, NONE]);
    assert_eq!(row(&e, &u("v"), Some("prod")), vec![NONE; 7]);
    assert_eq!(row(&e, &u("v"), None), vec![NONE; 7], "클러스터 전체 열은 ClusterRoleBinding만 본다");
}

#[test]
fn edit_adds_writes_deletes_exec_and_secret_reads_and_pod_creation_is_an_indirect_escalation() {
    let e = eval(vec![], vec![rolebinding("dev", "b", cluster_ref("edit"), vec![u("ed")])], vec![]);
    assert_eq!(row(&e, &u("ed"), Some("dev")), vec![FULL, FULL, FULL, FULL, FULL, NONE, SOME]);
}

#[test]
fn admin_also_changes_rbac_but_without_escalate_or_bind_it_is_only_an_indirect_escalation() {
    let e = eval(vec![], vec![rolebinding("dev", "b", cluster_ref("admin"), vec![u("ad")])], vec![]);
    let cells = row(&e, &u("ad"), Some("dev"));
    assert_eq!(cells[5], FULL);
    assert_eq!(cells[6], SOME);
}

#[test]
fn cluster_admin_is_full_in_every_cell_in_every_column() {
    let e = eval(vec![], vec![], vec![clusterbinding("b", "cluster-admin", vec![u("root")])]);
    assert_eq!(row(&e, &u("root"), Some("any")), vec![FULL; 7]);
    assert_eq!(row(&e, &u("root"), None), vec![FULL; 7]);
}

#[test]
fn a_partial_grant_is_partial_not_full() {
    let r = cluster_role("pods-only", vec![rule(&["get", "list"], &[""], &["pods"])]);
    let e = evaluate(rbac_with(vec![r], vec![], vec![], vec![clusterbinding("b", "pods-only", vec![u("p")])]), vec![]);
    assert_eq!(row(&e, &u("p"), Some("n"))[0], SOME);
    assert_eq!(row(&e, &u("p"), Some("n"))[1], NONE);
}

#[test]
fn secrets_limited_by_resource_names_are_partial() {
    let r = cluster_role("one-secret", vec![named(rule(&["get"], &[""], &["secrets"]), &["db"])]);
    let e = evaluate(rbac_with(vec![r], vec![], vec![], vec![clusterbinding("b", "one-secret", vec![u("s")])]), vec![]);
    assert_eq!(row(&e, &u("s"), Some("n"))[4], SOME);
}

#[test]
fn exec_needs_all_three_for_full_and_any_for_partial() {
    let r = cluster_role("exec-only", vec![rule(&["create"], &[""], &["pods/exec"])]);
    let e = evaluate(rbac_with(vec![r], vec![], vec![], vec![clusterbinding("b", "exec-only", vec![u("x")])]), vec![]);
    assert_eq!(row(&e, &u("x"), Some("n"))[3], SOME);
}

#[test]
fn bind_escalate_impersonate_and_token_creation_are_direct_escalations() {
    for (verbs, group, resource, sub) in [
        (&["escalate"][..], "rbac.authorization.k8s.io", "clusterroles", None),
        (&["bind"][..], "rbac.authorization.k8s.io", "roles", None),
        (&["impersonate"][..], "", "users", None),
        (&["create"][..], "", "serviceaccounts", Some("token")),
        (&["get"][..], "", "nodes", Some("proxy")),
    ] {
        let resource_name = match sub {
            Some(s) => format!("{resource}/{s}"),
            None => resource.to_string(),
        };
        let r = cluster_role("esc", vec![rule(verbs, &[group], &[&resource_name])]);
        let e = evaluate(rbac_with(vec![r], vec![], vec![], vec![clusterbinding("b", "esc", vec![u("e")])]), vec![]);
        assert_eq!(row(&e, &u("e"), Some("n"))[6], FULL, "{verbs:?} {resource_name}");
    }
}

#[test]
fn cluster_scoped_escalation_through_a_role_binding_does_not_count() {
    // Role로는 clusterroles를 다룰 수 없다: 네임스페이스에 준 bind는 이 열에서 Full이 아니다
    let r = role("n", "r", vec![rule(&["bind"], &["rbac.authorization.k8s.io"], &["clusterroles"])]);
    let e = eval(vec![r], vec![rolebinding("n", "b", role_ref("r"), vec![u("e")])], vec![]);
    assert_eq!(row(&e, &u("e"), Some("n"))[6], NONE);
}

#[test]
fn rbac_changes_in_the_cluster_column_include_cluster_roles() {
    let r = cluster_role("rbac", vec![rule(&["create", "update", "patch", "delete"], &["rbac.authorization.k8s.io"], &["roles", "rolebindings"])]);
    let e = evaluate(rbac_with(vec![r], vec![], vec![], vec![clusterbinding("b", "rbac", vec![u("r")])]), vec![]);
    assert_eq!(row(&e, &u("r"), Some("n"))[5], FULL);
    // 클러스터 열은 clusterroles·clusterrolebindings도 필요하다
    assert_eq!(row(&e, &u("r"), None)[5], SOME);
}

#[test]
fn cell_detail_lists_every_probe_with_its_paths_and_flags_name_only_grants() {
    let r = cluster_role("one-secret", vec![named(rule(&["get"], &[""], &["secrets"]), &["db"])]);
    let e = evaluate(rbac_with(vec![r], vec![], vec![], vec![clusterbinding("b", "one-secret", vec![u("s")])]), vec![]);
    let d = cell_detail(&e, &u("s"), Cell::SecretRead, Some("n"));
    assert_eq!(d.level, SOME);
    assert_eq!(d.probes.len(), 3);
    let get = d.probes.iter().find(|p| p.query.verb == "get").unwrap();
    assert!(!get.allowed && get.names_only);
    assert_eq!(get.grants[0].source.binding.as_ref().unwrap().name, "b");
    assert!(d.probes.iter().filter(|p| p.query.verb != "get").all(|p| p.grants.is_empty() && !p.names_only));
}

#[test]
fn cell_detail_shows_where_a_full_cell_comes_from() {
    let e = eval(vec![], vec![rolebinding("dev", "dev-edit", cluster_ref("edit"), vec![u("ed")])], vec![]);
    let d = cell_detail(&e, &u("ed"), Cell::Write, Some("dev"));
    assert_eq!(d.level, FULL);
    assert!(d.probes.iter().all(|p| p.allowed && p.grants.iter().all(|g| g.source.binding.as_ref().unwrap().name == "dev-edit")));
}

fn many() -> Evaluation {
    let bindings: Vec<_> = (0..30).map(|i| clusterbinding(&format!("b{i}"), "view", vec![u(&format!("user-{i:02}"))])).collect();
    evaluate(rbac_with(vec![], vec![], vec![rolebinding("ns", "sa", cluster_ref("edit"), vec![Subject::service_account("ns", "robot")])], bindings), vec![])
}

#[test]
fn a_page_filters_by_kind_and_text_sorts_and_computes_cells_only_for_its_rows() {
    let e = many();
    let page = matrix_page(&e, &MatrixQuery { kinds: vec![SubjectKind::User], text: String::new(), namespaces: vec![None, Some("ns".into())], offset: 10, limit: 5 });
    assert_eq!(page.total, 30);
    let names: Vec<&str> = page.rows.iter().map(|r| r.subject.name.as_str()).collect();
    assert_eq!(names, vec!["user-10", "user-11", "user-12", "user-13", "user-14"]);
    // 열마다 일곱 칸
    assert_eq!(page.rows[0].levels.len(), 2);
    assert_eq!(page.rows[0].levels[0].len(), 7);
    assert_eq!(page.rows[0].levels[0][0], FULL);

    let found = matrix_page(&e, &MatrixQuery { kinds: vec![], text: " ROBOT ".into(), namespaces: vec![Some("ns".into())], offset: 0, limit: 10 });
    assert_eq!(found.total, 1);
    assert_eq!(found.rows[0].subject, Subject::service_account("ns", "robot"));
    assert_eq!(found.rows[0].levels[0][1], FULL);
}

#[test]
fn builtin_system_subjects_sort_after_the_rest() {
    let e = evaluate(rbac_with(vec![], vec![], vec![], vec![clusterbinding("a", "view", vec![u("system:kube-scheduler"), u("zed"), Subject::group("system:masters")])]), vec![]);
    let page = matrix_page(&e, &MatrixQuery { kinds: vec![], text: String::new(), namespaces: vec![None], offset: 0, limit: 10 });
    let names: Vec<&str> = page.rows.iter().map(|r| r.subject.name.as_str()).collect();
    assert_eq!(names, vec!["zed", "system:kube-scheduler", "system:masters"]);
}

#[test]
fn an_empty_cluster_gives_an_empty_page() {
    let e = evaluate(Rbac::default(), vec![]);
    let page = matrix_page(&e, &MatrixQuery { namespaces: vec![None], limit: 10, ..MatrixQuery::default() });
    assert_eq!((page.total, page.rows.len()), (0, 0));
}
