use serde_json::{json, Value};

use super::*;

const ISSUER: &str = "https://oidc.eks.ap-northeast-2.amazonaws.com/id/ABCDEF";
const HOST: &str = "oidc.eks.ap-northeast-2.amazonaws.com/id/ABCDEF";
const PROVIDER_ARN: &str = "arn:aws:iam::111122223333:oidc-provider/oidc.eks.ap-northeast-2.amazonaws.com/id/ABCDEF";
const ROLE: &str = "arn:aws:iam::111122223333:role/app-role";

fn trust(statements: Value) -> String {
    json!({ "Version": "2012-10-17", "Statement": statements }).to_string()
}

fn web_identity(conditions: Value) -> Value {
    json!({ "Effect": "Allow", "Principal": { "Federated": PROVIDER_ARN }, "Action": "sts:AssumeRoleWithWebIdentity", "Condition": conditions })
}

fn irsa(statements: Value, ns: &str, sa: &str) -> Check {
    check_irsa(&trust(statements), ISSUER, ns, sa, DEFAULT_AUDIENCE)
}

fn broken(check: &Check) -> &[String] {
    match check {
        Check::Broken { reasons } => reasons,
        other => panic!("{other:?}"),
    }
}

// ── IRSA 신뢰 정책 ──

#[test]
fn irsa_works_with_the_exact_sub_and_the_sts_audience() {
    let c = json!({ "StringEquals": { format!("{HOST}:sub"): "system:serviceaccount:app:web", format!("{HOST}:aud"): "sts.amazonaws.com" } });
    assert_eq!(irsa(json!([web_identity(c)]), "app", "web"), Check::Works);
}

#[test]
fn irsa_accepts_wildcards_in_sub_through_string_like() {
    for pattern in ["system:serviceaccount:app:*", "system:serviceaccount:*:web", "system:serviceaccount:app:w?b", "system:serviceaccount:*"] {
        let c = json!({ "StringLike": { format!("{HOST}:sub"): pattern }, "StringEquals": { format!("{HOST}:aud"): "sts.amazonaws.com" } });
        assert_eq!(irsa(json!([web_identity(c)]), "app", "web"), Check::Works, "{pattern}");
    }
}

#[test]
fn irsa_with_a_sub_for_another_service_account_is_connected_but_not_working() {
    let c = json!({ "StringEquals": { format!("{HOST}:sub"): "system:serviceaccount:app:other", format!("{HOST}:aud"): "sts.amazonaws.com" } });
    let check = irsa(json!([web_identity(c)]), "app", "web");
    assert!(broken(&check).iter().any(|r| r.starts_with("sub 조건이") && r.contains("other")), "{check:?}");
}

#[test]
fn irsa_needs_both_sub_and_aud_conditions_present() {
    let only_aud = json!({ "StringEquals": { format!("{HOST}:aud"): "sts.amazonaws.com" } });
    assert_eq!(broken(&irsa(json!([web_identity(only_aud)]), "a", "b")), &["sub 조건이 없어요".to_string()]);
    let only_sub = json!({ "StringEquals": { format!("{HOST}:sub"): "system:serviceaccount:a:b" } });
    assert_eq!(broken(&irsa(json!([web_identity(only_sub)]), "a", "b")), &["aud 조건이 없어요".to_string()]);
}

#[test]
fn irsa_with_a_wrong_audience_is_broken_and_the_annotation_audience_is_honoured() {
    let c = json!({ "StringEquals": { format!("{HOST}:sub"): "system:serviceaccount:a:b", format!("{HOST}:aud"): "other.example.com" } });
    assert!(broken(&irsa(json!([web_identity(c.clone())]), "a", "b")).iter().any(|r| r.starts_with("aud")));
    assert_eq!(check_irsa(&trust(json!([web_identity(c)])), ISSUER, "a", "b", "other.example.com"), Check::Works);
}

#[test]
fn irsa_without_this_clusters_provider_is_broken() {
    let other = json!({ "Effect": "Allow", "Principal": { "Federated": "arn:aws:iam::111122223333:oidc-provider/oidc.eks.ap-northeast-2.amazonaws.com/id/OTHER" }, "Action": "sts:AssumeRoleWithWebIdentity", "Condition": {} });
    assert_eq!(broken(&irsa(json!([other]), "a", "b")), &[NO_PROVIDER.to_string()]);
    let service = json!({ "Effect": "Allow", "Principal": { "Service": "ec2.amazonaws.com" }, "Action": "sts:AssumeRole" });
    assert_eq!(broken(&irsa(json!([service]), "a", "b")), &[NO_PROVIDER.to_string()]);
}

#[test]
fn irsa_ignores_deny_statements_and_other_actions_and_any_passing_statement_wins() {
    let good = json!({ "StringEquals": { format!("{HOST}:sub"): "system:serviceaccount:a:b", format!("{HOST}:aud"): "sts.amazonaws.com" } });
    let mut deny = web_identity(good.clone());
    deny["Effect"] = json!("Deny");
    let mut wrong_action = web_identity(good.clone());
    wrong_action["Action"] = json!("sts:AssumeRole");
    assert_eq!(broken(&irsa(json!([deny, wrong_action]), "a", "b")), &[NO_PROVIDER.to_string()]);
    let bad = web_identity(json!({ "StringEquals": { format!("{HOST}:sub"): "system:serviceaccount:a:zzz", format!("{HOST}:aud"): "sts.amazonaws.com" } }));
    assert_eq!(irsa(json!([bad, web_identity(good)]), "a", "b"), Check::Works);
}

#[test]
fn irsa_with_an_operator_it_cannot_evaluate_is_unknown_not_broken() {
    let c = json!({ "StringNotEquals": { format!("{HOST}:sub"): "system:serviceaccount:a:x" }, "StringEquals": { format!("{HOST}:aud"): "sts.amazonaws.com" } });
    assert!(matches!(irsa(json!([web_identity(c)]), "a", "b"), Check::Unknown { .. }));
}

#[test]
fn irsa_reads_policies_that_are_url_encoded_and_reports_garbage() {
    let encoded = trust(json!([web_identity(json!({ "StringEquals": { format!("{HOST}:sub"): "system:serviceaccount:a:b", format!("{HOST}:aud"): "sts.amazonaws.com" } }))]))
        .replace('{', "%7B")
        .replace('}', "%7D")
        .replace('"', "%22")
        .replace(':', "%3A")
        .replace(',', "%2C")
        .replace('[', "%5B")
        .replace(']', "%5D");
    assert_eq!(check_irsa(&encoded, ISSUER, "a", "b", DEFAULT_AUDIENCE), Check::Works);
    assert!(matches!(check_irsa("not json", ISSUER, "a", "b", DEFAULT_AUDIENCE), Check::Unknown { .. }));
}

#[test]
fn the_issuer_url_and_the_provider_host_compare_equal() {
    let c = json!({ "StringEquals": { format!("{HOST}:sub"): "system:serviceaccount:a:b", format!("{HOST}:aud"): "sts.amazonaws.com" } });
    assert_eq!(check_irsa(&trust(json!([web_identity(c)])), &format!("{ISSUER}/"), "a", "b", DEFAULT_AUDIENCE), Check::Works);
}

// ── Pod Identity 신뢰 정책 ──

fn pods_trust(actions: Value) -> String {
    trust(json!([{ "Effect": "Allow", "Principal": { "Service": "pods.eks.amazonaws.com" }, "Action": actions }]))
}

#[test]
fn pod_identity_needs_assume_role_and_tag_session_for_the_pods_service() {
    assert_eq!(check_pod_identity(&pods_trust(json!(["sts:AssumeRole", "sts:TagSession"]))), Check::Works);
    assert_eq!(broken_reasons(check_pod_identity(&pods_trust(json!("sts:AssumeRole")))), vec!["sts:TagSession를 허용하지 않아요".to_string()]);
    assert_eq!(broken_reasons(check_pod_identity(&trust(json!([{ "Effect": "Allow", "Principal": { "Service": "ec2.amazonaws.com" }, "Action": "sts:AssumeRole" }])))), vec!["pods.eks.amazonaws.com를 신뢰하지 않아요".to_string()]);
}

fn broken_reasons(check: Check) -> Vec<String> {
    match check {
        Check::Broken { reasons } => reasons,
        other => panic!("{other:?}"),
    }
}

// ── 맞추기 ──

fn sa(ns: &str, name: &str, annotations: &[(&str, &str)]) -> SaInfo {
    SaInfo { namespace: ns.into(), name: name.into(), annotations: annotations.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
}

fn pod(ns: &str, name: &str, sa: &str) -> PodInfo {
    PodInfo { namespace: ns.into(), name: name.into(), service_account: sa.into() }
}

fn good_trust() -> String {
    trust(json!([web_identity(json!({ "StringEquals": { format!("{HOST}:sub"): "system:serviceaccount:app:web", format!("{HOST}:aud"): "sts.amazonaws.com" } }))]))
}

#[test]
fn only_service_accounts_with_irsa_or_pod_identity_are_listed_with_their_pods() {
    let sas = vec![sa("app", "web", &[(IRSA_ANNOTATION, ROLE)]), sa("app", "plain", &[]), sa("app", "empty", &[(IRSA_ANNOTATION, "")])];
    let pods = vec![pod("app", "web-2", "web"), pod("app", "web-1", "web"), pod("app", "p", "plain"), pod("other", "web-9", "web")];
    let trusts = HashMap::from([(ROLE.to_string(), Ok(good_trust()))]);
    let out = assemble(&sas, &pods, &[], &trusts, Some(ISSUER));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].service_account, "web");
    assert_eq!(out[0].pods, vec!["web-1".to_string(), "web-2".to_string()]);
    assert_eq!(out[0].irsa.as_ref().unwrap().check, Check::Works);
    assert_eq!(out[0].irsa.as_ref().unwrap().audience, DEFAULT_AUDIENCE);
}

#[test]
fn a_role_that_could_not_be_read_makes_the_check_unknown_not_broken() {
    let sas = vec![sa("app", "web", &[(IRSA_ANNOTATION, ROLE)])];
    let trusts = HashMap::from([(ROLE.to_string(), Err("권한 없음 (iam:GetRole)".to_string()))]);
    let out = assemble(&sas, &[], &[], &trusts, Some(ISSUER));
    assert_eq!(out[0].irsa.as_ref().unwrap().check, Check::Unknown { message: "권한 없음 (iam:GetRole)".into() });
    // OIDC 발급자를 모르면 확인하지 못한다
    let none = assemble(&sas, &[], &[], &HashMap::new(), None);
    assert!(matches!(none[0].irsa.as_ref().unwrap().check, Check::Unknown { .. }));
}

#[test]
fn pod_identity_associations_are_matched_to_service_accounts_and_flag_a_missing_one_and_double_setup() {
    let sas = vec![sa("app", "web", &[(IRSA_ANNOTATION, ROLE)])];
    let assoc = |ns: &str, name: &str| Association { id: format!("a-{name}"), namespace: ns.into(), service_account: name.into(), role_arn: "arn:aws:iam::111122223333:role/pi".into(), target_role_arn: None };
    let trusts = HashMap::from([(ROLE.to_string(), Ok(good_trust())), ("arn:aws:iam::111122223333:role/pi".to_string(), Ok(pods_trust(json!(["sts:AssumeRole", "sts:TagSession"]))))]);
    let out = assemble(&sas, &[], &[assoc("app", "web"), assoc("app", "ghost")], &trusts, Some(ISSUER));
    assert_eq!(out.iter().map(|w| w.service_account.as_str()).collect::<Vec<_>>(), vec!["ghost", "web"]);
    let ghost = &out[0];
    assert!(!ghost.exists && ghost.notes[0].contains("아직 없어요"));
    assert_eq!(ghost.pod_identity.as_ref().unwrap().check, Check::Works);
    let web = &out[1];
    assert!(web.irsa.is_some() && web.pod_identity.is_some());
    assert!(web.notes.iter().any(|n| n.contains("IRSA")));
}

#[test]
fn the_pod_list_is_capped_but_the_count_is_exact() {
    let sas = vec![sa("app", "web", &[(IRSA_ANNOTATION, ROLE)])];
    let pods: Vec<PodInfo> = (0..45).map(|i| pod("app", &format!("p{i:02}"), "web")).collect();
    let out = assemble(&sas, &pods, &[], &HashMap::new(), None);
    assert_eq!((out[0].pods.len(), out[0].pod_count), (PODS_SHOWN, 45));
}

#[test]
fn role_names_drop_the_path() {
    assert_eq!(role_name("arn:aws:iam::1:role/team/app-role"), Some("app-role"));
    assert_eq!(role_name("arn:aws:iam::1:user/x"), None);
}
