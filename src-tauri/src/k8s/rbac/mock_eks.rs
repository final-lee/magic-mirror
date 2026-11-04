//! 테스트용 EKS 클라이언트. 네트워크 대신 SDK가 실제로 만든 요청(메서드·경로·본문)을 기록하고, access entry를 메모리에 들고 있는 가짜 EKS처럼 답한다.
//! `iam/mock_aws.rs`와 같은 방식(REST JSON)이다. 쓰기 요청이 상태를 바꾸므로 "적용하고 다시 읽으면 그대로 보이는지", "되돌리면 처음과 같은지"를 확인할 수 있다.
//! 실제 AWS에는 닿지 않는다.
use std::collections::BTreeMap;
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

pub const CLUSTER: &str = "c";

/// 서버로 간 요청 하나. 경로는 퍼센트 인코딩을 푼 것이다.
#[derive(Clone, Debug, PartialEq)]
pub struct Sent {
    pub method: String,
    pub path: String,
    pub body: Value,
}

impl Sent {
    pub fn writes(&self) -> bool {
        self.method != "GET"
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoredEntry {
    pub groups: Vec<String>,
    pub username: String,
    pub kind: String,
    /// (정책 ARN, `accessScope` JSON)
    pub policies: Vec<(String, Value)>,
}

struct State {
    auth_mode: Option<String>,
    entries: BTreeMap<String, StoredEntry>,
    /// (메서드, 경로에 들어 있어야 하는 글, 상태 코드, 오류 종류): 맞는 요청은 이 오류로 답한다
    failures: Vec<(String, String, u16, String)>,
}

#[derive(Clone)]
pub struct FakeEks {
    state: Arc<Mutex<State>>,
    sent: Arc<Mutex<Vec<Sent>>>,
}

impl fmt::Debug for FakeEks {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("FakeEks")
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit() {
            out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}

fn not_found() -> (u16, Value, String) {
    (404, json!({"message": "No access entry found"}), "ResourceNotFoundException".into())
}

impl FakeEks {
    /// `auth_mode`가 None이면 access 설정이 없는 옛 클러스터(`CONFIG_MAP`으로 본다)
    pub fn new(auth_mode: Option<&str>) -> FakeEks {
        FakeEks { state: Arc::new(Mutex::new(State { auth_mode: auth_mode.map(str::to_string), entries: BTreeMap::new(), failures: vec![] })), sent: Arc::default() }
    }

    /// 이미 있는 access entry를 하나 넣는다(기본 사용자 이름, STANDARD)
    pub fn with_entry(self, arn: &str, groups: &[&str], policies: &[(&str, Value)]) -> FakeEks {
        let username = crate::k8s::rbac::eks::default_username(arn).unwrap();
        let entry = StoredEntry { groups: groups.iter().map(|g| g.to_string()).collect(), username, kind: "STANDARD".into(), policies: policies.iter().map(|(a, s)| (a.to_string(), s.clone())).collect() };
        self.state.lock().unwrap().entries.insert(arn.to_string(), entry);
        self
    }

    /// 이 메서드·경로 조각에 맞는 요청이 오면 이 오류로 답한다
    pub fn fail(&self, method: &str, path_part: &str, status: u16, error_type: &str) {
        self.state.lock().unwrap().failures.push((method.into(), path_part.into(), status, error_type.into()));
    }

    pub fn entries(&self) -> BTreeMap<String, StoredEntry> {
        self.state.lock().unwrap().entries.clone()
    }

    pub fn sent(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().clone()
    }

    /// 상태를 바꾸는 요청만
    pub fn writes(&self) -> Vec<Sent> {
        self.sent().into_iter().filter(Sent::writes).collect()
    }

    pub fn client(&self) -> aws_sdk_eks::Client {
        let config = aws_sdk_eks::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("ap-northeast-2"))
            .credentials_provider(Credentials::new("AKIDTEST", "secret", None, None, "test"))
            .http_client(SharedHttpClient::new(self.clone()))
            // 재시도가 켜져 있으면 일부러 실패시킨 요청이 여러 번 기록된다
            .retry_config(RetryConfig::disabled())
            .build();
        aws_sdk_eks::Client::from_conf(config)
    }

    fn respond(&self, method: &str, path: &str, body: &Value) -> (u16, Value, String) {
        let mut state = self.state.lock().unwrap();
        if let Some((_, _, status, kind)) = state.failures.iter().find(|(m, part, _, _)| m == method && path.contains(part.as_str())) {
            return (*status, json!({"message": "injected failure"}), kind.clone());
        }
        let prefix = format!("/clusters/{CLUSTER}");
        let Some(rest) = path.strip_prefix(&prefix) else { return not_found() };
        if rest.is_empty() {
            let mut cluster = json!({"name": CLUSTER, "version": "1.30", "status": "ACTIVE"});
            if let Some(mode) = &state.auth_mode {
                cluster["accessConfig"] = json!({"authenticationMode": mode});
            }
            return (200, json!({"cluster": cluster}), String::new());
        }
        let Some(rest) = rest.strip_prefix("/access-entries") else { return not_found() };
        if rest.is_empty() {
            return match method {
                "GET" => (200, json!({"accessEntries": state.entries.keys().collect::<Vec<_>>()}), String::new()),
                "POST" => {
                    let arn = body["principalArn"].as_str().unwrap_or_default().to_string();
                    if state.entries.contains_key(&arn) {
                        return (409, json!({"message": "exists"}), "ResourceInUseException".to_string());
                    }
                    let username = body["username"].as_str().map(str::to_string).or_else(|| crate::k8s::rbac::eks::default_username(&arn)).unwrap_or_default();
                    let groups = body["kubernetesGroups"].as_array().map(|a| a.iter().filter_map(|g| g.as_str().map(str::to_string)).collect()).unwrap_or_default();
                    let kind = body["type"].as_str().unwrap_or("STANDARD").to_string();
                    state.entries.insert(arn.clone(), StoredEntry { groups, username, kind, policies: vec![] });
                    (200, json!({"accessEntry": {"principalArn": arn}}), String::new())
                }
                _ => not_found(),
            };
        }
        let rest = rest.trim_start_matches('/');
        // `<주체 ARN>[/access-policies[/<정책 ARN>]]`: ARN에도 `/`가 있어서 `/access-policies`를 기준으로 가른다
        let (arn, tail) = match rest.split_once("/access-policies") {
            Some((arn, tail)) => (arn, Some(tail.trim_start_matches('/'))),
            None => (rest, None),
        };
        let Some(entry) = state.entries.get_mut(arn) else { return not_found() };
        match (method, tail) {
            ("GET", None) => (200, json!({"accessEntry": {"principalArn": arn, "kubernetesGroups": entry.groups, "username": entry.username, "type": entry.kind}}), String::new()),
            ("POST", None) => {
                entry.groups = body["kubernetesGroups"].as_array().map(|a| a.iter().filter_map(|g| g.as_str().map(str::to_string)).collect()).unwrap_or_default();
                (200, json!({"accessEntry": {"principalArn": arn}}), String::new())
            }
            ("DELETE", None) => {
                state.entries.remove(arn);
                (200, json!({}), String::new())
            }
            ("GET", Some("")) => {
                let policies: Vec<Value> = entry.policies.iter().map(|(policy, scope)| json!({"policyArn": policy, "accessScope": scope})).collect();
                (200, json!({"associatedAccessPolicies": policies}), String::new())
            }
            ("POST", Some("")) => {
                let policy = body["policyArn"].as_str().unwrap_or_default().to_string();
                entry.policies.retain(|(p, _)| *p != policy);
                entry.policies.push((policy, body["accessScope"].clone()));
                (200, json!({}), String::new())
            }
            ("DELETE", Some(policy)) => {
                let before = entry.policies.len();
                entry.policies.retain(|(p, _)| p != policy);
                if entry.policies.len() == before {
                    return not_found();
                }
                (200, json!({}), String::new())
            }
            _ => not_found(),
        }
    }
}

impl HttpConnector for FakeEks {
    fn call(&self, request: HttpRequest) -> HttpConnectorFuture {
        let uri = request.uri().to_string();
        let raw = uri.split_once("amazonaws.com").map_or(uri.clone(), |(_, rest)| rest.to_string());
        let path = percent_decode(raw.split('?').next().unwrap_or_default());
        let body = request.body().bytes().and_then(|b| serde_json::from_slice::<Value>(b).ok()).unwrap_or(Value::Null);
        let method = HttpRequest::method(&request).to_string();
        self.sent.lock().unwrap().push(Sent { method: method.clone(), path: path.clone(), body: body.clone() });
        let (status, value, error_type) = self.respond(&method, &path, &body);
        let mut response = HttpResponse::new(StatusCode::try_from(status).unwrap(), SdkBody::from(value.to_string()));
        response.headers_mut().insert("content-type", "application/json");
        if !error_type.is_empty() {
            response.headers_mut().insert("x-amzn-errortype", error_type);
        }
        HttpConnectorFuture::ready(Ok(response))
    }
}

impl HttpClient for FakeEks {
    fn http_connector(&self, _settings: &HttpConnectorSettings, _components: &RuntimeComponents) -> SharedHttpConnector {
        SharedHttpConnector::new(self.clone())
    }
}
