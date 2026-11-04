use std::collections::HashSet;

use serde_json::json;

use super::testkit::*;
use super::*;

fn ok_inputs() -> Inputs {
    Inputs {
        now: 1_800_000_000,
        cluster: Ok(cluster()),
        versions: Ok(vec![]),
        aws_auth: Ok(AwsAuthFacts { mode: Some("API".into()), entries: vec![] }),
        admin_entries: Ok(vec![]),
        eval: Ok(eval(vec![], vec![], vec![], vec![])),
        service_accounts: Ok((vec![], false)),
        namespaces: Ok(vec![]),
        workloads: WorkloadInputs::default(),
        policies: Ok(vec![]),
        imds: ImdsInputs { nodegroups: Ok(vec![]), nodes: Ok(vec![]) },
        gaps: vec![],
    }
}

fn denied(action: &str) -> AppError {
    AppError::AccessDenied { action: action.into() }
}

fn bad_workload() -> Workload {
    deployment("dev", "web", json!({ "containers": [{ "name": "app", "image": "nginx", "securityContext": { "privileged": true } }] }))
}

fn sections(report: &Report) -> Vec<Section> {
    report.gaps.iter().map(|g| g.section).collect()
}

#[test]
fn clean_inputs_produce_nothing_to_report() {
    let report = run(ok_inputs(), "2026-11-03T00:00:00Z");
    assert!(report.findings.is_empty() && report.skipped.is_empty() && report.gaps.is_empty(), "{report:?}");
    assert_eq!(report.fetched_at, "2026-11-03T00:00:00Z");
}

#[test]
fn an_unreadable_cluster_skips_only_the_cluster_checks_and_the_rest_still_run() {
    let mut inputs = ok_inputs();
    inputs.cluster = Err(denied("eks:DescribeCluster"));
    inputs.workloads.items = vec![bad_workload()];
    let report = run(inputs, "t");
    for id in [CheckId::ClusterPublicEndpoint, CheckId::ClusterLoggingOff, CheckId::ClusterSecretsPlain, CheckId::ClusterVersionSupport, CheckId::ClusterCreatorAdmin] {
        assert!(report.skipped.contains(&id), "{id:?}");
    }
    assert_eq!(sections(&report), [Section::Cluster]);
    assert_eq!(report.gaps[0].error, denied("eks:DescribeCluster"));
    assert!(report.findings.iter().any(|f| f.check == CheckId::Privileged), "워크로드 점검은 그대로 돈다");
    assert!(!report.skipped.contains(&CheckId::Privileged));
}

#[test]
fn an_unreadable_version_table_is_a_gap_but_the_version_check_still_runs_from_the_built_in_table() {
    let mut inputs = ok_inputs();
    inputs.versions = Err(denied("eks:DescribeClusterVersions"));
    inputs.cluster = Ok(ClusterFacts { version: "1.30".into(), ..cluster() });
    let report = run(inputs, "t");
    assert_eq!(sections(&report), [Section::Versions]);
    assert!(report.findings.iter().any(|f| f.check == CheckId::ClusterVersionSupport));
    assert!(!report.skipped.contains(&CheckId::ClusterVersionSupport));
}

#[test]
fn unreadable_rbac_skips_the_permission_checks_but_not_workloads_or_cluster() {
    let mut inputs = ok_inputs();
    inputs.eval = Err(AppError::other("RBAC 읽기 실패"));
    inputs.workloads.items = vec![bad_workload()];
    inputs.cluster = Ok(ClusterFacts { secrets_encrypted: false, ..cluster() });
    let report = run(inputs, "t");
    for id in [CheckId::AdminSubject, CheckId::AnonymousAccess, CheckId::EscalateBind, CheckId::Impersonate, CheckId::PodCreateStrongSa, CheckId::NodesProxy, CheckId::SecretsReadAll, CheckId::UnusedRole, CheckId::BindingMissingRole, CheckId::BindingMissingSubject] {
        assert!(report.skipped.contains(&id), "{id:?}");
    }
    assert_eq!(sections(&report), [Section::Rbac]);
    let checks: Vec<CheckId> = report.findings.iter().map(|f| f.check).collect();
    assert!(checks.contains(&CheckId::Privileged) && checks.contains(&CheckId::ClusterSecretsPlain));
}

#[test]
fn when_every_workload_kind_fails_the_workload_checks_are_skipped() {
    let mut inputs = ok_inputs();
    inputs.workloads.errors = [Section::Deployments, Section::StatefulSets, Section::DaemonSets, Section::Jobs, Section::CronJobs, Section::Pods].into_iter().map(|s| (s, denied("list"))).collect();
    let report = run(inputs, "t");
    for id in [CheckId::Privileged, CheckId::HostPath, CheckId::HostNetwork, CheckId::HostPid, CheckId::RunsAsRoot, CheckId::PrivilegeEscalation, CheckId::ResourcesMissing, CheckId::ProbesMissing, CheckId::ImageLatest, CheckId::SaTokenAutomount] {
        assert!(report.skipped.contains(&id), "{id:?}");
    }
    assert_eq!(report.gaps.len(), 6);
}

#[test]
fn one_failing_workload_kind_is_a_gap_and_the_other_kinds_are_still_checked() {
    let mut inputs = ok_inputs();
    inputs.workloads.errors = vec![(Section::CronJobs, denied("cronjobs"))];
    inputs.workloads.items = vec![bad_workload()];
    let report = run(inputs, "t");
    assert_eq!(sections(&report), [Section::CronJobs]);
    assert!(report.skipped.is_empty());
    assert!(report.findings.iter().any(|f| f.check == CheckId::Privileged));
}

#[test]
fn truncated_lists_are_partial_gaps_and_do_not_skip_anything() {
    let mut inputs = ok_inputs();
    inputs.workloads.truncated = vec![Section::Pods];
    let report = run(inputs, "t");
    assert_eq!(report.gaps.len(), 1);
    assert!(report.gaps[0].partial && report.gaps[0].section == Section::Pods);
    assert!(report.skipped.is_empty());
}

#[test]
fn a_truncated_service_account_list_skips_only_the_missing_subject_check() {
    let mut inputs = ok_inputs();
    inputs.eval = Ok(eval(vec![], vec![], vec![rolebinding("dev", "b", cluster_ref("view"), vec![sa("dev", "gone")])], vec![]));
    inputs.service_accounts = Ok((vec![], true));
    let report = run(inputs, "t");
    assert_eq!(report.skipped, [CheckId::BindingMissingSubject]);
    assert!(report.gaps.iter().any(|g| g.section == Section::ServiceAccounts && g.partial));
    assert!(report.findings.is_empty(), "잘린 목록으로는 없는 주체를 판단하지 않는다");
}

#[test]
fn an_unreadable_service_account_list_skips_the_default_account_and_missing_subject_checks() {
    let mut inputs = ok_inputs();
    inputs.service_accounts = Err(denied("serviceaccounts"));
    let report = run(inputs, "t");
    assert_eq!(report.skipped, [CheckId::BindingMissingSubject, CheckId::SaTokenAutomount]);
}

#[test]
fn network_policy_check_needs_both_namespaces_and_policies() {
    for (namespaces, policies) in [(Err(denied("namespaces")), Ok(vec![])), (Ok(vec!["dev".to_string()]), Err(denied("networkpolicies")))] {
        let mut inputs = ok_inputs();
        inputs.namespaces = namespaces;
        inputs.policies = policies;
        assert_eq!(run(inputs, "t").skipped, [CheckId::NoNetworkPolicy]);
    }
}

#[test]
fn imds_is_skipped_only_when_neither_node_source_could_be_read() {
    let mut inputs = ok_inputs();
    inputs.imds = ImdsInputs { nodegroups: Err(denied("eks:ListNodegroups")), nodes: Err(denied("ec2:DescribeInstances")) };
    let report = run(inputs, "t");
    assert_eq!(report.skipped, [CheckId::ImdsHopLimit]);
    assert_eq!(sections(&report), [Section::Nodegroups, Section::Nodes]);

    let mut one = ok_inputs();
    one.imds = ImdsInputs {
        nodegroups: Err(denied("eks:ListNodegroups")),
        nodes: Ok(vec![NodeImds { name: "n".into(), instance_id: "i-1".into(), nodegroup: Some("ng".into()), nodepool: None, hop_limit: Some(2) }]),
    };
    let report = run(one, "t");
    assert!(report.skipped.is_empty());
    assert!(report.findings.iter().any(|f| f.check == CheckId::ImdsHopLimit));
}

#[test]
fn read_time_gaps_are_passed_through() {
    let mut inputs = ok_inputs();
    inputs.gaps = vec![Gap { section: Section::LaunchTemplates, subject: Some("ng-a".into()), error: denied("ec2:DescribeLaunchTemplateVersions"), partial: false }];
    let report = run(inputs, "t");
    assert_eq!(report.gaps.len(), 1);
    assert_eq!(report.gaps[0].subject.as_deref(), Some("ng-a"));
}

#[test]
fn the_default_service_account_fix_is_offered_only_when_rbac_says_it_has_no_grants() {
    let w = deployment("dev", "web", json!({ "containers": [{ "name": "app", "image": "a:1", "securityContext": { "allowPrivilegeEscalation": false, "runAsNonRoot": true }, "resources": { "requests": { "cpu": "1", "memory": "1" }, "limits": { "cpu": "1", "memory": "1" } }, "readinessProbe": { "tcpSocket": { "port": 1 } }, "livenessProbe": { "tcpSocket": { "port": 1 } } }] }));
    let default_sa = SaFacts { namespace: "dev".into(), name: "default".into(), automount: None, bound: None };
    let fix_for = |inputs: Inputs| run(inputs, "t").findings.into_iter().find(|f| f.check == CheckId::SaTokenAutomount).map(|f| f.fix.is_some());

    let mut plain = ok_inputs();
    plain.workloads.items = vec![w.clone()];
    plain.service_accounts = Ok((vec![default_sa.clone()], false));
    assert_eq!(fix_for(plain), Some(true));

    let mut bound = ok_inputs();
    bound.workloads.items = vec![w.clone()];
    bound.service_accounts = Ok((vec![default_sa.clone()], false));
    bound.eval = Ok(eval(vec![], vec![], vec![rolebinding("dev", "default-view", cluster_ref("view"), vec![sa("dev", "default")])], vec![]));
    assert_eq!(fix_for(bound), Some(false), "default SA에 권한이 붙어 있으면 자동으로 고치지 않는다");

    let mut no_rbac = ok_inputs();
    no_rbac.workloads.items = vec![w];
    no_rbac.service_accounts = Ok((vec![default_sa], false));
    no_rbac.eval = Err(AppError::other("rbac"));
    assert_eq!(fix_for(no_rbac), Some(false), "RBAC을 읽지 못하면 안전하다고 말할 수 없다");
}

#[test]
fn findings_are_ordered_by_severity_then_check_and_ids_are_unique_and_stable() {
    let mut inputs = ok_inputs();
    inputs.cluster = Ok(ClusterFacts { secrets_encrypted: false, endpoint_public: true, public_cidrs: vec!["0.0.0.0/0".into()], ..cluster() });
    inputs.workloads.items = vec![bad_workload(), deployment("dev", "other", json!({ "containers": [{ "name": "a", "image": "nginx" }] }))];
    let first = run(inputs, "t");
    let severities: Vec<Severity> = first.findings.iter().map(|f| f.severity).collect();
    assert!(severities.windows(2).all(|w| w[0] >= w[1]), "{severities:?}");
    let ids: HashSet<&str> = first.findings.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(ids.len(), first.findings.len(), "같은 id가 둘 있다");
    assert_eq!(first.findings[0].check, CheckId::ClusterPublicEndpoint, "같은 high 안에서는 점검 순서(클러스터가 먼저)");

    let mut again = ok_inputs();
    again.cluster = Ok(ClusterFacts { secrets_encrypted: false, endpoint_public: true, public_cidrs: vec!["0.0.0.0/0".into()], ..cluster() });
    again.workloads.items = vec![bad_workload(), deployment("dev", "other", json!({ "containers": [{ "name": "a", "image": "nginx" }] }))];
    let second = run(again, "t");
    assert_eq!(first.findings.iter().map(|f| &f.id).collect::<Vec<_>>(), second.findings.iter().map(|f| &f.id).collect::<Vec<_>>());
}

#[test]
fn check_names_are_unique_camel_case_and_every_check_has_a_category() {
    let names: HashSet<String> = CheckId::ALL.iter().map(|c| c.name()).collect();
    assert_eq!(names.len(), CheckId::ALL.len());
    assert!(names.iter().all(|n| n.chars().next().is_some_and(|c| c.is_ascii_lowercase()) && n.chars().all(|c| c.is_ascii_alphanumeric())), "{names:?}");
    let count = |category: Category| CheckId::ALL.iter().filter(|c| c.category() == category).count();
    assert_eq!((count(Category::Cluster), count(Category::Permissions), count(Category::Workloads)), (6, 10, 12));
}

#[test]
fn the_system_flag_follows_the_namespace_of_the_finding() {
    let mut inputs = ok_inputs();
    inputs.workloads.items = vec![
        deployment("kube-system", "dns", json!({ "containers": [{ "name": "a", "image": "x:1", "securityContext": { "privileged": true } }] })),
        deployment("amazon-cloudwatch", "agent", json!({ "containers": [{ "name": "a", "image": "x:1", "securityContext": { "privileged": true } }] })),
        deployment("dev", "app", json!({ "containers": [{ "name": "a", "image": "x:1", "securityContext": { "privileged": true } }] })),
    ];
    let report = run(inputs, "t");
    let flags: Vec<(String, bool)> = report.findings.iter().filter(|f| f.check == CheckId::Privileged).map(|f| (f.namespace.clone().unwrap(), f.system)).collect();
    assert_eq!(flags, [("amazon-cloudwatch".to_string(), true), ("dev".to_string(), false), ("kube-system".to_string(), true)]);
}
