//! 테스트용 가짜 쿠버네티스 API 서버(RBAC 부분). 바인딩과 ClusterRole을 메모리에 들고 목록·읽기·만들기·병합 patch·지우기에 답한다.
//! 리소스 버전 조건이 틀리면 409로 거절하고, `dryRun`이 붙은 쓰기는 상태를 바꾸지 않는다. 실제 클러스터는 kind 시험(`live_tests::rbac`)이 맡는다.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use kube::config::Kubeconfig;
use kube::Client;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::k8s::connect::client_for;
use crate::k8s::failure::Endpoint;
use crate::k8s::tls::install_crypto_provider;

pub const PUBLIC: Endpoint = Endpoint { public: true, private: false };

/// 서버로 간 요청 하나
#[derive(Clone, Debug, PartialEq)]
pub struct Sent {
    pub method: String,
    /// 질의를 뗀 경로
    pub path: String,
    pub dry_run: bool,
    pub body: Value,
}

#[derive(Default)]
struct Store {
    /// 키: (복수형 리소스 이름, 네임스페이스, 이름)
    bindings: BTreeMap<(String, String, String), Value>,
    cluster_roles: Vec<Value>,
    next_version: u64,
    sent: Vec<Sent>,
    /// (메서드, 경로에 들어 있어야 하는 글, 상태 코드): 맞는 요청은 이 오류로 답한다
    failures: Vec<(String, String, u16)>,
    /// SelfSubjectReview가 돌려줄 신원(사용자 이름, 그룹, IAM ARN)
    identity: Option<(String, Vec<String>, Option<String>)>,
}

#[derive(Clone)]
pub struct FakeKube {
    store: Arc<Mutex<Store>>,
}

fn status(code: u16, reason: &str) -> (u16, Value) {
    (code, json!({"kind": "Status", "apiVersion": "v1", "status": "Failure", "message": format!("{reason} (fake)"), "reason": reason, "code": code}))
}

/// 병합 patch(RFC 7386)
fn merge(target: &mut Value, patch: &Value) {
    match (target.as_object_mut(), patch.as_object()) {
        (Some(object), Some(changes)) => {
            for (key, value) in changes {
                if value.is_null() {
                    object.remove(key);
                } else {
                    merge(object.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
        _ => *target = patch.clone(),
    }
}

impl FakeKube {
    /// 가짜 서버를 띄우고 그 서버를 가리키는 클라이언트와 함께 돌려준다. `cluster_roles`는 이름과 규칙을 담은 ClusterRole 객체들이다.
    pub async fn start(cluster_roles: Vec<Value>) -> (FakeKube, Client) {
        install_crypto_provider();
        let fake = FakeKube { store: Arc::new(Mutex::new(Store { cluster_roles, next_version: 100, ..Store::default() })) };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = fake.clone();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let server = server.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0u8; 8192];
                    let (head, body) = loop {
                        let n = socket.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&request).to_string();
                        let Some((head, rest)) = text.split_once("\r\n\r\n") else { continue };
                        let length = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                        if rest.len() >= length {
                            break (head.to_string(), rest.to_string());
                        }
                    };
                    let line = head.lines().next().unwrap_or_default().to_string();
                    let mut parts = line.split_whitespace();
                    let (method, target) = (parts.next().unwrap_or_default().to_string(), parts.next().unwrap_or_default().to_string());
                    let (code, value) = server.handle(&method, &target, &body);
                    let text = value.to_string();
                    let reply = format!("HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
        let config = Kubeconfig::from_yaml(&format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {{ server: \"http://127.0.0.1:{port}\" }}\ncontexts:\n- name: ctx\n  context: {{ cluster: c, user: u }}\nusers:\n- name: u\n  user: {{ token: t }}\n"
        ))
        .unwrap();
        let client = client_for(&config, "ctx", PUBLIC).await.unwrap();
        (fake, client)
    }

    /// 클러스터에 이미 있는 바인딩을 넣는다(리소스 버전은 서버가 정한다)
    pub fn put(&self, object: Value) {
        let mut store = self.store.lock().unwrap();
        let plural = if object["kind"] == "RoleBinding" { "rolebindings" } else { "clusterrolebindings" };
        let key = (plural.to_string(), object["metadata"]["namespace"].as_str().unwrap_or_default().to_string(), object["metadata"]["name"].as_str().unwrap().to_string());
        let mut object = object;
        store.next_version += 1;
        object["metadata"]["resourceVersion"] = json!(store.next_version.to_string());
        object["metadata"]["uid"] = json!(format!("uid-{}", store.next_version));
        store.bindings.insert(key, object);
    }

    /// 지금 클러스터에 있는 바인딩(없으면 None)
    pub fn get(&self, plural: &str, namespace: &str, name: &str) -> Option<Value> {
        self.store.lock().unwrap().bindings.get(&(plural.to_string(), namespace.to_string(), name.to_string())).cloned()
    }

    pub fn subjects_of(&self, plural: &str, namespace: &str, name: &str) -> Vec<Value> {
        self.get(plural, namespace, name).and_then(|o| o["subjects"].as_array().cloned()).unwrap_or_default()
    }

    pub fn set_identity(&self, username: &str, groups: &[&str], arn: Option<&str>) {
        self.store.lock().unwrap().identity = Some((username.to_string(), groups.iter().map(|g| g.to_string()).collect(), arn.map(str::to_string)));
    }

    pub fn fail(&self, method: &str, path_part: &str, code: u16) {
        self.store.lock().unwrap().failures.push((method.into(), path_part.into(), code));
    }

    /// 지금까지 간 요청. 읽기(GET)와 SelfSubjectReview는 뺀 쓰기만 보려면 `writes`.
    pub fn sent(&self) -> Vec<Sent> {
        self.store.lock().unwrap().sent.clone()
    }

    /// 상태를 바꾸려는 요청(dry-run 포함)
    pub fn writes(&self) -> Vec<Sent> {
        self.sent().into_iter().filter(|s| s.method != "GET" && !s.path.contains("selfsubjectreviews")).collect()
    }

    /// 실제로 상태를 바꾼 요청만(dry-run이 아닌 쓰기)
    pub fn applied(&self) -> Vec<Sent> {
        self.writes().into_iter().filter(|s| !s.dry_run).collect()
    }

    /// 다른 사람이 그 사이 바인딩을 고친 것처럼 바꾼다(리소스 버전이 올라간다)
    pub fn tamper(&self, plural: &str, namespace: &str, name: &str, change: impl FnOnce(&mut Value)) {
        let mut store = self.store.lock().unwrap();
        store.next_version += 1;
        let version = store.next_version.to_string();
        let object = store.bindings.get_mut(&(plural.to_string(), namespace.to_string(), name.to_string())).unwrap();
        change(object);
        object["metadata"]["resourceVersion"] = json!(version);
    }

    fn handle(&self, method: &str, target: &str, raw: &str) -> (u16, Value) {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let body: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        let dry_run = query.contains("dryRun") || body.get("dryRun").is_some();
        let mut store = self.store.lock().unwrap();
        store.sent.push(Sent { method: method.into(), path: path.into(), dry_run, body: body.clone() });
        if let Some((_, _, code)) = store.failures.iter().find(|(m, part, _)| m == method && path.contains(part.as_str())) {
            return status(*code, if *code == 403 { "Forbidden" } else { "InternalError" });
        }
        if path.contains("selfsubjectreviews") {
            let (user, groups, arn) = store.identity.clone().unwrap_or_default();
            let extra = arn.map_or(json!({}), |arn| json!({"arn": [arn]}));
            return (201, json!({"kind": "SelfSubjectReview", "apiVersion": "authentication.k8s.io/v1", "status": {"userInfo": {"username": user, "groups": groups, "extra": extra}}}));
        }
        if path.starts_with("/api/v1/namespaces/kube-system/configmaps/aws-auth") {
            return status(404, "NotFound");
        }
        let Some(rest) = path.strip_prefix("/apis/rbac.authorization.k8s.io/v1/") else { return status(404, "NotFound") };
        let segments: Vec<&str> = rest.split('/').collect();
        // 목록: `rolebindings`, `clusterrolebindings`, `roles`, `clusterroles`(모든 네임스페이스)
        if segments.len() == 1 && method == "GET" {
            let items: Vec<Value> = match segments[0] {
                "clusterroles" => store.cluster_roles.clone(),
                "rolebindings" | "clusterrolebindings" => store.bindings.iter().filter(|((plural, _, _), _)| plural == segments[0]).map(|(_, v)| v.clone()).collect(),
                _ => vec![],
            };
            return (200, json!({"kind": "List", "apiVersion": "v1", "metadata": {}, "items": items}));
        }
        let (plural, namespace, name) = match segments.as_slice() {
            ["namespaces", ns, plural, name] => (*plural, *ns, Some(*name)),
            ["namespaces", ns, plural] => (*plural, *ns, None),
            [plural, name] => (*plural, "", Some(*name)),
            [plural] => (*plural, "", None),
            _ => return status(404, "NotFound"),
        };
        if plural != "rolebindings" && plural != "clusterrolebindings" {
            return status(404, "NotFound");
        }
        let key = |name: &str| (plural.to_string(), namespace.to_string(), name.to_string());
        match (method, name) {
            ("GET", Some(name)) => store.bindings.get(&key(name)).map_or_else(|| status(404, "NotFound"), |o| (200, o.clone())),
            ("POST", None) => {
                let name = body["metadata"]["name"].as_str().unwrap_or_default().to_string();
                if store.bindings.contains_key(&key(&name)) {
                    return status(409, "AlreadyExists");
                }
                let mut object = body.clone();
                store.next_version += 1;
                object["metadata"]["resourceVersion"] = json!(store.next_version.to_string());
                object["metadata"]["uid"] = json!(format!("uid-{}", store.next_version));
                if !dry_run {
                    store.bindings.insert(key(&name), object.clone());
                }
                (201, object)
            }
            ("PATCH", Some(name)) => {
                let Some(current) = store.bindings.get(&key(name)).cloned() else { return status(404, "NotFound") };
                let mut patch = body.clone();
                let wanted = patch["metadata"].as_object_mut().and_then(|m| m.remove("resourceVersion"));
                if wanted.is_some_and(|v| v != current["metadata"]["resourceVersion"]) {
                    return status(409, "Conflict");
                }
                let mut object = current;
                merge(&mut object, &patch);
                store.next_version += 1;
                object["metadata"]["resourceVersion"] = json!(store.next_version.to_string());
                if !dry_run {
                    store.bindings.insert(key(name), object.clone());
                }
                (200, object)
            }
            ("DELETE", Some(name)) => {
                let Some(current) = store.bindings.get(&key(name)).cloned() else { return status(404, "NotFound") };
                let wanted = &body["preconditions"]["resourceVersion"];
                if !wanted.is_null() && *wanted != current["metadata"]["resourceVersion"] {
                    return status(409, "Conflict");
                }
                if !dry_run {
                    store.bindings.remove(&key(name));
                }
                (200, current)
            }
            _ => status(405, "MethodNotAllowed"),
        }
    }
}
