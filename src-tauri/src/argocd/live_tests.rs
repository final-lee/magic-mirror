//! 실제 ArgoCD 서버 시험. 평소에는 건너뛰며 scripts/argocd-live-test.sh로 직렬 실행한다.
//! ARGOCD_LIVE_URL과 ARGOCD_LIVE_TOKEN이 필요하다. 쓰기 시험은 개인 테스트 클러스터를 변경한다.
use super::{
    change::{self, ArgoChange, ArgoTarget},
    diff, events, history, logs,
    resource::{self, AppTarget, ResRef},
    stream::{self, Watch},
    *,
};
use reqwest::Method;
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::mpsc,
    time::{sleep, timeout},
};

const DEST: &str = "https://kubernetes.default.svc";
const NS: &str = "mm-live-argocd";

fn env(name: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| panic!("{name}이 필요해요. scripts/argocd-live-test.sh를 사용해 주세요"))
}
fn setup() -> (tempfile::TempDir, Arc<ArgocdState>, String) {
    let dir = tempfile::tempdir().unwrap();
    let url = env("ARGOCD_LIVE_URL");
    let state = Arc::new(ArgocdState::in_memory(dir.path().to_owned(), &url, env("ARGOCD_LIVE_TOKEN")));
    (dir, state, url)
}
async fn get(state: &ArgocdState, url: &str, name: &str, ns: &str, suffix: &[&str]) -> Value {
    let mut path = vec!["api", "v1", "applications", name];
    path.extend_from_slice(suffix);
    state.api(url, Method::GET, &path, &[("appNamespace", ns)], None).await.unwrap()
}
async fn apps(state: &ArgocdState, url: &str) -> Value {
    state.api(url, Method::GET, &["api", "v1", "applications"], &[], None).await.unwrap()
}
fn first_in_cluster(body: &Value) -> (&str, &str) {
    let app = list(body, "/items")
        .iter()
        .find(|a| text(a, "/spec/destination/server") == Some(DEST))
        .expect("in-cluster 앱이 하나 이상 필요해요");
    (
        text(app, "/metadata/name").filter(|s| !s.is_empty()).unwrap(),
        text(app, "/metadata/namespace").filter(|s| !s.is_empty()).unwrap(),
    )
}
async fn with_history(state: &ArgocdState, url: &str, name: &str, ns: &str, app: &Value) -> Vec<history::HistoryEntry> {
    let mut entries = history::entries_of(app);
    history::attach(&mut entries, |job| async move {
        let index = job.source_index.to_string();
        let version = job.version_id.to_string();
        state
            .api(
                url,
                Method::GET,
                &["api", "v1", "applications", name, "revisions", &job.revision_id, job.kind.segment()],
                &[("appNamespace", ns), ("sourceIndex", &index), ("versionId", &version)],
                None,
            )
            .await
    })
    .await;
    entries
}

// 실제 스트림의 줄 파서와 이벤트 기록기를 사용한다. 수신기는 종료 시 작업을 취소한다.
async fn watch(state: Arc<ArgocdState>, url: String, watch: Watch) -> (u64, mpsc::UnboundedReceiver<Value>) {
    let response = match &watch {
        Watch::Apps => state.open_stream(&url, &["api", "v1", "stream", "applications"], &[]).await,
        Watch::Tree { namespace, name } => {
            state
                .open_stream(&url, &["api", "v1", "stream", "applications", name, "resource-tree"], &[("appNamespace", namespace)])
                .await
        }
        Watch::Appsets => unreachable!(),
    }
    .unwrap();
    let (tx, rx) = mpsc::unbounded_channel();
    let id = state.next_stream_id();
    let task_state = state.clone();
    let task = tokio::spawn(async move {
        let mut response = response;
        let mut pending = Vec::new();
        loop {
            let bytes = match response.chunk().await {
                Ok(Some(b)) => b,
                Ok(None) => {
                    let _ = tx.send(json!({"type":"end"}));
                    break;
                }
                Err(e) => {
                    let _ = tx.send(json!({"type":"error", "message":e.to_string()}));
                    break;
                }
            };
            pending.extend_from_slice(&bytes);
            while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                let line: Vec<_> = pending.drain(..=end).collect();
                let result = stream::parse(&line).and_then(|v| match v {
                    Some(v) => stream::messages(&task_state, &url, &watch, &v),
                    None => Ok(vec![]),
                });
                match result {
                    Ok(messages) => {
                        for message in messages {
                            if tx.send(message).is_err() {
                                return;
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(json!({"type":"error", "message":e.to_string()}));
                        return;
                    }
                }
            }
            assert!(pending.len() <= 10 * 1024 * 1024);
        }
    });
    state.track_stream(id, task.abort_handle());
    (id, rx)
}
async fn receive(rx: &mut mpsc::UnboundedReceiver<Value>, kind: &str, name: Option<&str>) {
    timeout(Duration::from_secs(20), async {
        loop {
            let value = rx.recv().await.expect("스트림이 끝났어요");
            assert_ne!(value["type"], "error", "{value}");
            assert_ne!(value["type"], "end", "스트림이 끝났어요");
            if value["type"] == kind && name.is_none_or(|n| value.pointer("/row/name").and_then(Value::as_str) == Some(n)) {
                break;
            }
        }
    })
    .await
    .expect("스트림 수신 시간 초과");
}

#[tokio::test]
#[ignore]
async fn read_server_and_streams() {
    let (_dir, state, url) = setup();
    let session = state.session(&url).await.unwrap().unwrap();
    assert!(!session.username.is_empty() && !session.version.is_empty());
    let body = apps(&state, &url).await;
    for app in list(&body, "/items") {
        let row = app_row(app);
        assert!(!row.name.is_empty());
        let _ = serde_json::to_value((&row.resources, &row.images)).unwrap();
    }
    let sets = state.api(&url, Method::GET, &["api", "v1", "applicationsets"], &[], None).await.unwrap();
    for set in list(&sets, "/items") {
        assert!(!appset_row(set).name.is_empty());
    }
    let (name, ns) = first_in_cluster(&body);
    let app = get(&state, &url, name, ns, &[]).await;
    let _ = argo_app_of(&app);
    let tree = get(&state, &url, name, ns, &["resource-tree"]).await;
    for node in list(&tree, "/nodes").iter().chain(list(&tree, "/orphanedNodes")) {
        let _ = tree_node(node);
    }
    let managed = get(&state, &url, name, ns, &["managed-resources"]).await;
    diff::app_diff(&managed, &app).unwrap();
    with_history(&state, &url, name, ns, &app).await;
    window::sync_windows_of(&get(&state, &url, name, ns, &["syncwindows"]).await);
    let links = state
        .api(&url, Method::GET, &["api", "v1", "applications", name, "links"], &[("namespace", ns)], None)
        .await
        .unwrap();
    resource::link_rows(&links);
    let object = format!("{}/{}", text(&app, "/spec/project").unwrap_or("default"), name);
    for action in ["get", "sync"] {
        let can = state
            .api(&url, Method::GET, &["api", "v1", "account", "can-i", "applications", action, &object], &[], None)
            .await
            .unwrap();
        assert!(can.get("value").and_then(Value::as_str).is_some());
    }
    state.api(&url, Method::GET, &["api", "v1", "settings"], &[], None).await.unwrap();
    let (id, mut rx) = watch(state.clone(), url.clone(), Watch::Apps).await;
    receive(&mut rx, "upsert", None).await;
    state.stop_stream(id);
    let (id, mut rx) = watch(
        state.clone(),
        url.clone(),
        Watch::Tree {
            namespace: ns.into(),
            name: name.into(),
        },
    )
    .await;
    receive(&mut rx, "tree", None).await;
    state.stop_stream(id);
    let mut catalog = Vec::new();
    for kind in ["services", "triggers", "templates"] {
        match state.api(&url, Method::GET, &["api", "v1", "notifications", kind], &[], None).await {
            Ok(value) => catalog.push(value),
            Err(error) => {
                let message = error.to_string().to_lowercase();
                assert!(
                    ["404", "403", "not found", "permission", "forbidden", "denied", "권한"].iter().any(|s| message.contains(s)),
                    "알림 카탈로그: {error}"
                );
            }
        }
    }
    if let [services, triggers, templates] = catalog.as_slice() {
        notify::catalog(services, triggers, templates);
    }
}

// 생성 요청이 서버에 도달한 뒤 실패하거나 panic이 나도 별도 스레드에서 삭제를 시도한다.
struct Cleanup {
    state: Arc<ArgocdState>,
    url: String,
    target: ArgoTarget,
    armed: bool,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let state = self.state.clone();
        let url = self.url.clone();
        let target = self.target.clone();
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async {
                if let Err(e) = state
                    .api(
                        &url,
                        Method::DELETE,
                        &["api", "v1", "applications", &target.name],
                        &[("appNamespace", &target.namespace), ("cascade", "true")],
                        None,
                    )
                    .await
                {
                    eprintln!("정리 삭제 요청 실패: {e}");
                }
            });
        })
        .join();
    }
}
async fn apply(state: &ArgocdState, url: &str, target: &ArgoTarget, change: &ArgoChange) {
    let p = change::preview(state, url, target, change).await.unwrap();
    assert!(p.blocked.is_none(), "{:?}", p.blocked);
    change::apply(state, url, target, change, p.expected_version, p.confirm_name).await.unwrap();
}
fn sync(dry_run: bool) -> ArgoChange {
    ArgoChange::Sync {
        revision: None,
        resources: None,
        prune: true,
        dry_run,
        apply_only: false,
        force: false,
        server_side_apply: false,
        replace: false,
        prune_last: false,
        create_namespace: true,
        apply_out_of_sync_only: false,
        respect_ignore_differences: false,
        retry: None,
    }
}
async fn wait_operation(state: &ArgocdState, url: &str, t: &ArgoTarget, healthy: bool) -> Value {
    timeout(Duration::from_secs(300), async {
        loop {
            let app = get(state, url, &t.name, &t.namespace, &[]).await;
            let phase = text(&app, "/status/operationState/phase");
            assert!(
                !matches!(phase, Some("Failed" | "Error")),
                "동기화 실패: {:?}",
                app.pointer("/status/operationState/message")
            );
            if phase == Some("Succeeded") && (!healthy || text(&app, "/status/health/status") == Some("Healthy")) {
                return app;
            }
            sleep(Duration::from_secs(3)).await;
        }
    })
    .await
    .expect("동기화 대기 시간 초과")
}
async fn live_resource(state: &ArgocdState, url: &str, target: &AppTarget, res: &ResRef) -> Value {
    let body = state
        .api(
            url,
            Method::GET,
            &["api", "v1", "applications", &target.name, "resource"],
            &resource::resource_query(target, res, "resourceName"),
            None,
        )
        .await
        .unwrap();
    serde_json::from_str(body["manifest"].as_str().unwrap()).unwrap()
}
// ArgoCD는 없는 앱을 읽으면 404가 아니라 permission denied로 답하므로 목록의 이름 필터로 확인한다.
async fn app_exists(state: &ArgocdState, url: &str, name: &str, namespace: &str) -> bool {
    let body = state
        .api(url, Method::GET, &["api", "v1", "applications"], &[("name", name), ("appNamespace", namespace)], None)
        .await
        .unwrap();
    super::list(&body, "/items").iter().any(|a| text(a, "/metadata/name") == Some(name))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn write_podinfo_and_cleanup() {
    let (_dir, state, url) = setup();
    let existing = apps(&state, &url).await;
    let (_, app_ns) = first_in_cluster(&existing);
    let name = format!("mm-live-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs());
    let t = ArgoTarget {
        namespace: app_ns.into(),
        name: name.clone(),
        project: "default".into(),
        env: None,
    };
    assert!(!app_exists(&state, &url, &name, app_ns).await, "이미 존재하는 앱은 건드리지 않아요");
    let mut cleanup = Cleanup {
        state: state.clone(),
        url: url.clone(),
        target: t.clone(),
        armed: true,
    };
    let app = json!({"apiVersion":"argoproj.io/v1alpha1", "kind":"Application", "metadata":{"name":name,"namespace":app_ns,"annotations":{"mm-live/password":"password"}}, "spec":{"project":"default", "source":{"repoURL":"https://github.com/stefanprodan/podinfo", "path":"kustomize", "targetRevision":"HEAD"}, "destination":{"server":DEST,"namespace":NS}, "syncPolicy":{"syncOptions":["CreateNamespace=true"]}}});
    let create = ArgoChange::AppCreate {
        yaml: app.to_string(),
        upsert: false,
    };
    apply(&state, &url, &t, &create).await;
    let (stream_id, mut rx) = watch(state.clone(), url.clone(), Watch::Apps).await;
    receive(&mut rx, "upsert", Some(&name)).await;
    apply(&state, &url, &t, &sync(true)).await;
    wait_operation(&state, &url, &t, false).await;
    apply(&state, &url, &t, &sync(false)).await;
    let app = wait_operation(&state, &url, &t, true).await;
    let managed = get(&state, &url, &name, app_ns, &["managed-resources"]).await;
    let rows = diff::app_diff(&managed, &app).unwrap();
    assert!(!rows.is_empty() && rows.iter().all(|r| !r.changed), "동기화 뒤 diff: {rows:?}");
    assert!(!with_history(&state, &url, &name, app_ns, &app).await.is_empty());
    timeout(Duration::from_secs(20), async {
        loop {
            if events::read(&state, &url, None)
                .iter()
                .any(|e| e.app == name && e.kind == "operation" && e.phase.as_deref() == Some("Succeeded"))
            {
                break;
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("동기화 이벤트가 기록되지 않았어요");
    let target = AppTarget {
        namespace: app_ns.into(),
        name: name.clone(),
        project: "default".into(),
    };
    let deployment = rows.iter().find(|r| r.res.kind == "Deployment").expect("Deployment 없음").res.clone();
    assert!(!live_resource(&state, &url, &target, &deployment).await.is_null());
    let item = diff::find_item(&managed, &deployment).expect("관리 Deployment 없음");
    assert!(diff::desired_yaml(item).unwrap().is_some());
    assert!(!resource::containers_of(&live_resource(&state, &url, &target, &deployment).await).is_empty());
    let tree = get(&state, &url, &name, app_ns, &["resource-tree"]).await;
    let pod = list(&tree, "/nodes")
        .iter()
        .find(|n| text(n, "/kind") == Some("Pod"))
        .and_then(|n| text(n, "/name"))
        .expect("Pod 없음");
    let options = logs::LogOptions {
        pod_name: Some(pod.into()),
        container: None,
        kind: None,
        group: None,
        resource_name: None,
        namespace: NS.into(),
        follow: false,
        previous: false,
        tail_lines: Some(5),
        since_seconds: None,
    };
    let query = logs::query(&target, &options);
    let refs: Vec<_> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let mut response = state.open_stream(&url, &["api", "v1", "applications", &name, "logs"], &refs).await.unwrap();
    let mut pending = Vec::new();
    timeout(Duration::from_secs(30), async {
        while let Some(chunk) = response.chunk().await.unwrap() {
            pending.extend_from_slice(&chunk);
            for line in logs::take_lines(&mut pending, false) {
                logs::parse_line(&line).unwrap();
            }
        }
        for line in logs::take_lines(&mut pending, true) {
            logs::parse_line(&line).unwrap();
        }
    })
    .await
    .expect("로그 대기 시간 초과");
    let actions = state
        .api(
            &url,
            Method::GET,
            &["api", "v1", "applications", &name, "resource", "actions"],
            &resource::resource_query(&target, &deployment, "resourceName"),
            None,
        )
        .await
        .unwrap();
    assert!(ops::action_rows(&actions).iter().any(|a| a.name == "restart"));
    apply(
        &state,
        &url,
        &t,
        &ArgoChange::ResourceAction {
            res: deployment.clone(),
            action: "restart".into(),
            params: vec![],
        },
    )
    .await;
    apply(
        &state,
        &url,
        &t,
        &ArgoChange::AppPatch {
            patch: json!({"metadata":{"annotations":{"mm-live/touched":"yes"}}}),
        },
    )
    .await;
    assert_eq!(text(&get(&state, &url, &name, app_ns, &[]).await, "/metadata/annotations/mm-live~1touched"), Some("yes"));
    apply(
        &state,
        &url,
        &t,
        &ArgoChange::ResourcePatch {
            res: deployment.clone(),
            patch: json!({"metadata":{"labels":{"mm-live-touched":"yes"}}}).to_string(),
            patch_type: "merge".into(),
        },
    )
    .await;
    assert_eq!(
        text(&live_resource(&state, &url, &target, &deployment).await, "/metadata/labels/mm-live-touched"),
        Some("yes")
    );
    let patch = ArgoChange::AppPatch {
        patch: json!({"metadata":{"annotations":{"mm-live/stale":"no"}}}),
    };
    assert!(change::apply(&state, &url, &t, &patch, Some("wrong-version".into()), None).await.is_err());
    let delete = ArgoChange::AppDelete {
        cascade: true,
        propagation_policy: None,
    };
    let p = change::preview(&state, &url, &t, &delete).await.unwrap();
    assert!(change::apply(&state, &url, &t, &delete, p.expected_version, Some("wrong-name".into())).await.is_err());
    apply(&state, &url, &t, &delete).await;
    timeout(Duration::from_secs(180), async {
        while app_exists(&state, &url, &name, app_ns).await {
            sleep(Duration::from_secs(3)).await;
        }
    })
    .await
    .expect("삭제 대기 시간 초과");
    cleanup.armed = false;
    state.stop_stream(stream_id);
    let records = change::changes(&state, &url);
    assert!(records.iter().any(|r| r.name == name && r.ok));
    for record in records {
        for call in record.calls {
            assert!(!call.body.map(|v| v.to_string()).unwrap_or_default().contains("password"));
        }
    }
}

/// ArgoCD가 도는 클러스터의 kube context(`ARGOCD_LIVE_KUBE_CONTEXT`)가 있을 때만: 네 컴포넌트 지표를 service proxy로 두 번 읽고,
/// in-cluster 앱 하나의 Pod 사용량을 metrics-server에서 읽는다. 모두 읽기 전용이다.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn controller_metrics_and_pod_usage() {
    let Some(context) = std::env::var("ARGOCD_LIVE_KUBE_CONTEXT").ok().filter(|s| !s.is_empty()) else {
        eprintln!("ARGOCD_LIVE_KUBE_CONTEXT가 없어 건너뛰어요");
        return;
    };
    let settings = std::path::PathBuf::from(env("HOME")).join("Library/Application Support/dev.finallee.magicmirror/settings.json");
    let kube = super::cluster::ArgoKube::default();
    let first = kube.controller_metrics(&settings, &context, "argocd", 0).await.unwrap();
    for c in &first.components {
        assert!(c.ok, "{} 지표를 읽지 못했어요: {:?}", c.service, c.error);
    }
    assert!(!first.series.is_empty());
    let second = kube.controller_metrics(&settings, &context, "argocd", 30_000).await.unwrap();
    assert!(second.components.iter().all(|c| c.interval_ms == Some(30_000)));

    let (_dir, state, url) = setup();
    let body = apps(&state, &url).await;
    let mut pods: Vec<super::usage::PodRef> = Vec::new();
    for app in list(&body, "/items").iter().filter(|a| text(a, "/spec/destination/server") == Some(DEST)).take(15) {
        let (name, ns) = (text(app, "/metadata/name").unwrap_or_default(), text(app, "/metadata/namespace").unwrap_or_default());
        let tree = get(&state, &url, name, ns, &["resource-tree"]).await;
        pods = list(&tree, "/nodes")
            .iter()
            .filter(|n| text(n, "/kind") == Some("Pod"))
            .map(|n| super::usage::PodRef {
                namespace: text(n, "/namespace").unwrap_or_default().into(),
                name: text(n, "/name").unwrap_or_default().into(),
            })
            .collect();
        if !pods.is_empty() {
            break;
        }
    }
    assert!(!pods.is_empty(), "Pod가 있는 in-cluster 앱을 찾지 못했어요");
    let client = kube.client(&settings, &context).await.unwrap();
    let usage = super::usage::read_usage(&client, &pods).await.unwrap();
    assert!(usage.unavailable.is_none(), "{:?}", usage.unavailable);
    assert_eq!(usage.pods.len(), pods.len());
    assert!(usage.pods.iter().any(|p| p.cpu_milli.is_some()));
}
