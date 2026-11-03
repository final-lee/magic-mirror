use std::fmt;
use std::sync::{Arc, Mutex};

use aws_sdk_eks::config::retry::RetryConfig;
use aws_sdk_eks::config::{BehaviorVersion, Credentials, Region};
use aws_smithy_runtime_api::client::http::{HttpClient, HttpConnector, HttpConnectorFuture, HttpConnectorSettings, SharedHttpClient, SharedHttpConnector};
use aws_smithy_runtime_api::client::orchestrator::{HttpRequest, HttpResponse};
use aws_smithy_runtime_api::client::runtime_components::RuntimeComponents;
use aws_smithy_runtime_api::http::StatusCode;
use aws_smithy_types::body::SdkBody;
use serde_json::{json, Value};

use super::*;
use crate::iam::mock_aws::{error_xml, ok_with, Recorder as IamRecorder};
use crate::k8s::access::identity::MappingSource;
use crate::k8s::access::workload::Check;

type Responder = dyn Fn(&str) -> (u16, Value) + Send + Sync;

/// 테스트용 EKS 클라이언트. 보낸 요청의 경로·질의를 기록하고 정해 둔 응답을 돌려준다(`iam::mock_aws`와 같은 방식, REST JSON).
#[derive(Clone)]
struct Eks {
    sent: Arc<Mutex<Vec<String>>>,
    responder: Arc<Responder>,
}

impl fmt::Debug for Eks {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Eks")
    }
}

impl Eks {
    fn new(responder: impl Fn(&str) -> (u16, Value) + Send + Sync + 'static) -> Eks {
        Eks { sent: Arc::default(), responder: Arc::new(responder) }
    }

    fn sent(&self) -> Vec<String> {
        self.sent.lock().unwrap().clone()
    }

    fn client(&self) -> aws_sdk_eks::Client {
        let config = aws_sdk_eks::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("ap-northeast-2"))
            .credentials_provider(Credentials::new("AKIDTEST", "secret", None, None, "test"))
            .http_client(SharedHttpClient::new(self.clone()))
            .retry_config(RetryConfig::disabled())
            .build();
        aws_sdk_eks::Client::from_conf(config)
    }
}

impl HttpConnector for Eks {
    fn call(&self, request: HttpRequest) -> HttpConnectorFuture {
        // `https://eks.<리전>.amazonaws.com/clusters/c/access-entries?nextToken=…` → `/clusters/c/access-entries?nextToken=…`
        let uri = request.uri().to_string();
        let path = uri.split_once("amazonaws.com").map_or(uri.clone(), |(_, rest)| rest.to_string());
        self.sent.lock().unwrap().push(path.clone());
        let (status, body) = (self.responder)(&path);
        let mut response = HttpResponse::new(StatusCode::try_from(status).unwrap(), SdkBody::from(body.to_string()));
        response.headers_mut().insert("content-type", "application/json");
        if status == 403 {
            response.headers_mut().insert("x-amzn-errortype", "AccessDeniedException");
        }
        HttpConnectorFuture::ready(Ok(response))
    }
}

impl HttpClient for Eks {
    fn http_connector(&self, _settings: &HttpConnectorSettings, _components: &RuntimeComponents) -> SharedHttpConnector {
        SharedHttpConnector::new(self.clone())
    }
}

fn denied() -> (u16, Value) {
    (403, json!({ "message": "not authorized" }))
}

const ADMIN: &str = "arn:aws:iam::111122223333:role/admin";
const DEV: &str = "arn:aws:iam::111122223333:role/dev";
const VIEW_POLICY: &str = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy";

fn entries_responder(path: &str) -> (u16, Value) {
    let decoded = path.replace("%3A", ":").replace("%2F", "/");
    if path.split('?').next() == Some("/clusters/c/access-entries") {
        if path.contains("nextToken=page2") {
            return (200, json!({ "accessEntries": [DEV] }));
        }
        return (200, json!({ "accessEntries": [ADMIN], "nextToken": "page2" }));
    }
    if decoded.ends_with("/access-policies") || decoded.contains("/access-policies?") {
        let scope = if decoded.contains(ADMIN) { json!({ "type": "namespace", "namespaces": ["dev"] }) } else { json!({ "type": "cluster", "namespaces": [] }) };
        return (200, json!({ "associatedAccessPolicies": [{ "policyArn": VIEW_POLICY, "accessScope": scope }] }));
    }
    if decoded.contains(DEV) {
        return denied();
    }
    (200, json!({ "accessEntry": { "principalArn": ADMIN, "kubernetesGroups": ["admins"], "username": "admin:{{SessionName}}", "type": "STANDARD" } }))
}

#[tokio::test]
async fn access_entries_are_listed_across_pages_and_described_one_by_one() {
    let eks = Eks::new(entries_responder);
    let entries = read_entries(&eks.client(), "c").await.unwrap();
    assert_eq!(entries.iter().map(|e| e.principal_arn.as_str()).collect::<Vec<_>>(), vec![ADMIN, DEV]);
    let admin = &entries[0];
    assert_eq!((admin.username.as_deref(), admin.groups.clone(), admin.entry_type.as_deref()), (Some("admin:{{SessionName}}"), vec!["admins".to_string()], Some("STANDARD")));
    assert_eq!(admin.policies, vec![(VIEW_POLICY.to_string(), PolicyScope::Namespaces { namespaces: vec!["dev".into()] })]);
    // 어느 한 항목을 못 읽어도 나머지는 그대로고 그 항목만 이유를 남긴다
    let dev = &entries[1];
    assert!(dev.read_error.as_deref().is_some_and(|e| e.contains("eks:DescribeAccessEntry")), "{dev:?}");
    assert_eq!(dev.policies, vec![(VIEW_POLICY.to_string(), PolicyScope::Cluster)]);
    // 목록 두 번, 항목마다 Describe와 정책 목록: 읽기 요청뿐이다
    let sent = eks.sent();
    assert_eq!(sent.iter().filter(|p| p.split('?').next() == Some("/clusters/c/access-entries")).count(), 2);
    assert_eq!(sent.len(), 2 + 2 * 2);
}

#[tokio::test]
async fn failing_to_list_access_entries_is_an_error_for_that_source() {
    let eks = Eks::new(|_| denied());
    let err = read_entries(&eks.client(), "c").await.unwrap_err();
    assert_eq!(err, AppError::AccessDenied { action: "eks:ListAccessEntries".into() });
}

fn pod_identity_responder(path: &str) -> (u16, Value) {
    if path.split('?').next() == Some("/clusters/c/pod-identity-associations") {
        return (
            200,
            json!({ "associations": [
                { "clusterName": "c", "namespace": "app", "serviceAccount": "web", "associationId": "a-1" },
                { "clusterName": "c", "namespace": "app", "serviceAccount": "batch", "associationId": "a-2" },
            ] }),
        );
    }
    let id = path.rsplit('/').next().unwrap_or("");
    let role = if id == "a-1" { "arn:aws:iam::111122223333:role/web" } else { "arn:aws:iam::111122223333:role/batch" };
    let sa = if id == "a-1" { "web" } else { "batch" };
    (200, json!({ "association": { "clusterName": "c", "namespace": "app", "serviceAccount": sa, "associationId": id, "roleArn": role, "targetRoleArn": "arn:aws:iam::999999999999:role/target" } }))
}

#[tokio::test]
async fn pod_identity_associations_are_listed_and_described_and_sorted() {
    let eks = Eks::new(pod_identity_responder);
    let list = read_associations(&eks.client(), "c").await.unwrap();
    assert_eq!(list.iter().map(|a| (a.service_account.as_str(), a.id.as_str(), a.role_arn.as_str())).collect::<Vec<_>>(), vec![("batch", "a-2", "arn:aws:iam::111122223333:role/batch"), ("web", "a-1", "arn:aws:iam::111122223333:role/web")]);
    assert_eq!(list[0].target_role_arn.as_deref(), Some("arn:aws:iam::999999999999:role/target"));
}

fn role_xml(name: &str, document: &str) -> String {
    ok_with(
        "GetRole",
        &format!("<Role><Path>/</Path><RoleName>{name}</RoleName><RoleId>AROA</RoleId><Arn>arn:aws:iam::111122223333:role/{name}</Arn><CreateDate>2024-01-01T00:00:00Z</CreateDate><AssumeRolePolicyDocument>{document}</AssumeRolePolicyDocument></Role>"),
    )
}

#[tokio::test]
async fn a_roles_trust_policy_is_read_with_get_role_by_name_and_decoded() {
    let encoded = "%7B%22Version%22%3A%222012-10-17%22%2C%22Statement%22%3A%5B%5D%7D";
    let iam = IamRecorder::new(move |_| (200, role_xml("app-role", encoded)));
    let text = read_trust(&iam.client(), "arn:aws:iam::111122223333:role/team/app-role").await.unwrap();
    assert_eq!(text, "{\"Version\":\"2012-10-17\",\"Statement\":[]}");
    let sent = iam.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!((sent[0].action.as_str(), sent[0].params["RoleName"].as_str()), ("GetRole", "app-role"));
}

#[tokio::test]
async fn an_unreadable_role_gives_the_reason_instead_of_failing_the_screen() {
    let iam = IamRecorder::new(|_| (403, error_xml("AccessDenied", "no")));
    let err = read_trust(&iam.client(), "arn:aws:iam::111122223333:role/x").await.unwrap_err();
    assert!(err.contains("iam:GetRole"), "{err}");
    let err = read_trust(&iam.client(), "not-an-arn").await.unwrap_err();
    assert!(err.contains("해석하지 못했어요"));
    assert!(iam.sent().len() == 1, "ARN을 해석하지 못하면 부르지 않는다");
}

// ── 맞추기 ──

fn cluster(mode: Option<&str>) -> ClusterView {
    ClusterView {
        version: "1.31".into(),
        platform_version: None,
        status: None,
        endpoint_public: true,
        endpoint_private: false,
        public_cidrs: vec![],
        logging: vec![],
        secrets_encrypted: false,
        oidc_issuer: Some("https://oidc.eks.ap-northeast-2.amazonaws.com/id/ABCDEF".into()),
        authentication_mode: mode.map(str::to_string),
    }
}

fn entry(arn: &str) -> EntryInput {
    EntryInput { principal_arn: arn.into(), entry_type: None, username: Some("u".into()), groups: vec![], policies: vec![], read_error: None }
}

fn aws_auth() -> AwsAuth {
    let mut data = std::collections::BTreeMap::new();
    data.insert("mapRoles".to_string(), "- rolearn: arn:aws:iam::111122223333:role/legacy\n  username: legacy\n".to_string());
    parse_aws_auth(&data)
}

fn parts() -> Parts {
    Parts { cluster: Ok(cluster(Some("API_AND_CONFIG_MAP"))), entries: Ok(vec![entry(ADMIN)]), aws_auth: Ok(Some(aws_auth())), rbac: Ok(Rbac::default()), namespaces: Ok(vec!["a".into()]) }
}

#[test]
fn every_source_failing_shows_up_as_its_own_gap_and_the_rest_is_kept() {
    let loaded = assemble(Parts {
        cluster: Err(AppError::Throttled),
        entries: Err(AppError::AccessDenied { action: "eks:ListAccessEntries".into() }),
        aws_auth: Err(AppError::other("forbidden")),
        rbac: Err(AppError::other("rbac")),
        namespaces: Ok(vec!["a".into(), "b".into()]),
    });
    let sections: Vec<Section> = loaded.gaps.iter().map(|g| g.section).collect();
    assert_eq!(sections, vec![Section::Cluster, Section::AccessEntries, Section::AwsAuth, Section::Rbac]);
    assert_eq!(loaded.namespaces, vec!["a".to_string(), "b".to_string()]);
    assert!(!loaded.rbac_available && loaded.mappings.is_empty());
}

#[test]
fn a_missing_aws_auth_is_not_a_gap() {
    let loaded = assemble(Parts { aws_auth: Ok(None), ..parts() });
    assert!(loaded.gaps.is_empty());
    assert!(!loaded.aws_auth.present);
}

#[test]
fn the_authentication_mode_picks_the_effective_source() {
    for (mode, entry_on, auth_on) in [(Some("API"), true, false), (Some("CONFIG_MAP"), false, true), (None, false, true), (Some("API_AND_CONFIG_MAP"), true, true)] {
        let loaded = assemble(Parts { cluster: Ok(cluster(mode)), ..parts() });
        let on = |source: MappingSource| loaded.mappings.iter().any(|m| m.source == source && m.effective);
        assert_eq!((on(MappingSource::AccessEntry), on(MappingSource::AwsAuth)), (entry_on, auth_on), "{mode:?}");
    }
}

#[test]
fn without_the_mode_both_sources_are_trusted_and_the_cluster_gap_says_why() {
    let loaded = assemble(Parts { cluster: Err(AppError::other("boom")), ..parts() });
    assert!(loaded.mode.is_none());
    assert!(loaded.mappings.iter().all(|m| m.effective));
}

fn workload_parts() -> WorkloadParts {
    WorkloadParts {
        cluster: Ok(cluster(None)),
        service_accounts: Ok((vec![], false)),
        pods: Ok((vec![], false)),
        associations: Ok(vec![]),
        trusts: HashMap::new(),
    }
}

#[test]
fn workload_sources_fail_independently_and_a_cut_list_is_flagged() {
    let view = assemble_workload(WorkloadParts { service_accounts: Err(AppError::other("sa")), pods: Ok((vec![], true)), associations: Err(AppError::other("pi")), ..workload_parts() });
    assert_eq!(view.gaps.iter().map(|g| g.section).collect::<Vec<_>>(), vec![Section::ServiceAccounts, Section::PodIdentity]);
    assert!(view.truncated);
    assert_eq!(view.oidc_issuer.as_deref(), Some("https://oidc.eks.ap-northeast-2.amazonaws.com/id/ABCDEF"));
}

#[test]
fn without_a_readable_cluster_irsa_cannot_be_checked() {
    let sa = SaInfo { namespace: "a".into(), name: "b".into(), annotations: [(super::super::workload::IRSA_ANNOTATION.to_string(), "arn:aws:iam::1:role/r".to_string())].into() };
    let view = assemble_workload(WorkloadParts { cluster: Err(AppError::Throttled), service_accounts: Ok((vec![sa], false)), ..workload_parts() });
    assert!(matches!(view.items[0].irsa.as_ref().unwrap().check, Check::Unknown { .. }));
    assert_eq!(view.gaps[0].section, Section::Cluster);
}
