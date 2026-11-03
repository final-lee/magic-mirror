use super::*;

const ACCOUNT: &str = "111122223333";

fn role(path_and_name: &str) -> String {
    format!("arn:aws:iam::{ACCOUNT}:role/{path_and_name}")
}

fn entry(arn: &str, username: Option<&str>, groups: &[&str], policies: Vec<(String, PolicyScope)>) -> EntryInput {
    EntryInput {
        principal_arn: arn.to_string(),
        entry_type: Some("STANDARD".into()),
        username: username.map(str::to_string),
        groups: groups.iter().map(|g| g.to_string()).collect(),
        policies,
        read_error: None,
    }
}

fn view_policy() -> (String, PolicyScope) {
    ("arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy".to_string(), PolicyScope::Cluster)
}

fn auth(roles: &str, users: &str) -> AwsAuth {
    let mut data = BTreeMap::new();
    data.insert("mapRoles".to_string(), roles.to_string());
    data.insert("mapUsers".to_string(), users.to_string());
    parse_aws_auth(&data)
}

// ── access policy 대응표 ──

#[test]
fn the_four_access_policies_map_to_their_cluster_roles_and_the_rest_to_nothing() {
    let arn = |n: &str| format!("arn:aws:eks::aws:cluster-access-policy/{n}");
    assert_eq!(policy_role(&arn("AmazonEKSClusterAdminPolicy")), Some("cluster-admin"));
    assert_eq!(policy_role(&arn("AmazonEKSAdminPolicy")), Some("admin"));
    assert_eq!(policy_role(&arn("AmazonEKSEditPolicy")), Some("edit"));
    assert_eq!(policy_role(&arn("AmazonEKSViewPolicy")), Some("view"));
    assert_eq!(policy_role(&arn("AmazonEKSAdminViewPolicy")), None);
    assert_eq!(policy_role(&arn("AmazonEKSAutoNodePolicy")), None);
    assert_eq!(policy_name(&arn("AmazonEKSViewPolicy")), "AmazonEKSViewPolicy");
}

// ── aws-auth ──

#[test]
fn aws_auth_roles_users_and_templates_are_read() {
    let a = auth(
        "- rolearn: arn:aws:iam::111122223333:role/ops\n  username: ops:{{SessionName}}\n  groups:\n    - system:masters\n    - ops\n- rolearn: arn:aws:iam::111122223333:role/NodeRole\n  username: system:node:{{EC2PrivateDNSName}}\n  groups: [system:bootstrappers, system:nodes]\n",
        "- userarn: arn:aws:iam::111122223333:user/alice\n  username: alice\n  groups: [devs]\n",
    );
    assert!(a.errors.is_empty(), "{:?}", a.errors);
    assert_eq!(a.roles.len(), 2);
    assert_eq!(a.roles[0], AwsAuthEntry { arn: role("ops"), username: Some("ops:{{SessionName}}".into()), groups: vec!["system:masters".into(), "ops".into()] });
    assert_eq!(a.roles[1].groups, vec!["system:bootstrappers".to_string(), "system:nodes".to_string()]);
    assert_eq!(a.users[0].arn, "arn:aws:iam::111122223333:user/alice");
}

#[test]
fn a_broken_aws_auth_key_is_reported_and_the_other_keys_still_work() {
    let a = auth("this: is: not: [a list", "- userarn: arn:aws:iam::111122223333:user/bob\n  username: bob\n");
    assert_eq!(a.errors.len(), 1);
    assert!(a.errors[0].contains("mapRoles"));
    assert_eq!(a.users.len(), 1);
}

#[test]
fn empty_aws_auth_values_and_map_accounts_are_handled() {
    let mut data = BTreeMap::new();
    data.insert("mapRoles".to_string(), "".to_string());
    data.insert("mapUsers".to_string(), "[]".to_string());
    data.insert("mapAccounts".to_string(), "- \"111122223333\"\n".to_string());
    let a = parse_aws_auth(&data);
    assert!(a.roles.is_empty() && a.users.is_empty() && a.errors.is_empty());
    assert_eq!(a.accounts, vec!["111122223333".to_string()]);
    assert_eq!(parse_aws_auth(&BTreeMap::new()), AwsAuth::default());
}

// ── 인증 모드 ──

#[test]
fn the_authentication_mode_decides_which_source_is_effective() {
    assert_eq!(parse_mode(Some("API")), AuthMode::Api);
    assert_eq!(parse_mode(Some("CONFIG_MAP")), AuthMode::ConfigMap);
    assert_eq!(parse_mode(Some("API_AND_CONFIG_MAP")), AuthMode::ApiAndConfigMap);
    // access 설정이 없던 옛 클러스터는 aws-auth만 쓴다
    assert_eq!(parse_mode(None), AuthMode::ConfigMap);
    assert_eq!(parse_mode(Some("SOMETHING_NEW")), AuthMode::ApiAndConfigMap);
}

fn sample() -> (Vec<EntryInput>, AwsAuth) {
    (
        vec![entry(&role("aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_0123456789abcdef"), Some("sso-admin:{{SessionName}}"), &["admins"], vec![view_policy()])],
        auth("- rolearn: arn:aws:iam::111122223333:role/AWSReservedSSO_Admin_0123456789abcdef\n  username: old\n  groups: [old]\n- rolearn: arn:aws:iam::111122223333:role/legacy\n  groups: [legacy]\n", ""),
    )
}

#[test]
fn api_mode_uses_only_access_entries() {
    let (entries, aws) = sample();
    let m = resolve(AuthMode::Api, &entries, Some(&aws));
    let effective: Vec<(MappingSource, bool)> = m.iter().map(|x| (x.source, x.effective)).collect();
    assert_eq!(effective, vec![(MappingSource::AccessEntry, true), (MappingSource::AwsAuth, false), (MappingSource::AwsAuth, false)]);
    assert_eq!(m[1].inactive_reason.as_deref(), Some(NOT_USED_API));
}

#[test]
fn config_map_mode_uses_only_aws_auth() {
    let (entries, aws) = sample();
    let m = resolve(AuthMode::ConfigMap, &entries, Some(&aws));
    assert!(!m[0].effective);
    assert_eq!(m[0].inactive_reason.as_deref(), Some(NOT_USED_CONFIG_MAP));
    assert!(m[1].effective && m[2].effective);
}

#[test]
fn both_mode_prefers_the_access_entry_for_the_same_principal_even_when_the_path_differs() {
    let (entries, aws) = sample();
    let m = resolve(AuthMode::ApiAndConfigMap, &entries, Some(&aws));
    // aws-auth는 경로 없이 쓰고 access entry는 경로를 포함한다
    assert!(m[0].effective);
    assert!(!m[1].effective);
    assert_eq!(m[1].inactive_reason.as_deref(), Some(SHADOWED));
    // 겹치지 않는 aws-auth 항목은 그대로 쓴다
    assert!(m[2].effective);
    assert_eq!(m[2].username, role("legacy"), "이름을 비우면 ARN");
}

#[test]
fn only_effective_mappings_become_principals_and_an_unreadable_entry_is_left_out_with_its_reason() {
    let mut broken = entry(&role("broken"), None, &[], vec![]);
    broken.read_error = Some("권한 없음 (eks:DescribeAccessEntry)".into());
    let (mut entries, aws) = sample();
    entries.push(broken);
    let m = resolve(AuthMode::ApiAndConfigMap, &entries, Some(&aws));
    let p = principals(&m);
    assert_eq!(p.iter().map(|x| x.arn.as_str()).collect::<Vec<_>>(), vec![entries[0].principal_arn.as_str(), role("legacy").as_str()]);
    let bad = m.iter().find(|x| x.principal_arn == role("broken")).unwrap();
    assert!(!bad.effective && bad.inactive_reason.as_deref().unwrap().contains("DescribeAccessEntry"));
    assert_eq!(p[0].policies.len(), 1);
}

#[test]
fn account_id_templates_are_filled_and_session_templates_stay() {
    let a = auth("- rolearn: arn:aws:iam::111122223333:role/x\n  username: \"{{AccountID}}:{{SessionName}}\"\n", "");
    let m = resolve(AuthMode::ConfigMap, &[], Some(&a));
    assert_eq!(m[0].username, "111122223333:{{SessionName}}");
}

// ── SSO ──

#[test]
fn sso_roles_are_grouped_by_permission_set_name_with_the_hash_stripped() {
    assert_eq!(permission_set(&role("aws-reserved/sso.amazonaws.com/ap-northeast-2/AWSReservedSSO_PowerUser_0123456789abcdef")), Some("PowerUser".into()));
    // 권한 세트 이름에 밑줄이 있어도 해시는 마지막 조각이다
    assert_eq!(permission_set(&role("AWSReservedSSO_Read_Only_aaaabbbbccccdddd")), Some("Read_Only".into()));
    assert_eq!(permission_set(&role("AWSReservedSSO_nohash")), None);
    assert_eq!(permission_set(&role("deploy")), None);
    assert_eq!(permission_set("arn:aws:iam::111122223333:user/AWSReservedSSO_Admin_1"), None);

    let entries = vec![
        entry(&role("aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_aaaaaaaaaaaaaaaa"), None, &[], vec![]),
        entry(&role("aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_bbbbbbbbbbbbbbbb"), None, &[], vec![]),
        entry(&role("AWSReservedSSO_Dev_cccccccccccccccc"), None, &[], vec![]),
        entry(&role("plain"), None, &[], vec![]),
    ];
    let groups = sso_groups(&resolve(AuthMode::Api, &entries, None));
    assert_eq!(groups.iter().map(|g| (g.permission_set.as_str(), g.principals.len())).collect::<Vec<_>>(), vec![("Admin", 2), ("Dev", 1)]);
    let m = resolve(AuthMode::Api, &entries, None);
    assert_eq!(m[0].label, "Admin");
    assert_eq!(m[3].label, "plain");
}

#[test]
fn arns_are_split_without_their_path() {
    assert_eq!(parse_arn(&role("a/b/c")), Some((ACCOUNT.into(), PrincipalKind::Role, "c".into())));
    assert_eq!(parse_arn("arn:aws:iam::111122223333:user/alice"), Some((ACCOUNT.into(), PrincipalKind::User, "alice".into())));
    assert_eq!(parse_arn("arn:aws:iam::111122223333:root"), None);
    assert_eq!(parse_arn("nonsense"), None);
}
