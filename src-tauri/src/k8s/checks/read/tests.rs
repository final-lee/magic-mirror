use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::*;
use crate::k8s::access::engine::PolicyScope;
use crate::k8s::access::identity::{parse_aws_auth, EntryInput};
use crate::k8s::checks::mock_aws::*;

fn denied(action: &str) -> AppError {
    AppError::AccessDenied { action: action.into() }
}

fn obj(value: Value) -> DynamicObject {
    serde_json::from_value(value).expect("DynamicObject")
}

// ── EKS ──

fn cluster_json() -> String {
    json!({ "cluster": {
        "name": "prod",
        "version": "1.30",
        "createdAt": 1_700_000_000,
        "resourcesVpcConfig": { "endpointPublicAccess": true, "endpointPrivateAccess": false, "publicAccessCidrs": ["0.0.0.0/0"] },
        "logging": { "clusterLogging": [{ "types": ["api", "audit"], "enabled": true }, { "types": ["scheduler", "authenticator"], "enabled": false }] },
        "encryptionConfig": [{ "resources": ["secrets"], "provider": { "keyArn": "arn:aws:kms:ap-northeast-2:1:key/k" } }],
        "accessConfig": { "authenticationMode": "API_AND_CONFIG_MAP" },
    }})
    .to_string()
}

#[tokio::test]
async fn describe_cluster_reads_the_values_the_checks_need() {
    let rec = Recorder::new(|_| (200, cluster_json()));
    let (facts, view) = describe_cluster(&rec.clients().eks, "prod").await.unwrap();
    assert_eq!(facts.version, "1.30");
    assert!(facts.endpoint_public && !facts.endpoint_private);
    assert_eq!(facts.public_cidrs, ["0.0.0.0/0"]);
    // 켜진 유형만(꺼진 scheduler·authenticator는 뺀다)
    assert_eq!(facts.logging_enabled, ["api", "audit"]);
    assert!(facts.secrets_encrypted);
    assert_eq!(facts.created_at, Some(1_700_000_000));
    assert_eq!(view.authentication_mode.as_deref(), Some("API_AND_CONFIG_MAP"));
    assert_eq!(rec.sent().iter().map(|s| s.action.as_str()).collect::<Vec<_>>(), ["REST /clusters/prod"]);
}

#[tokio::test]
async fn a_cluster_without_encryption_config_or_logging_is_read_as_unencrypted_and_logging_off() {
    let rec = Recorder::new(|_| (200, json!({ "cluster": { "name": "prod", "version": "1.30", "resourcesVpcConfig": {} } }).to_string()));
    let (facts, _) = describe_cluster(&rec.clients().eks, "prod").await.unwrap();
    assert!(!facts.secrets_encrypted && facts.logging_enabled.is_empty() && !facts.endpoint_public);
    assert_eq!(facts.created_at, None);
}

#[tokio::test]
async fn a_denied_describe_cluster_is_an_access_denied_error() {
    let rec = Recorder::new(|_| (403, eks_error("AccessDeniedException", "no")));
    assert_eq!(describe_cluster(&rec.clients().eks, "prod").await.err(), Some(denied("eks:DescribeCluster")));
}

#[tokio::test]
async fn cluster_versions_are_read_with_include_all_and_across_pages() {
    let rec = Recorder::new(|sent| match sent.params.get("nextToken").map(String::as_str) {
        None => (200, json!({ "clusterVersions": [{ "clusterVersion": "1.29", "endOfStandardSupportDate": 1_742_688_000 }], "nextToken": "p2" }).to_string()),
        Some(_) => (200, json!({ "clusterVersions": [{ "clusterVersion": "1.30" }] }).to_string()),
    });
    let out = versions(&rec.clients().eks).await.unwrap();
    assert_eq!(out, [VersionSupport { version: "1.29".into(), end_of_standard_support: Some(1_742_688_000) }, VersionSupport { version: "1.30".into(), end_of_standard_support: None }]);
    let sent = rec.sent_of("REST /cluster-versions");
    assert_eq!(sent.len(), 2);
    assert!(sent.iter().all(|s| s.params.get("includeAll").map(String::as_str) == Some("true")), "지원이 끝난 버전도 받아야 해요");
}

#[tokio::test]
async fn a_denied_version_list_is_an_error() {
    let rec = Recorder::new(|_| (403, eks_error("AccessDeniedException", "no")));
    assert_eq!(versions(&rec.clients().eks).await.err(), Some(denied("eks:DescribeClusterVersions")));
}

// ── 노드그룹 시작 템플릿 ──

fn nodegroup_json(name: &str, lt: Option<(&str, &str)>) -> String {
    let mut group = json!({ "nodegroupName": name });
    if let Some((id, version)) = lt {
        group["launchTemplate"] = json!({ "id": id, "version": version, "name": format!("name-{id}") });
    }
    json!({ "nodegroup": group }).to_string()
}

#[tokio::test]
async fn nodegroups_read_each_launch_templates_hop_limit_and_skip_groups_without_one() {
    let rec = Recorder::new(|sent| match sent.action.as_str() {
        "REST /clusters/prod/node-groups" => (200, json!({ "nodegroups": ["a", "b"] }).to_string()),
        "REST /clusters/prod/node-groups/a" => (200, nodegroup_json("a", Some(("lt-a", "3")))),
        "REST /clusters/prod/node-groups/b" => (200, nodegroup_json("b", None)),
        "DescribeLaunchTemplateVersions" => (200, ec2_ok("DescribeLaunchTemplateVersions", &lt_versions(&lt_version_xml("lt-a", 3, Some(2))))),
        other => panic!("예상하지 못한 요청: {other}"),
    });
    let aws = rec.clients();
    let (groups, gaps) = nodegroups(&aws, "prod").await.unwrap();
    assert!(gaps.is_empty());
    assert_eq!(
        groups,
        [
            NodegroupImds { name: "a".into(), launch_template: Some(LaunchTemplateImds { label: "lt-a v3".into(), hop_limit: Some(2) }) },
            NodegroupImds { name: "b".into(), launch_template: None },
        ]
    );
    let lt = rec.sent_of("DescribeLaunchTemplateVersions");
    assert_eq!(lt.len(), 1, "시작 템플릿이 없는 노드그룹은 EC2를 부르지 않는다");
    assert_eq!(lt[0].params["LaunchTemplateId"], "lt-a");
    assert_eq!(lt[0].params["LaunchTemplateVersion.1"], "3");
}

#[tokio::test]
async fn a_launch_template_that_cannot_be_read_is_a_gap_for_that_group_only() {
    let rec = Recorder::new(|sent| match sent.action.as_str() {
        "REST /clusters/prod/node-groups" => (200, json!({ "nodegroups": ["a", "c"] }).to_string()),
        "REST /clusters/prod/node-groups/a" => (200, nodegroup_json("a", Some(("lt-a", "1")))),
        "REST /clusters/prod/node-groups/c" => (200, nodegroup_json("c", Some(("lt-c", "1")))),
        "DescribeLaunchTemplateVersions" if sent.params["LaunchTemplateId"] == "lt-c" => (403, ec2_error("UnauthorizedOperation", "denied")),
        "DescribeLaunchTemplateVersions" => (200, ec2_ok("DescribeLaunchTemplateVersions", &lt_versions(&lt_version_xml("lt-a", 1, Some(1))))),
        other => panic!("{other}"),
    });
    let (groups, gaps) = nodegroups(&rec.clients(), "prod").await.unwrap();
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].launch_template.as_ref().unwrap().hop_limit, Some(1));
    assert_eq!(groups[1].launch_template.as_ref().unwrap().hop_limit, None);
    assert_eq!(gaps.len(), 1);
    assert_eq!((gaps[0].section, gaps[0].subject.as_deref()), (Section::LaunchTemplates, Some("c")));
    assert_eq!(gaps[0].error, denied("ec2:DescribeLaunchTemplateVersions"));
}

#[tokio::test]
async fn a_nodegroup_that_cannot_be_described_is_a_gap_and_the_others_remain() {
    let rec = Recorder::new(|sent| match sent.action.as_str() {
        "REST /clusters/prod/node-groups" => (200, json!({ "nodegroups": ["a", "b"] }).to_string()),
        "REST /clusters/prod/node-groups/a" => (403, eks_error("AccessDeniedException", "no")),
        "REST /clusters/prod/node-groups/b" => (200, nodegroup_json("b", None)),
        other => panic!("{other}"),
    });
    let (groups, gaps) = nodegroups(&rec.clients(), "prod").await.unwrap();
    assert_eq!(groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["b"]);
    assert_eq!(gaps.len(), 1);
    assert_eq!(gaps[0].section, Section::Nodegroups);
}

#[tokio::test]
async fn a_denied_nodegroup_list_fails_the_whole_read() {
    let rec = Recorder::new(|_| (403, eks_error("AccessDeniedException", "no")));
    assert_eq!(nodegroups(&rec.clients(), "prod").await.err(), Some(denied("eks:ListNodegroups")));
}

// ── 인스턴스 ──

#[tokio::test]
async fn instance_hop_limits_are_read_by_filter_in_chunks_and_missing_options_are_unknown() {
    let ids: Vec<String> = (0..150).map(|i| format!("i-{i:04x}")).collect();
    let rec = Recorder::new(|sent| {
        let first = sent.params.get("Filter.1.Value.1").cloned().unwrap_or_default();
        let instances = format!("{}{}", instance_xml(&first, Some(2)), instance_xml(&format!("{first}-bare"), None));
        (200, ec2_ok("DescribeInstances", &reservations(&instances)))
    });
    let out = instance_hops(&rec.clients().ec2, &ids).await.unwrap();
    let sent = rec.sent_of("DescribeInstances");
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0].params["Filter.1.Name"], "instance-id");
    assert_eq!(sent[0].params.keys().filter(|k| k.starts_with("Filter.1.Value.")).count(), 100);
    assert_eq!(sent[1].params.keys().filter(|k| k.starts_with("Filter.1.Value.")).count(), 50);
    assert_eq!(out.get("i-0000"), Some(&Some(2)));
    assert_eq!(out.get("i-0064"), Some(&Some(2)));
    assert_eq!(out.get("i-0000-bare"), Some(&None));
}

#[tokio::test]
async fn a_denied_describe_instances_is_an_error() {
    let rec = Recorder::new(|_| (403, ec2_error("UnauthorizedOperation", "denied")));
    assert_eq!(instance_hops(&rec.clients().ec2, &["i-1".to_string()]).await.err(), Some(denied("ec2:DescribeInstances")));
}

#[tokio::test]
async fn node_settings_combine_hop_limits_with_the_node_labels() {
    let rec = Recorder::new(|_| (200, ec2_ok("DescribeInstances", &reservations(&instance_xml("i-0abc", Some(2))))));
    let bases = vec![
        NodeBase { name: "n1".into(), instance_id: "i-0abc".into(), nodegroup: Some("ng".into()), nodepool: None },
        NodeBase { name: "n2".into(), instance_id: "i-gone".into(), nodegroup: None, nodepool: Some("pool".into()) },
    ];
    let aws = Ok(rec.clients());
    let nodes = node_imds(&aws, bases).await.unwrap();
    assert_eq!((nodes[0].hop_limit, nodes[0].nodegroup.as_deref()), (Some(2), Some("ng")));
    assert_eq!((nodes[1].hop_limit, nodes[1].nodepool.as_deref()), (None, Some("pool")), "이미 사라진 인스턴스는 알 수 없음");
}

#[tokio::test]
async fn without_nodes_with_instances_ec2_is_not_called_even_if_aws_is_unavailable() {
    let aws: Result<Aws, AppError> = Err(AppError::other("AWS 설정 없음"));
    assert_eq!(node_imds(&aws, vec![]).await.unwrap(), vec![]);
    let with_node = vec![NodeBase { name: "n".into(), instance_id: "i-1".into(), nodegroup: None, nodepool: None }];
    assert_eq!(node_imds(&aws, with_node).await.err(), Some(AppError::other("AWS 설정 없음")));
}

// ── 쿠버네티스 객체 ──

fn deployment_json() -> Value {
    json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": { "name": "web", "namespace": "dev", "labels": { "app": "web" }, "annotations": { "a": "b" } },
        "spec": { "template": { "spec": { "containers": [{ "name": "app", "image": "nginx:1" }], "hostNetwork": true } } },
    })
}

#[test]
fn a_deployment_becomes_a_workload_with_its_template_labels_and_annotations() {
    let w = workload_of(WorkloadKind::Deployment, &obj(deployment_json())).unwrap();
    assert_eq!((w.namespace.as_str(), w.name.as_str()), ("dev", "web"));
    assert_eq!(w.labels["app"], "web");
    assert_eq!(w.annotations["a"], "b");
    assert_eq!(w.spec.host_network, Some(true));
    assert_eq!(w.spec.containers[0].image.as_deref(), Some("nginx:1"));
}

#[test]
fn a_cronjob_reads_its_pod_spec_from_the_job_template() {
    let cron = json!({
        "apiVersion": "batch/v1", "kind": "CronJob", "metadata": { "name": "c", "namespace": "dev" },
        "spec": { "jobTemplate": { "spec": { "template": { "spec": { "containers": [{ "name": "x", "image": "a:1" }] } } } } },
    });
    assert_eq!(workload_of(WorkloadKind::CronJob, &obj(cron)).unwrap().spec.containers[0].name, "x");
}

#[test]
fn pods_and_jobs_made_by_a_controller_are_represented_by_the_controller() {
    let owned = |kind: &str, owner: &str| {
        json!({
            "apiVersion": "v1", "kind": kind,
            "metadata": { "name": "x", "namespace": "dev", "ownerReferences": [{ "apiVersion": "apps/v1", "kind": owner, "name": "o", "uid": "u", "controller": true }] },
            "spec": { "containers": [{ "name": "c", "image": "a:1" }], "template": { "spec": { "containers": [{ "name": "c", "image": "a:1" }] } } },
        })
    };
    assert!(workload_of(WorkloadKind::Pod, &obj(owned("Pod", "ReplicaSet"))).is_none());
    assert!(workload_of(WorkloadKind::Job, &obj(owned("Job", "CronJob"))).is_none());
    // 소유자가 있어도 컨트롤러가 아니면(`controller` 없음) 따로 본다
    let mut plain = owned("Pod", "Something");
    plain["metadata"]["ownerReferences"][0]["controller"] = json!(false);
    assert!(workload_of(WorkloadKind::Pod, &obj(plain)).is_some());
    let bare_pod = json!({ "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "p", "namespace": "dev" }, "spec": { "containers": [{ "name": "c", "image": "a:1" }] } });
    assert!(workload_of(WorkloadKind::Pod, &obj(bare_pod)).is_some());
}

#[test]
fn an_object_without_a_readable_pod_spec_is_skipped_not_fatal() {
    let mut no_template = deployment_json();
    no_template["spec"] = json!({});
    assert!(workload_of(WorkloadKind::Deployment, &obj(no_template)).is_none());
    let mut broken = deployment_json();
    broken["spec"]["template"]["spec"]["containers"] = json!("not-a-list");
    assert!(workload_of(WorkloadKind::Deployment, &obj(broken)).is_none());
}

#[test]
fn service_account_automount_is_read_as_a_tri_state() {
    let sa = |extra: Value| {
        let mut v = json!({ "apiVersion": "v1", "kind": "ServiceAccount", "metadata": { "name": "default", "namespace": "dev" } });
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        sa_facts(&obj(v))
    };
    assert_eq!(sa(json!({})).automount, None);
    assert_eq!(sa(json!({ "automountServiceAccountToken": false })).automount, Some(false));
    assert_eq!(sa(json!({ "automountServiceAccountToken": true })).automount, Some(true));
    assert_eq!(sa(json!({})).bound, None);
}

#[test]
fn only_nodes_backed_by_an_ec2_instance_are_read_for_imds() {
    let node = |name: &str, provider: &str, labels: Value| obj(json!({ "apiVersion": "v1", "kind": "Node", "metadata": { "name": name, "labels": labels }, "spec": { "providerID": provider } }));
    let nodes = [
        node("managed", "aws:///ap-northeast-2a/i-0123456789abcdef0", json!({ "eks.amazonaws.com/nodegroup": "ng-a" })),
        node("karpenter", "aws:///ap-northeast-2b/i-0fedcba9876543210", json!({ "karpenter.sh/nodepool": "default" })),
        node("fargate", "aws:///ap-northeast-2a/fargate-ip-10-0-0-1", json!({})),
        node("kind", "kind://docker/mm-live/worker", json!({})),
    ];
    let bases = node_bases(&nodes);
    assert_eq!(bases.len(), 2);
    assert_eq!((bases[0].name.as_str(), bases[0].instance_id.as_str(), bases[0].nodegroup.as_deref(), bases[0].nodepool.as_deref()), ("managed", "i-0123456789abcdef0", Some("ng-a"), None));
    assert_eq!((bases[1].nodepool.as_deref(), bases[1].nodegroup.as_deref()), (Some("default"), None));
}

// ── 신원 매핑에서 ──

fn entry(arn: &str, policies: &[(&str, PolicyScope)]) -> EntryInput {
    EntryInput {
        principal_arn: arn.into(),
        entry_type: Some("STANDARD".into()),
        username: None,
        groups: vec![],
        policies: policies.iter().map(|(p, s)| (format!("arn:aws:eks::aws:cluster-access-policy/{p}"), s.clone())).collect(),
        read_error: None,
    }
}

fn aws_auth(roles: &str) -> crate::k8s::access::identity::AwsAuth {
    parse_aws_auth(&BTreeMap::from([("mapRoles".to_string(), roles.to_string())]))
}

const DEV: &str = "arn:aws:iam::111122223333:role/dev";
const OPS: &str = "arn:aws:iam::111122223333:role/ops";
const SCOPED: &str = "arn:aws:iam::111122223333:role/scoped";

#[test]
fn only_cluster_wide_cluster_admin_policies_make_a_bootstrap_candidate() {
    let entries = [
        entry(OPS, &[("AmazonEKSClusterAdminPolicy", PolicyScope::Cluster)]),
        entry(SCOPED, &[("AmazonEKSClusterAdminPolicy", PolicyScope::Namespaces { namespaces: vec!["dev".into()] })]),
        entry(DEV, &[("AmazonEKSViewPolicy", PolicyScope::Cluster)]),
    ];
    let mappings = resolve(AuthMode::Api, &entries, None);
    assert_eq!(cluster_admin_principals(&mappings), [OPS]);
}

#[test]
fn aws_auth_facts_list_only_the_mappings_that_are_actually_in_use() {
    let auth = aws_auth(&format!("- rolearn: {DEV}\n  username: dev\n  groups: [devs]\n- rolearn: {OPS}\n  username: ops\n  groups: [system:masters]\n"));
    // ops는 access entry에도 있어 access entry가 먼저다(aws-auth 매핑은 쓰이지 않는다)
    let entries = [entry(OPS, &[])];
    let mappings = resolve(AuthMode::ApiAndConfigMap, &entries, Some(&auth));
    let facts = aws_auth_facts(Some("API_AND_CONFIG_MAP"), &mappings);
    assert_eq!(facts.entries.iter().map(|e| e.arn.as_str()).collect::<Vec<_>>(), [DEV]);
    assert_eq!(facts.entries[0].groups, ["devs"]);
    // API 모드에서는 aws-auth가 아무것도 하지 않는다
    let api = resolve(AuthMode::Api, &entries, Some(&auth));
    assert!(aws_auth_facts(Some("API"), &api).entries.is_empty());
    // CONFIG_MAP 모드에서는 모두 쓰인다
    let config = resolve(AuthMode::ConfigMap, &[], Some(&auth));
    assert_eq!(aws_auth_facts(None, &config).entries.len(), 2);
}
