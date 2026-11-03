use super::*;
use crate::k8s::rbac::tests::{entry_change, ARN};

const VIEW: &str = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy";
const EDIT: &str = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy";
const ADMIN: &str = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy";
const CLUSTER: &str = "prod-cluster";

fn dev_scope() -> PolicyScope {
    PolicyScope::Namespaces { namespaces: vec!["dev".into()] }
}

fn entry(arn: &str, groups: &[&str], policies: Vec<(&str, PolicyScope)>) -> EntryInput {
    EntryInput {
        principal_arn: arn.into(),
        entry_type: Some("STANDARD".into()),
        username: default_username(arn),
        groups: groups.iter().map(|g| g.to_string()).collect(),
        policies: policies.into_iter().map(|(arn, scope)| (arn.to_string(), scope)).collect(),
        read_error: None,
    }
}

fn changed(operation: Operation, entries: &[EntryInput]) -> Result<(Plan, Vec<EntryInput>), AppError> {
    plan_entry(&entry_change(ARN, operation), CLUSTER, entries, AuthMode::ApiAndConfigMap)
}

fn create(groups: &[&str], policies: Vec<PolicySpec>) -> Operation {
    Operation::AccessEntryCreate { username: None, groups: groups.iter().map(|g| g.to_string()).collect(), policies, entry_type: None }
}

fn view_in(ns: &str) -> PolicySpec {
    PolicySpec { policy_arn: VIEW.into(), scope: ScopeSpec::Namespaces { namespaces: vec![ns.into()] } }
}

#[test]
fn creating_an_entry_creates_it_then_associates_each_policy_and_undoes_by_deleting_it() {
    let (plan, next) = changed(create(&[" devs ", "devs", "qa"], vec![view_in("dev"), PolicySpec { policy_arn: EDIT.into(), scope: ScopeSpec::Cluster }]), &[]).unwrap();
    let calls: Vec<(&str, &str)> = plan.preview.calls.iter().map(|c| (c.verb.as_str(), c.path.as_str())).collect();
    assert_eq!(
        calls,
        vec![
            ("POST", "/clusters/prod-cluster/access-entries"),
            ("POST", "/clusters/prod-cluster/access-entries/arn:aws:iam::111122223333:role/dev/access-policies"),
            ("POST", "/clusters/prod-cluster/access-entries/arn:aws:iam::111122223333:role/dev/access-policies"),
        ]
    );
    assert_eq!(plan.preview.calls[0].body, json!({"principalArn": ARN, "kubernetesGroups": ["devs", "qa"]}));
    assert_eq!(plan.preview.calls[1].body, json!({"policyArn": VIEW, "accessScope": {"type": "namespace", "namespaces": ["dev"]}}));
    assert_eq!(plan.preview.calls[2].body["accessScope"], json!({"type": "cluster"}));
    assert_eq!(plan.inverse, Some(entry_change(ARN, Operation::AccessEntryDelete)));
    // 다음 상태: 새 항목이 정책과 함께 들어가 엔진이 그대로 쓸 수 있다
    assert_eq!(next.len(), 1);
    assert_eq!((next[0].groups.clone(), next[0].policies.len()), (vec!["devs".to_string(), "qa".to_string()], 2));
    assert_eq!(next[0].username.as_deref(), Some("arn:aws:sts::111122223333:assumed-role/dev/{{SessionName}}"));
}

#[test]
fn creating_validates_the_principal_groups_and_policies() {
    assert_eq!(plan_entry(&entry_change("dev", create(&[], vec![])), CLUSTER, &[], AuthMode::Api).unwrap_err(), AppError::other(INVALID_PRINCIPAL));
    assert_eq!(changed(create(&["  "], vec![]), &[]).unwrap_err(), AppError::other(INVALID_GROUP));
    assert_eq!(changed(create(&[], vec![PolicySpec { policy_arn: "AmazonEKSViewPolicy".into(), scope: ScopeSpec::Cluster }]), &[]).unwrap_err(), AppError::other(INVALID_POLICY));
    assert_eq!(changed(create(&[], vec![PolicySpec { policy_arn: VIEW.into(), scope: ScopeSpec::Namespaces { namespaces: vec![] } }]), &[]).unwrap_err(), AppError::other(INVALID_SCOPE));
    assert_eq!(changed(create(&[], vec![view_in("a"), view_in("b")]), &[]).unwrap_err(), AppError::other(DUPLICATE_POLICY));
    // 이미 있는 주체
    assert_eq!(changed(create(&[], vec![]), &[entry(ARN, &[], vec![])]).unwrap_err(), AppError::other(ENTRY_EXISTS));
}

#[test]
fn a_config_map_cluster_has_no_access_entries_to_change() {
    let c = entry_change(ARN, create(&[], vec![]));
    assert_eq!(plan_entry(&c, CLUSTER, &[], AuthMode::ConfigMap).unwrap_err(), AppError::other(MODE_CONFIG_MAP));
}

#[test]
fn a_change_for_a_target_that_is_not_an_access_entry_is_invalid() {
    let mut c = entry_change(ARN, Operation::AccessEntryDelete);
    c.target.kind.kind = "Pod".into();
    assert_eq!(plan_entry(&c, CLUSTER, &[], AuthMode::Api).unwrap_err(), AppError::other(INVALID_CHANGE));
    assert_eq!(changed(Operation::Restart, &[]).unwrap_err(), AppError::other(INVALID_CHANGE));
}

#[test]
fn creating_with_a_system_group_warns_and_a_node_type_cannot_take_policies() {
    let (plan, _) = changed(create(&["system:masters"], vec![]), &[]).unwrap();
    assert!(plan.preview.warnings.contains(&SYSTEM_GROUP_WARNING.to_string()));
    let node = Operation::AccessEntryCreate { username: None, groups: vec![], policies: vec![view_in("dev")], entry_type: Some("EC2_LINUX".into()) };
    assert_eq!(changed(node, &[]).unwrap_err(), AppError::other(NOT_STANDARD));
}

#[test]
fn every_eks_preview_says_there_is_no_dry_run() {
    let (plan, _) = changed(create(&[], vec![]), &[]).unwrap();
    assert!(plan.preview.warnings.contains(&NO_DRY_RUN_WARNING.to_string()));
}

#[test]
fn deleting_an_entry_recreates_it_with_its_groups_and_policies_on_undo() {
    let original = entry(ARN, &["devs"], vec![(VIEW, dev_scope()), (EDIT, PolicyScope::Cluster)]);
    let (plan, next) = changed(Operation::AccessEntryDelete, &[original, entry("arn:aws:iam::111122223333:role/ops", &[], vec![])]).unwrap();
    assert_eq!((plan.preview.calls[0].verb.as_str(), plan.preview.calls[0].path.as_str()), ("DELETE", "/clusters/prod-cluster/access-entries/arn:aws:iam::111122223333:role/dev"));
    let undo = plan.inverse.unwrap();
    assert_eq!(
        undo.operation,
        Operation::AccessEntryCreate {
            // 기본 사용자 이름과 STANDARD 종류는 EKS가 채우니 보내지 않는다
            username: None,
            groups: vec!["devs".into()],
            policies: vec![view_in("dev"), PolicySpec { policy_arn: EDIT.into(), scope: ScopeSpec::Cluster }],
            entry_type: None,
        }
    );
    assert_eq!(undo.target.name, ARN);
    assert!(plan.preview.warnings.contains(&POLICIES_GONE_WARNING.to_string()));
    assert_eq!(next.iter().map(|e| e.principal_arn.as_str()).collect::<Vec<_>>(), vec!["arn:aws:iam::111122223333:role/ops"]);
}

#[test]
fn a_custom_username_is_kept_when_recreating() {
    let mut custom = entry(ARN, &[], vec![]);
    custom.username = Some("dev-team".into());
    let (plan, _) = changed(Operation::AccessEntryDelete, &[custom]).unwrap();
    assert!(matches!(plan.inverse.unwrap().operation, Operation::AccessEntryCreate { username: Some(name), .. } if name == "dev-team"));
}

#[test]
fn deleting_a_node_role_entry_warns_and_is_recreated_with_its_type_only() {
    let mut node = entry(ARN, &[], vec![]);
    node.entry_type = Some("EC2_LINUX".into());
    node.username = Some("system:node:{{EC2PrivateDNSName}}".into());
    node.groups = vec!["system:nodes".into()];
    let (plan, _) = changed(Operation::AccessEntryDelete, &[node]).unwrap();
    assert!(plan.preview.warnings.contains(&NODE_ENTRY_WARNING.to_string()));
    let Operation::AccessEntryCreate { username, entry_type, .. } = plan.inverse.unwrap().operation else { panic!() };
    assert_eq!((username, entry_type.as_deref()), (None, Some("EC2_LINUX")));
}

#[test]
fn an_entry_that_is_missing_or_could_not_be_read_cannot_be_changed() {
    assert_eq!(changed(Operation::AccessEntryDelete, &[]).unwrap_err(), AppError::other(ENTRY_MISSING));
    let mut broken = entry(ARN, &[], vec![]);
    broken.read_error = Some("denied".into());
    for op in [Operation::AccessEntryDelete, Operation::AccessEntryGroups { groups: vec![] }, Operation::AccessPolicyDisassociate { policy_arn: VIEW.into() }] {
        assert_eq!(changed(op, std::slice::from_ref(&broken)).unwrap_err(), AppError::other(ENTRY_UNREADABLE));
    }
}

#[test]
fn changing_groups_replaces_the_list_and_undo_restores_the_old_one() {
    let (plan, next) = changed(Operation::AccessEntryGroups { groups: vec!["qa".into(), "system:masters".into()] }, &[entry(ARN, &["devs"], vec![])]).unwrap();
    assert_eq!((plan.preview.calls[0].verb.as_str(), plan.preview.calls[0].path.as_str()), ("POST", "/clusters/prod-cluster/access-entries/arn:aws:iam::111122223333:role/dev"));
    assert_eq!(plan.preview.calls[0].body, json!({"kubernetesGroups": ["qa", "system:masters"]}));
    assert_eq!((plan.preview.diff[0].before.clone(), plan.preview.diff[0].after.clone()), (json!(["devs"]), json!(["qa", "system:masters"])));
    assert_eq!(plan.inverse, Some(entry_change(ARN, Operation::AccessEntryGroups { groups: vec!["devs".into()] })));
    assert!(plan.preview.warnings.contains(&SYSTEM_GROUP_WARNING.to_string()));
    assert_eq!(next[0].groups, vec!["qa".to_string(), "system:masters".to_string()]);
}

#[test]
fn keeping_an_existing_system_group_does_not_warn_and_unchanged_groups_do_nothing() {
    let current = entry(ARN, &["system:masters"], vec![]);
    let (plan, _) = changed(Operation::AccessEntryGroups { groups: vec!["system:masters".into(), "qa".into()] }, std::slice::from_ref(&current)).unwrap();
    assert!(!plan.preview.warnings.contains(&SYSTEM_GROUP_WARNING.to_string()));
    let (same, _) = changed(Operation::AccessEntryGroups { groups: vec!["system:masters".into()] }, &[current]).unwrap();
    assert!(same.preview.diff.is_empty() && same.inverse.is_none());
    assert!(same.preview.warnings.contains(&NOOP_WARNING.to_string()));
}

#[test]
fn associating_a_new_policy_undoes_by_disassociating_and_changing_a_scope_undoes_to_the_old_scope() {
    let associate = |scope| Operation::AccessPolicyAssociate { policy_arn: VIEW.into(), scope };
    let (fresh, next) = changed(associate(ScopeSpec::Cluster), &[entry(ARN, &[], vec![])]).unwrap();
    assert_eq!(fresh.preview.calls[0].path, "/clusters/prod-cluster/access-entries/arn:aws:iam::111122223333:role/dev/access-policies");
    assert_eq!(fresh.preview.calls[0].body, json!({"policyArn": VIEW, "accessScope": {"type": "cluster"}}));
    assert_eq!(fresh.inverse, Some(entry_change(ARN, Operation::AccessPolicyDisassociate { policy_arn: VIEW.into() })));
    assert_eq!(next[0].policies, vec![(VIEW.to_string(), PolicyScope::Cluster)]);
    let (moved, next) = changed(associate(ScopeSpec::Cluster), &[entry(ARN, &[], vec![(VIEW, dev_scope())])]).unwrap();
    assert_eq!(moved.inverse, Some(entry_change(ARN, associate(ScopeSpec::Namespaces { namespaces: vec!["dev".into()] }))));
    assert_eq!(next[0].policies, vec![(VIEW.to_string(), PolicyScope::Cluster)]);
    let (same, _) = changed(associate(ScopeSpec::Namespaces { namespaces: vec!["dev".into()] }), &[entry(ARN, &[], vec![(VIEW, dev_scope())])]).unwrap();
    assert!(same.inverse.is_none() && same.preview.warnings.contains(&NOOP_WARNING.to_string()));
}

#[test]
fn only_standard_entries_take_policies_and_the_policy_arn_and_scope_are_checked() {
    let mut node = entry(ARN, &[], vec![]);
    node.entry_type = Some("FARGATE_LINUX".into());
    let associate = |policy: &str, scope| Operation::AccessPolicyAssociate { policy_arn: policy.into(), scope };
    assert_eq!(changed(associate(VIEW, ScopeSpec::Cluster), &[node]).unwrap_err(), AppError::other(NOT_STANDARD));
    let standard = [entry(ARN, &[], vec![])];
    assert_eq!(changed(associate("nope", ScopeSpec::Cluster), &standard).unwrap_err(), AppError::other(INVALID_POLICY));
    assert_eq!(changed(associate(VIEW, ScopeSpec::Namespaces { namespaces: vec![] }), &standard).unwrap_err(), AppError::other(INVALID_SCOPE));
}

#[test]
fn disassociating_deletes_the_association_and_undo_reassociates_it_with_the_old_scope() {
    let (plan, next) = changed(Operation::AccessPolicyDisassociate { policy_arn: VIEW.into() }, &[entry(ARN, &[], vec![(VIEW, dev_scope()), (EDIT, PolicyScope::Cluster)])]).unwrap();
    assert_eq!(plan.preview.calls[0].verb, "DELETE");
    assert_eq!(plan.preview.calls[0].path, format!("/clusters/prod-cluster/access-entries/arn:aws:iam::111122223333:role/dev/access-policies/{VIEW}"));
    assert_eq!(plan.inverse, Some(entry_change(ARN, Operation::AccessPolicyAssociate { policy_arn: VIEW.into(), scope: ScopeSpec::Namespaces { namespaces: vec!["dev".into()] } })));
    assert_eq!(next[0].policies, vec![(EDIT.to_string(), PolicyScope::Cluster)]);
    assert_eq!(changed(Operation::AccessPolicyDisassociate { policy_arn: ADMIN.into() }, &[entry(ARN, &[], vec![])]).unwrap_err(), AppError::other(NOT_ASSOCIATED));
}

#[test]
fn default_usernames_follow_what_eks_generates() {
    assert_eq!(default_username(ARN).as_deref(), Some("arn:aws:sts::111122223333:assumed-role/dev/{{SessionName}}"));
    // 경로가 있는 역할도 `assumed-role`에는 경로가 없다
    assert_eq!(
        default_username("arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_0123").as_deref(),
        Some("arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_Admin_0123/{{SessionName}}")
    );
    assert_eq!(default_username("arn:aws:iam::111122223333:user/bob").as_deref(), Some("arn:aws:iam::111122223333:user/bob"));
    assert_eq!(default_username("not an arn"), None);
}

#[test]
fn the_cluster_admin_policy_is_recognised_by_name_in_any_partition() {
    assert!(is_cluster_admin_policy(ADMIN));
    assert!(is_cluster_admin_policy("arn:aws-us-gov:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"));
    assert!(!is_cluster_admin_policy("arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy"));
}

#[test]
fn group_names_are_trimmed_deduplicated_and_never_blank() {
    assert_eq!(clean_groups(&[" a ".into(), "a".into(), "b".into()]).unwrap(), vec!["a".to_string(), "b".to_string()]);
    assert!(clean_groups(&["a".into(), "".into()]).is_err());
}
