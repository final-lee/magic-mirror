use super::*;
use crate::error::AppError;
use crate::k8s::access::engine::{evaluate, PolicyScope};
use crate::k8s::access::fixtures::*;
use crate::k8s::access::identity::{principals, resolve, AuthMode, EntryInput};
use crate::k8s::access::read::{AwsAuthSummary, Gap, Section};

const ADMIN: &str = "arn:aws:iam::1:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_0123456789abcdef";
const LATE: &str = "arn:aws:iam::1:role/late";

fn entry(arn: &str, policies: Vec<(String, PolicyScope)>) -> EntryInput {
    EntryInput { principal_arn: arn.into(), entry_type: Some("STANDARD".into()), username: Some("u".into()), groups: vec!["devs".into()], policies, read_error: None }
}

#[test]
fn the_view_shows_each_mappings_cluster_wide_cells_and_what_could_not_be_evaluated() {
    let mappings = resolve(
        AuthMode::Api,
        &[
            entry(ADMIN, vec![("arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy".into(), PolicyScope::Cluster)]),
            entry(LATE, vec![("arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy".into(), PolicyScope::Cluster)]),
        ],
        None,
    );
    let eval = evaluate(rbac_with(vec![], vec![], vec![], vec![clusterbinding("devs", "view", vec![crate::k8s::access::rbac::Subject::group("devs")])]), principals(&mappings));
    let loaded = Loaded {
        rbac: None,
        rbac_available: true,
        mappings,
        mode: Some(AuthMode::Api),
        mode_raw: Some("API".into()),
        aws_auth: AwsAuthSummary { present: false, accounts: vec![], errors: vec![] },
        namespaces: vec!["a".into()],
        gaps: vec![Gap { section: Section::AwsAuth, error: AppError::Throttled }],
    };
    let view = build(&loaded, &eval, "2026-11-03T00:00:00Z");
    assert_eq!(view.mappings[0].levels, Some(vec![2; 7]), "클러스터 관리자 정책");
    assert!(view.mappings[0].unevaluated.is_empty());
    // 알 수 없는 정책만 있는 주체는 그룹 devs의 view만 받는다
    assert_eq!(view.mappings[1].levels, Some(vec![2, 0, 0, 0, 0, 0, 0]));
    assert_eq!(view.mappings[1].unevaluated.len(), 1);
    assert_eq!(view.sso_groups[0].permission_set, "Admin");
    assert_eq!((view.subject_count, view.gaps.len(), view.fetched_at.as_str()), (3, 1, "2026-11-03T00:00:00Z"));
}

#[test]
fn inactive_mappings_have_no_cells_and_keep_their_reason() {
    let mappings = resolve(AuthMode::ConfigMap, &[entry(ADMIN, vec![])], None);
    let eval = evaluate(rbac_with(vec![], vec![], vec![], vec![]), principals(&mappings));
    let loaded = Loaded {
        rbac: None,
        rbac_available: false,
        mappings,
        mode: Some(AuthMode::ConfigMap),
        mode_raw: None,
        aws_auth: AwsAuthSummary { present: true, accounts: vec![], errors: vec![] },
        namespaces: vec![],
        gaps: vec![],
    };
    let view = build(&loaded, &eval, "t");
    assert_eq!(view.mappings[0].levels, None);
    assert!(view.mappings[0].subject.is_none() && view.mappings[0].mapping.inactive_reason.is_some());
    assert!(!view.rbac_available);
}
