use super::*;
use crate::iam::model::{InlinePolicy, RoleRec};
use crate::iam::policy::parse_document;
use serde_json::json;

const ACCOUNT: &str = "111111111111";
const TOPIC: &str = "arn:aws:sns:ap-northeast-2:111111111111:alerts";
const FOREIGN_TOPIC: &str = "arn:aws:sns:ap-northeast-2:676499404107:foreign";
const RULE: &str = "arn:aws:events:ap-northeast-2:111111111111:rule/karpenter-spot";

fn policy(statements: serde_json::Value) -> String {
    json!({ "Version": "2012-10-17", "Statement": statements }).to_string()
}

fn queue_with(policy: Option<String>) -> SqsQueue {
    let mut q = SqsQueue::fixture("jobs");
    q.policy = policy;
    q
}

fn allow(service: &str, source: &str) -> serde_json::Value {
    json!({ "Effect": "Allow", "Principal": { "Service": service }, "Action": "sqs:SendMessage", "Condition": { "ArnEquals": { "aws:SourceArn": source } } })
}

fn sub(topic: &str, arn: &str, attrs: Option<HashMap<String, String>>) -> Subscription {
    Subscription { topic_arn: topic.into(), subscription_arn: arn.into(), attrs }
}

#[test]
fn an_sns_node_carries_the_policy_verdict_state_and_a_jump() {
    let q = queue_with(Some(policy(json!([allow(SNS_SERVICE, TOPIC)]))));
    let node = sns_node(&q, &sub(TOPIC, "arn:aws:sns:ap-northeast-2:111111111111:alerts:uuid", None));
    assert_eq!((node.kind, node.id.as_str(), node.label.as_str()), (FlowNodeKind::Sns, TOPIC, "alerts"));
    assert_eq!(node.state.as_deref(), Some("Confirmed"));
    assert_eq!(node.allowed_by_policy, Some(true));
    assert!(!node.cross_account);
    assert_eq!(node.jump, Some(SqsJump::Resource { service: "sns".into(), type_id: "topics".into(), id: TOPIC.into() }));
}

#[test]
fn an_sns_subscription_the_policy_does_not_allow_is_marked_denied() {
    let q = queue_with(Some(policy(json!([allow(SNS_SERVICE, "arn:aws:sns:ap-northeast-2:111111111111:other")]))));
    assert_eq!(sns_node(&q, &sub(TOPIC, "x", None)).allowed_by_policy, Some(false));
    let none = queue_with(None);
    assert_eq!(sns_node(&none, &sub(TOPIC, "x", None)).allowed_by_policy, Some(false), "no policy refuses even same-account services");
}

#[test]
fn a_foreign_topic_is_shown_without_a_jump_and_a_pending_one_says_so() {
    let q = queue_with(Some(policy(json!([allow(SNS_SERVICE, FOREIGN_TOPIC)]))));
    let foreign = sns_node(&q, &sub(FOREIGN_TOPIC, "arn:x", None));
    assert!(foreign.cross_account);
    assert_eq!(foreign.jump, None);
    assert_eq!(foreign.allowed_by_policy, Some(true));
    assert!(foreign.detail.iter().any(|d| d.label == "계정" && d.value.contains("676499404107")));
    let pending = sns_node(&q, &sub(TOPIC, "PendingConfirmation", None));
    assert_eq!(pending.state.as_deref(), Some("PendingConfirmation"));
}

#[test]
fn subscription_attributes_show_filter_raw_delivery_and_dlq() {
    let attrs = HashMap::from([
        ("FilterPolicy".to_string(), r#"{ "type": ["a"] }"#.to_string()),
        ("RawMessageDelivery".to_string(), "true".to_string()),
        ("RedrivePolicy".to_string(), r#"{"deadLetterTargetArn":"arn:aws:sqs:r:1:sub-dlq"}"#.to_string()),
    ]);
    let node = sns_node(&queue_with(None), &sub(TOPIC, "x", Some(attrs)));
    let get = |label: &str| node.detail.iter().find(|d| d.label == label).map(|d| d.value.clone());
    assert_eq!(get("필터 정책").as_deref(), Some(r#"{"type":["a"]}"#));
    assert_eq!(get("원본 그대로 전달").as_deref(), Some("예"));
    assert!(get("구독 DLQ").unwrap().contains("sub-dlq"));
}

fn rule(state: &str, bus: &str) -> Rule {
    Rule { arn: RULE.into(), name: "karpenter-spot".into(), bus: bus.into(), state: state.into(), pattern: Some(r#"{"source":["aws.ec2"]}"#.into()), schedule: None }
}

#[test]
fn a_rule_node_keeps_its_state_and_names_non_default_buses() {
    let q = queue_with(Some(policy(json!([allow(EVENTS_SERVICE, RULE)]))));
    let node = rule_node(&q, &rule("ENABLED", "default"));
    assert_eq!((node.kind, node.label.as_str(), node.state.as_deref()), (FlowNodeKind::Rule, "karpenter-spot", Some("ENABLED")));
    assert_eq!(node.allowed_by_policy, Some(true));
    assert!(node.detail.iter().any(|d| d.label == "이벤트 패턴" && d.value.contains("aws.ec2")));
    assert_eq!(rule_node(&q, &rule("ENABLED", "partner")).label, "karpenter-spot (partner)");
    assert_eq!(rule_node(&queue_with(None), &rule("ENABLED", "default")).allowed_by_policy, Some(false));
}

#[test]
fn producer_links_count_only_confirmed_subscriptions_and_enabled_rules() {
    let q = queue_with(None);
    let confirmed = sns_node(&q, &sub(TOPIC, "arn:x", None));
    let pending = sns_node(&q, &sub(FOREIGN_TOPIC, "PendingConfirmation", None));
    let on = rule_node(&q, &rule("ENABLED", "default"));
    let off = rule_node(&q, &rule("DISABLED", "default"));
    let mut policy_only = confirmed.clone();
    policy_only.state = Some(POLICY_ONLY.into());
    let links = links_of(&[confirmed, pending, on, off, policy_only]);
    assert_eq!(links.iter().map(|l| (l.kind, l.label.as_str())).collect::<Vec<_>>(), vec![(ProducerKind::Sns, "alerts"), (ProducerKind::Rule, "karpenter-spot")]);
    assert_eq!(links[0].allowed, Some(false));
}

#[test]
fn policy_only_sources_show_dimly_unless_already_connected() {
    let q = queue_with(Some(policy(json!([allow(SNS_SERVICE, TOPIC), allow(EVENTS_SERVICE, RULE), allow(SNS_SERVICE, FOREIGN_TOPIC), allow(S3_SERVICE, "arn:aws:s3:::uploads"), allow(SNS_SERVICE, "arn:aws:sns:*:*:wild-*")]))));
    let connected: HashSet<String> = HashSet::from([TOPIC.to_string()]);
    let nodes = policy_only_nodes(&q, &connected);
    assert_eq!(nodes.iter().map(|n| (n.kind, n.id.as_str())).collect::<Vec<_>>(), vec![(FlowNodeKind::Rule, RULE), (FlowNodeKind::Sns, FOREIGN_TOPIC)]);
    assert!(nodes.iter().all(|n| n.state.as_deref() == Some(POLICY_ONLY) && n.allowed_by_policy == Some(true)));
    assert_eq!(nodes[0].label, "karpenter-spot");
    assert!(nodes[1].cross_account && nodes[1].jump.is_none());
}

fn lambda_read(function: &str, state: &str, timeout: Option<i64>) -> LambdaRead {
    LambdaRead {
        esm: Esm { uuid: "u-1".into(), source_arn: "arn:aws:sqs:ap-northeast-2:111111111111:jobs".into(), function_arn: function.into(), state: state.into(), batch_size: Some(10), window: Some(0), max_concurrency: Some(5), report_failures: true },
        timeout,
        error: None,
    }
}

#[test]
fn a_lambda_node_shows_the_mapping_settings_and_jumps_to_the_function_by_name() {
    let node = lambda_node(&queue_with(None), &lambda_read("arn:aws:lambda:ap-northeast-2:111111111111:function:worker", "Enabled", Some(30)));
    assert_eq!((node.kind, node.label.as_str(), node.state.as_deref()), (FlowNodeKind::Lambda, "worker", Some("Enabled")));
    assert_eq!(node.jump, Some(SqsJump::Resource { service: "lambda".into(), type_id: "functions".into(), id: "worker".into() }));
    let get = |label: &str| node.detail.iter().find(|d| d.label == label).map(|d| d.value.clone());
    assert_eq!(get("배치 크기").as_deref(), Some("10"));
    assert_eq!(get("최대 동시성").as_deref(), Some("5"));
    assert_eq!(get("부분 실패 보고").as_deref(), Some("ReportBatchItemFailures"));
    assert_eq!(get("함수 제한 시간(초)").as_deref(), Some("30"));
}

#[test]
fn a_lambda_in_another_account_has_no_jump() {
    let node = lambda_node(&queue_with(None), &lambda_read("arn:aws:lambda:ap-northeast-2:999999999999:function:theirs", "Enabled", None));
    assert!(node.cross_account);
    assert_eq!(node.jump, None);
}

// ---------- IAM ----------

const OIDC: &str = "oidc.eks.ap-northeast-2.amazonaws.com/id/ABCDEF";

fn trust(subs: serde_json::Value) -> String {
    policy(json!([{ "Effect": "Allow", "Principal": { "Federated": format!("arn:aws:iam::{ACCOUNT}:oidc-provider/{OIDC}") }, "Action": "sts:AssumeRoleWithWebIdentity", "Condition": { "StringEquals": { format!("{OIDC}:sub"): subs, format!("{OIDC}:aud"): "sts.amazonaws.com" } } }]))
}

#[test]
fn service_accounts_come_from_oidc_sub_conditions() {
    let one = service_accounts(&trust(json!("system:serviceaccount:jobs:worker")));
    assert_eq!(one, vec![ServiceAccountRef { provider: OIDC.into(), namespace: "jobs".into(), name: "worker".into() }]);
    let many = service_accounts(&trust(json!(["system:serviceaccount:a:x", "system:serviceaccount:b:y", "system:serviceaccount:a:x"])));
    assert_eq!(many.iter().map(|s| format!("{}/{}", s.namespace, s.name)).collect::<Vec<_>>(), vec!["a/x", "b/y"]);
}

#[test]
fn service_accounts_ignore_wildcard_subs_other_principals_and_garbage() {
    assert_eq!(service_accounts(&trust(json!("system:serviceaccount:jobs:*"))).len(), 1, "a wildcard name is kept as written");
    assert_eq!(service_accounts(&trust(json!("repo:org/app:ref:refs/heads/main"))), vec![]);
    let ec2 = policy(json!([{ "Effect": "Allow", "Principal": { "Service": "ec2.amazonaws.com" }, "Action": "sts:AssumeRole" }]));
    assert_eq!(service_accounts(&ec2), vec![]);
    let deny = policy(json!([{ "Effect": "Deny", "Principal": { "Federated": format!("arn:aws:iam::{ACCOUNT}:oidc-provider/{OIDC}") }, "Action": "sts:AssumeRoleWithWebIdentity", "Condition": { "StringEquals": { format!("{OIDC}:sub"): "system:serviceaccount:a:b" } } }]));
    assert_eq!(service_accounts(&deny), vec![]);
    assert_eq!(service_accounts("nope"), vec![]);
}

fn snapshot_with_role(trust_raw: Option<String>) -> Snapshot {
    let doc = json!({ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": ["sqs:SendMessage", "sqs:ReceiveMessage"], "Resource": "*" }] }).to_string();
    let role = RoleRec {
        arn: format!("arn:aws:iam::{ACCOUNT}:role/worker-role"),
        name: "worker-role".into(),
        path: "/".into(),
        inline: vec![InlinePolicy { name: "queue-access".into(), document: parse_document(&doc).ok(), raw: doc }],
        trust_raw,
        ..Default::default()
    };
    Snapshot { account_id: ACCOUNT.into(), roles: vec![role], ..Default::default() }
}

#[test]
fn iam_nodes_list_allowed_principals_and_follow_the_role_to_its_service_account() {
    let s = snapshot_with_role(Some(trust(json!("system:serviceaccount:jobs:worker"))));
    let q = queue_with(None);
    let send = who_can(&s, "sqs:SendMessage", Some(&q.arn));
    let recv = who_can(&s, "sqs:ReceiveMessage", Some(&q.arn));
    assert!(needs_clusters(&s, &[&send, &recv]));
    let clusters = vec![ClusterRef { name: "stg-eks".into(), issuer: OIDC.into() }];
    let nodes = iam_nodes(&s, &send, &recv, &EksInfo { clusters, ..Default::default() });
    assert_eq!(nodes.receivers, 1);
    let principal = &nodes.consumers[0];
    assert_eq!((principal.kind, principal.label.as_str(), principal.state.as_deref()), (FlowNodeKind::Principal, "worker-role", Some("허용")));
    assert_eq!(principal.jump, Some(SqsJump::Iam { arn: format!("arn:aws:iam::{ACCOUNT}:role/worker-role") }));
    assert!(principal.detail.iter().any(|d| d.label == "근거 정책" && d.value == "queue-access"));
    let sa = &nodes.consumers[1];
    assert_eq!((sa.kind, sa.label.as_str()), (FlowNodeKind::ServiceAccount, "jobs/worker"));
    assert_eq!(sa.jump, Some(SqsJump::Eks { cluster: "stg-eks".into() }));
    assert_eq!(nodes.producers.len(), 2, "the same role can send");
}

#[test]
fn a_service_account_without_a_matching_cluster_keeps_the_label_but_no_jump() {
    let s = snapshot_with_role(Some(trust(json!("system:serviceaccount:jobs:worker"))));
    let q = queue_with(None);
    let send = who_can(&s, "sqs:SendMessage", Some(&q.arn));
    let nodes = iam_nodes(&s, &send, &send, &EksInfo { clusters: vec![ClusterRef { name: "other".into(), issuer: "oidc.eks.ap-northeast-2.amazonaws.com/id/ZZZ".into() }], ..Default::default() });
    let sa = nodes.consumers.iter().find(|n| n.kind == FlowNodeKind::ServiceAccount).unwrap();
    assert_eq!(sa.jump, None);
    assert!(sa.detail.iter().any(|d| d.label == "클러스터" && d.value.starts_with("알 수 없음")));
}

#[test]
fn roles_without_oidc_trust_need_no_cluster_lookup() {
    let s = snapshot_with_role(Some(policy(json!([{ "Effect": "Allow", "Principal": { "Service": "ecs-tasks.amazonaws.com" }, "Action": "sts:AssumeRole" }]))));
    let q = queue_with(None);
    let send = who_can(&s, "sqs:SendMessage", Some(&q.arn));
    assert!(!needs_clusters(&s, &[&send]));
    let nodes = iam_nodes(&s, &send, &send, &EksInfo::default());
    assert_eq!(nodes.consumers.len(), 1);
}

#[test]
fn iam_principals_beyond_the_cap_are_cut_with_a_note() {
    let mut s = snapshot_with_role(None);
    let template = s.roles[0].clone();
    s.roles = (0..MAX_PRINCIPALS + 5).map(|i| RoleRec { arn: format!("arn:aws:iam::{ACCOUNT}:role/r{i:03}"), name: format!("r{i:03}"), ..template.clone() }).collect();
    let q = queue_with(None);
    let send = who_can(&s, "sqs:SendMessage", Some(&q.arn));
    let nodes = iam_nodes(&s, &send, &send, &EksInfo::default());
    assert_eq!(nodes.producers.len(), MAX_PRINCIPALS);
    assert_eq!(nodes.receivers, MAX_PRINCIPALS + 5, "the receiver count is the real one");
    assert_eq!(nodes.truncated.len(), 2);
    assert!(nodes.truncated[0].contains("55개 중 50개"));
}

// ---------- 큐 노드 ----------

#[test]
fn dlq_and_source_nodes_jump_within_the_tab_and_show_counts() {
    let own = SqsQueue::fixture("orders");
    let mut dlq = SqsQueue::fixture("orders-dlq");
    dlq.visible = 4;
    dlq.in_flight = 1;
    let node = queue_node(&dlq.arn, &[dlq.clone()], &own, Some(3));
    assert_eq!(node.jump, Some(SqsJump::Queue { url: dlq.url.clone() }));
    assert!(node.detail.iter().any(|d| d.value == "보이는 4개 · 처리 중 1개"));
    assert!(node.detail.iter().any(|d| d.label == "maxReceiveCount" && d.value == "3"));
    // 목록에 없어도 같은 계정·리전이면 URL을 만들어 이동한다
    let unlisted = queue_node("arn:aws:sqs:ap-northeast-2:111111111111:late", &[], &own, None);
    assert_eq!(unlisted.jump, Some(SqsJump::Queue { url: "https://sqs.ap-northeast-2.amazonaws.com/111111111111/late".into() }));
    let foreign = queue_node("arn:aws:sqs:ap-northeast-2:999999999999:theirs", &[], &own, None);
    assert!(foreign.cross_account);
    assert_eq!(foreign.jump, None);
}

#[test]
fn compact_shrinks_json_and_cuts_long_text() {
    assert_eq!(compact("{ \"a\" : [1, 2] }", 100), "{\"a\":[1,2]}");
    assert_eq!(compact("plain  ", 100), "plain");
    assert_eq!(compact(&"x".repeat(10), 4), "xxxx…");
}

// ---------- Pod Identity ----------

const ROLE_ARN: &str = "arn:aws:iam::111111111111:role/worker-role";

fn pod_trust() -> String {
    policy(json!([{ "Effect": "Allow", "Principal": { "Service": "pods.eks.amazonaws.com" }, "Action": ["sts:AssumeRole", "sts:TagSession"] }]))
}

fn association(cluster: &str, namespace: &str, sa: &str, role: &str) -> PodIdentityRef {
    PodIdentityRef { cluster: cluster.into(), namespace: namespace.into(), service_account: sa.into(), role_arn: role.into() }
}

#[test]
fn only_an_allowing_pod_identity_service_principal_counts_as_pod_identity_trust() {
    assert!(trusts_pod_identity(&pod_trust()));
    let listed = policy(json!([{ "Effect": "Allow", "Principal": { "Service": ["ec2.amazonaws.com", "pods.eks.amazonaws.com"] }, "Action": "sts:AssumeRole" }]));
    assert!(trusts_pod_identity(&listed));
    let single = json!({ "Statement": { "Effect": "Allow", "Principal": { "Service": "pods.eks.amazonaws.com" }, "Action": "sts:AssumeRole" } }).to_string();
    assert!(trusts_pod_identity(&single));
    let deny = policy(json!([{ "Effect": "Deny", "Principal": { "Service": "pods.eks.amazonaws.com" }, "Action": "sts:AssumeRole" }]));
    assert!(!trusts_pod_identity(&deny));
    let other = policy(json!([{ "Effect": "Allow", "Principal": { "Service": "ecs-tasks.amazonaws.com" }, "Action": "sts:AssumeRole" }]));
    assert!(!trusts_pod_identity(&other));
    assert!(!trusts_pod_identity(&trust(json!("system:serviceaccount:a:b"))), "IRSA trust is not Pod Identity");
    assert!(!trusts_pod_identity("nope"));
}

#[test]
fn associations_match_by_exact_role_arn() {
    let all = vec![association("c1", "jobs", "worker", ROLE_ARN), association("c2", "jobs", "worker", ROLE_ARN), association("c1", "other", "x", "arn:aws:iam::111111111111:role/worker-role-2")];
    let got = pod_identities_for(ROLE_ARN, &all);
    assert_eq!(got.iter().map(|p| p.cluster.as_str()).collect::<Vec<_>>(), vec!["c1", "c2"]);
    assert!(pod_identities_for("arn:aws:iam::111111111111:role/none", &all).is_empty());
}

#[test]
fn pod_identity_roles_ask_for_the_association_read_and_irsa_roles_do_not() {
    let s = snapshot_with_role(Some(pod_trust()));
    let q = queue_with(None);
    let send = who_can(&s, "sqs:SendMessage", Some(&q.arn));
    assert!(needs_pod_identity(&s, &[&send]));
    assert!(!needs_clusters(&s, &[&send]));
    let irsa = snapshot_with_role(Some(trust(json!("system:serviceaccount:a:b"))));
    let send = who_can(&irsa, "sqs:SendMessage", Some(&q.arn));
    assert!(!needs_pod_identity(&irsa, &[&send]));
    let none = snapshot_with_role(None);
    assert!(!needs_pod_identity(&none, &[&who_can(&none, "sqs:SendMessage", Some(&q.arn))]));
}

#[test]
fn pod_identity_service_accounts_hang_off_their_role_with_cluster_and_jump() {
    let s = snapshot_with_role(Some(pod_trust()));
    let q = queue_with(None);
    let recv = who_can(&s, "sqs:ReceiveMessage", Some(&q.arn));
    let eks = EksInfo {
        clusters: vec![],
        pod_identities: vec![association("stg-eks", "backend", "api", ROLE_ARN), association("dev-eks", "backend", "api", ROLE_ARN), association("stg-eks", "other", "elsewhere", "arn:aws:iam::111111111111:role/unrelated")],
    };
    let nodes = iam_nodes(&s, &recv, &recv, &eks);
    let sas: Vec<_> = nodes.consumers.iter().filter(|n| n.kind == FlowNodeKind::ServiceAccount).collect();
    assert_eq!(sas.iter().map(|n| n.label.as_str()).collect::<Vec<_>>(), vec!["backend/api", "backend/api"]);
    assert_eq!(sas[0].jump, Some(SqsJump::Eks { cluster: "stg-eks".into() }));
    assert_eq!(sas[1].jump, Some(SqsJump::Eks { cluster: "dev-eks".into() }));
    assert!(sas[0].detail.iter().any(|d| d.label == "연결 방식" && d.value == "Pod Identity"));
    assert!(sas[0].detail.iter().any(|d| d.label == "역할" && d.value == "worker-role"));
    assert!(sas[0].detail.iter().any(|d| d.label == "클러스터" && d.value == "stg-eks"));
    assert_eq!(sas[0].id, format!("{ROLE_ARN}#stg-eks/backend/api"));
    assert_ne!(sas[0].id, sas[1].id, "the same name in two clusters stays two nodes");
}

#[test]
fn the_same_service_account_from_irsa_and_pod_identity_is_one_node() {
    let s = snapshot_with_role(Some(trust(json!("system:serviceaccount:jobs:worker"))));
    let q = queue_with(None);
    let recv = who_can(&s, "sqs:ReceiveMessage", Some(&q.arn));
    let eks = EksInfo { clusters: vec![ClusterRef { name: "stg-eks".into(), issuer: OIDC.into() }], pod_identities: vec![association("stg-eks", "jobs", "worker", ROLE_ARN)] };
    let nodes = iam_nodes(&s, &recv, &recv, &eks);
    assert_eq!(nodes.consumers.iter().filter(|n| n.kind == FlowNodeKind::ServiceAccount).count(), 1);
}
