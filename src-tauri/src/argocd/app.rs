//! 서버 Application 상세 파싱.
use serde::Serialize;
use serde_json::Value;

use super::{app_set, list, text};

/// Application의 배포 대상.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoDestination {
    pub server: Option<String>,
    pub name: Option<String>,
    pub namespace: Option<String>,
    /// 기본 Kubernetes API 서버 또는 `in-cluster` 이름이면 현재 클러스터다.
    pub in_cluster: bool,
}

/// Git 저장소 또는 Helm 차트 소스.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoSource {
    pub repo_url: String,
    pub path: Option<String>,
    pub chart: Option<String>,
    pub target_revision: Option<String>,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub helm_value_files: Vec<String>,
}

/// 자동 동기화와 동기화 옵션.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoSyncPolicy {
    pub automated: bool,
    pub prune: bool,
    pub self_heal: bool,
    pub options: Vec<String>,
}

/// 컨트롤러가 보고한 조건.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoCondition {
    pub r#type: String,
    pub message: String,
    pub last_transition_time: Option<String>,
}

/// 동기화 결과에 포함된 리소스.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoResourceResult {
    pub group: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub status: Option<String>,
    pub message: Option<String>,
    pub hook_phase: Option<String>,
}

/// 최근 동기화 작업의 상태.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoOperation {
    pub phase: Option<String>,
    pub message: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub initiated_by: Option<String>,
    pub revisions: Vec<String>,
    /// Synced가 아닌 결과만 최대 100개.
    pub failed_results: Vec<ArgoResourceResult>,
}

/// Application이 관리하는 리소스.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoResource {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub status: Option<String>,
    pub hook: bool,
    pub requires_pruning: bool,
}

/// 배포 이력 한 건.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoHistory {
    pub id: i64,
    pub revisions: Vec<String>,
    pub deployed_at: Option<String>,
    pub deploy_started_at: Option<String>,
    pub initiated_by: Option<String>,
}

/// Application의 상세 상태.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoApp {
    /// 서버가 반환한 Application 원본.
    pub raw: Value,
    pub name: String,
    pub namespace: String,
    pub project: Option<String>,
    pub destination: ArgoDestination,
    pub sources: Vec<ArgoSource>,
    pub sync_policy: ArgoSyncPolicy,
    pub sync_status: Option<String>,
    pub sync_revisions: Vec<String>,
    pub health: Option<String>,
    pub health_message: Option<String>,
    pub images: Vec<String>,
    pub conditions: Vec<ArgoCondition>,
    pub operation: Option<ArgoOperation>,
    pub resources: Vec<ArgoResource>,
    /// 배포 번호 내림차순으로 최대 20개.
    pub history: Vec<ArgoHistory>,
    pub app_set: Option<String>,
    pub reconciled_at: Option<String>,
    /// 컨트롤러가 아직 처리하지 않은 새로고침 요청.
    pub refresh_requested: Option<String>,
    /// 작업 상태가 Running이면 true.
    pub operation_in_progress: bool,
}

fn opt(v: &Value, path: &str) -> Option<String> {
    text(v, path).map(str::to_owned)
}

fn string(v: &Value, path: &str) -> String {
    opt(v, path).unwrap_or_default()
}

fn boolean(v: &Value, path: &str) -> bool {
    v.pointer(path).and_then(Value::as_bool).unwrap_or(false)
}

fn strings(v: &Value, path: &str) -> Vec<String> {
    list(v, path)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn revisions(v: &Value) -> Vec<String> {
    let multi = strings(v, "/revisions");
    if multi.is_empty() {
        opt(v, "/revision").into_iter().collect()
    } else {
        multi
    }
}

fn initiated(v: &Value, path: &str) -> Option<String> {
    let by = v.pointer(path)?;
    if boolean(by, "/automated") {
        Some("automated".into())
    } else {
        opt(by, "/username")
    }
}

fn source(v: &Value) -> ArgoSource {
    ArgoSource {
        repo_url: string(v, "/repoURL"),
        path: opt(v, "/path"),
        chart: opt(v, "/chart"),
        target_revision: opt(v, "/targetRevision"),
        reference: opt(v, "/ref"),
        helm_value_files: strings(v, "/helm/valueFiles"),
    }
}

/// API 객체에서 화면에 필요한 Application 상세를 만든다.
pub fn argo_app_of(d: &Value) -> ArgoApp {
    let server = opt(d, "/spec/destination/server");
    let name = opt(d, "/spec/destination/name");
    let in_cluster = server.as_deref() == Some("https://kubernetes.default.svc")
        || name.as_deref() == Some("in-cluster");
    let mut sources: Vec<_> = list(d, "/spec/sources").iter().map(source).collect();
    if let Some(s) = d.pointer("/spec/source").filter(|s| s.is_object()) {
        sources.insert(0, source(s));
    }
    let operation = d
        .pointer("/status/operationState")
        .filter(|v| v.is_object())
        .map(|o| ArgoOperation {
            phase: opt(o, "/phase"),
            message: opt(o, "/message"),
            started_at: opt(o, "/startedAt"),
            finished_at: opt(o, "/finishedAt"),
            initiated_by: initiated(o, "/operation/initiatedBy"),
            revisions: o.pointer("/syncResult").map(revisions).unwrap_or_default(),
            failed_results: list(o, "/syncResult/resources")
                .iter()
                .filter(|r| text(r, "/status") != Some("Synced"))
                .take(100)
                .map(|r| ArgoResourceResult {
                    group: string(r, "/group"),
                    kind: string(r, "/kind"),
                    namespace: opt(r, "/namespace"),
                    name: string(r, "/name"),
                    status: opt(r, "/status"),
                    message: opt(r, "/message"),
                    hook_phase: opt(r, "/hookPhase"),
                })
                .collect(),
        });
    let mut history: Vec<_> = list(d, "/status/history")
        .iter()
        .map(|h| ArgoHistory {
            id: h.pointer("/id").and_then(Value::as_i64).unwrap_or_default(),
            revisions: revisions(h),
            deployed_at: opt(h, "/deployedAt"),
            deploy_started_at: opt(h, "/deployStartedAt"),
            initiated_by: initiated(h, "/initiatedBy"),
        })
        .collect();
    history.sort_by_key(|h| std::cmp::Reverse(h.id));
    history.truncate(20);
    ArgoApp {
        raw: d.clone(),
        name: string(d, "/metadata/name"),
        namespace: string(d, "/metadata/namespace"),
        project: opt(d, "/spec/project"),
        destination: ArgoDestination {
            server,
            name,
            namespace: opt(d, "/spec/destination/namespace"),
            in_cluster,
        },
        sources,
        sync_policy: ArgoSyncPolicy {
            automated: d
                .pointer("/spec/syncPolicy/automated")
                .is_some_and(|v| !v.is_null()),
            prune: boolean(d, "/spec/syncPolicy/automated/prune"),
            self_heal: boolean(d, "/spec/syncPolicy/automated/selfHeal"),
            options: strings(d, "/spec/syncPolicy/syncOptions"),
        },
        sync_status: opt(d, "/status/sync/status"),
        sync_revisions: d.pointer("/status/sync").map(revisions).unwrap_or_default(),
        health: opt(d, "/status/health/status"),
        health_message: opt(d, "/status/health/message"),
        images: strings(d, "/status/summary/images"),
        conditions: list(d, "/status/conditions")
            .iter()
            .map(|c| ArgoCondition {
                r#type: string(c, "/type"),
                message: string(c, "/message"),
                last_transition_time: opt(c, "/lastTransitionTime"),
            })
            .collect(),
        operation,
        resources: list(d, "/status/resources")
            .iter()
            .map(|r| ArgoResource {
                group: string(r, "/group"),
                version: string(r, "/version"),
                kind: string(r, "/kind"),
                namespace: opt(r, "/namespace"),
                name: string(r, "/name"),
                status: opt(r, "/status"),
                hook: boolean(r, "/hook"),
                requires_pruning: boolean(r, "/requiresPruning"),
            })
            .collect(),
        history,
        app_set: app_set(d),
        reconciled_at: opt(d, "/status/reconciledAt"),
        refresh_requested: opt(d, "/metadata/annotations/argocd.argoproj.io~1refresh"),
        operation_in_progress: text(d, "/status/operationState/phase") == Some("Running"),
    }
}

