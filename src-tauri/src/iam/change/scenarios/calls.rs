//! 변경마다 부르는 IAM API와 인자.

use super::*;

fn call_of(api: &str, params: &[(&str, &str)]) -> ApiCall {
    ApiCall { api: api.to_string(), params: map(params) }
}

#[test]
fn attaching_and_detaching_use_the_api_of_the_targets_kind() {
    let s = snapshot();
    let targets = [(BOB, "User", "UserName", "bob"), (ADMINS, "Group", "GroupName", "admins"), (DEPLOY, "Role", "RoleName", "deploy")];
    for (target, kind, name_key, name) in targets {
        assert_eq!(
            calls(&s, &attach(target, S3_FULL)),
            vec![call_of(&format!("iam:Attach{kind}Policy"), &[(name_key, name), ("PolicyArn", S3_FULL)])],
            "{target}"
        );
        assert_eq!(
            calls(&s, &detach(target, S3_FULL)),
            vec![call_of(&format!("iam:Detach{kind}Policy"), &[(name_key, name), ("PolicyArn", S3_FULL)])],
            "{target}"
        );
    }
}

#[test]
fn the_name_is_the_short_name_even_for_principals_with_a_path() {
    let mut s = snapshot();
    let mut dev = user("dev");
    dev.arn = account_arn("user/team/dev");
    dev.path = "/team/".into();
    let arn = dev.arn.clone();
    s.users.push(dev);
    assert_eq!(calls(&s, &attach(&arn, S3_FULL))[0].params["UserName"], "dev");
    assert_eq!(calls(&s, &attach(SSO, S3_FULL))[0].params["RoleName"], "AWSReservedSSO_Admin_abc");
}

#[test]
fn group_membership_calls() {
    let s = snapshot();
    assert_eq!(calls(&s, &add_to_group("bob", "admins")), vec![call_of("iam:AddUserToGroup", &[("GroupName", "admins"), ("UserName", "bob")])]);
    assert_eq!(
        calls(&s, &remove_from_group("alice", "admins")),
        vec![call_of("iam:RemoveUserFromGroup", &[("GroupName", "admins"), ("UserName", "alice")])]
    );
}

#[test]
fn access_key_calls() {
    let s = snapshot();
    assert_eq!(
        calls(&s, &set_status("bob", "AKIA1", "Inactive")),
        vec![call_of("iam:UpdateAccessKey", &[("AccessKeyId", "AKIA1"), ("Status", "Inactive"), ("UserName", "bob")])]
    );
    assert_eq!(calls(&s, &delete_key("bob", "AKIA1")), vec![call_of("iam:DeleteAccessKey", &[("AccessKeyId", "AKIA1"), ("UserName", "bob")])]);
}

#[test]
fn inline_policy_calls_follow_the_targets_kind_and_send_the_document_as_given() {
    let s = snapshot();
    let pretty_doc = serde_json::to_string_pretty(&policy(json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }]))).unwrap();
    let targets = [(BOB, "User", "UserName", "bob"), (ADMINS, "Group", "GroupName", "admins"), (DEPLOY, "Role", "RoleName", "deploy")];
    for (target, kind, name_key, name) in targets {
        assert_eq!(
            calls(&s, &put_inline(target, "p1", pretty_doc.clone())),
            vec![call_of(&format!("iam:Put{kind}Policy"), &[(name_key, name), ("PolicyDocument", &pretty_doc), ("PolicyName", "p1")])],
            "{target}"
        );
        assert_eq!(
            calls(&s, &drop_inline(target, "p1")),
            vec![call_of(&format!("iam:Delete{kind}Policy"), &[(name_key, name), ("PolicyName", "p1")])],
            "{target}"
        );
    }
}

#[test]
fn a_managed_policy_edit_creates_a_default_version() {
    let s = snapshot();
    let document = allow(&["s3:GetObject"]);
    assert_eq!(
        calls(&s, &update_managed(UNUSED_POLICY, document.clone())),
        vec![call_of("iam:CreatePolicyVersion", &[("PolicyArn", UNUSED_POLICY), ("PolicyDocument", &document), ("SetAsDefault", "true")])]
    );
}

#[test]
fn a_full_policy_loses_its_oldest_non_default_version_first() {
    let mut s = snapshot();
    // v2가 기본이고 번호는 숫자로 견줘야 한다(글자순이면 v10이 v9보다 앞선다)
    s.policies.get_mut(UNUSED_POLICY).unwrap().versions = versions(&["v2", "v9", "v10", "v11", "v12"], "v2");
    let document = allow(&["s3:GetObject"]);
    let plan = calls(&s, &update_managed(UNUSED_POLICY, document.clone()));
    assert_eq!(
        plan,
        vec![
            call_of("iam:DeletePolicyVersion", &[("PolicyArn", UNUSED_POLICY), ("VersionId", "v9")]),
            call_of("iam:CreatePolicyVersion", &[("PolicyArn", UNUSED_POLICY), ("PolicyDocument", &document), ("SetAsDefault", "true")]),
        ]
    );
    // 가장 오래된 버전이 기본이면 그것은 지우지 않는다
    s.policies.get_mut(UNUSED_POLICY).unwrap().versions = versions(&["v1", "v2", "v3", "v4", "v5"], "v1");
    assert_eq!(calls(&s, &update_managed(UNUSED_POLICY, document))[0].params["VersionId"], "v2");
}

#[test]
fn a_policy_with_room_for_a_version_deletes_nothing() {
    let mut s = snapshot();
    s.policies.get_mut(UNUSED_POLICY).unwrap().versions = versions(&["v1", "v2", "v3", "v4"], "v4");
    let plan = calls(&s, &update_managed(UNUSED_POLICY, allow(&["s3:GetObject"])));
    assert_eq!(plan.iter().map(|c| c.api.as_str()).collect::<Vec<_>>(), vec!["iam:CreatePolicyVersion"]);
}

#[test]
fn an_unknown_policy_gets_only_the_new_version() {
    let s = snapshot();
    let plan = calls(&s, &update_managed(&account_arn("policy/missing"), allow(&["s3:GetObject"])));
    assert_eq!(plan.iter().map(|c| c.api.as_str()).collect::<Vec<_>>(), vec!["iam:CreatePolicyVersion"]);
}

#[test]
fn a_target_missing_from_the_snapshot_has_no_calls() {
    let s = snapshot();
    let missing = account_arn("user/nobody");
    for change in [attach(&missing, S3_FULL), detach(&missing, S3_FULL), put_inline(&missing, "p", allow(&["s3:*"])), drop_inline(&missing, "p")] {
        assert!(calls(&s, &change).is_empty(), "{change:?}");
    }
}
