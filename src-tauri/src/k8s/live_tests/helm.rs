//! Helm 시험: 실제 kind 클러스터에 helm이 설치한 릴리스(`scripts/k8s-live/helm.sh`)를 앱이 읽고, 변경 틀의 미리보기 → 확인 → 적용 → 기록 → 되돌리기로 바꾼다.
//! 환경: `K8S_LIVE_KUBECONFIG`, `K8S_LIVE_HELM_CHART`(로컬 차트 폴더), `K8S_LIVE_HELM_REPO`(로컬 차트 저장소 주소). 확인은 helm·kubectl로 따로 한다.
//! 릴리스: `flow`(helm이 만든 리비전 둘), `broken`(failed), `cmrel`(ConfigMap 드라이버). 앱이 설치하는 릴리스는 이름이 따로다.
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use super::{base, build, env, kubeconfig_path, PRIVATE};
use crate::error::AppError;
use crate::k8s::change::{apply::redact, Change, ChangeObject, Operation, Plan};
use crate::k8s::commit::CONFIRM_REQUIRED;
use crate::k8s::connect::client_for;
use crate::k8s::exec::STALE;
use crate::k8s::helm::release::Driver;
use crate::k8s::helm::{self, detail, plan, read, release_kind, run, ChartSource, Cluster};
use crate::k8s::log::{self, Entry};
use crate::k8s::target::K8sTarget;

const NS: &str = "mm-helm";

async fn cluster() -> (Cluster, String) {
    let (context, value) = base();
    let client = client_for(&build(&value), &context, PRIVATE).await.expect("kind에 연결");
    (Cluster { client, endpoint: PRIVATE, context: context.clone(), kubeconfig_paths: vec![kubeconfig_path()] }, context)
}

fn chart_dir() -> String {
    env("K8S_LIVE_HELM_CHART")
}

/// 앱과 상관없이 helm CLI로 확인한다(같은 kubeconfig·context)
fn helm_cli(context: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("helm").arg("--kubeconfig").arg(kubeconfig_path()).args(["--kube-context", context]).args(args).output().expect("helm");
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn kubectl_out(args: &[&str]) -> Result<String, String> {
    let out = Command::new("kubectl").arg("--kubeconfig").arg(kubeconfig_path()).args(args).output().expect("kubectl");
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn target() -> K8sTarget {
    K8sTarget { profile: "p".into(), region: "r".into(), cluster: "c".into() }
}

fn change(namespace: &str, name: &str, operation: Operation) -> Change {
    Change { target: ChangeObject { kind: release_kind(), namespace: Some(namespace.into()), name: name.into() }, operation }
}

fn log_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("mm-live-helm-{name}-{}", std::process::id())).join("k8s-changes.jsonl")
}

/// `k8s_apply`가 하는 것처럼 미리보기 → (다시 계산·재확인 → helm 실행) → 기록(values 없이) 까지 한다. 돌려주는 값은 기록 번호.
async fn apply_and_log(cluster: &Cluster, change: &Change, confirm: Option<&str>, undo_of: Option<&str>, log_file: &Path) -> Result<String, AppError> {
    let seen = plan::dry_plan(cluster, change).await?;
    let (current, outcome) = plan::apply(cluster, change, &seen, confirm).await?;
    let id = format!("live-{}", log::read_all(log_file).len() + 1);
    let entry = Entry {
        id: id.clone(),
        at: "2026-01-01T00:00:00Z".into(),
        target: target(),
        change: redact(change),
        summary: current.preview.impact.join(", "),
        ok: outcome.is_ok(),
        error: outcome.as_ref().err().map(ToString::to_string),
        inverse: if outcome.is_ok() { current.inverse } else { None },
        undo_of: undo_of.map(str::to_string),
        undone: false,
        closed_at: None,
    };
    log::append(log_file, &entry).unwrap();
    if outcome.is_ok() {
        if let Some(original) = undo_of {
            log::mark_undone(log_file, original).unwrap();
        }
    }
    outcome.map(|_| id)
}

fn diff_paths(plan: &Plan) -> Vec<String> {
    plan.preview.diff.iter().map(|d| d.path.clone()).collect()
}

fn history(context: &str, name: &str, namespace: &str) -> Vec<Value> {
    serde_json::from_str(&helm_cli(context, &["history", name, "-n", namespace, "-o", "json"]).unwrap()).unwrap()
}

fn replicas(name: &str) -> String {
    kubectl_out(&["-n", NS, "get", "deployment", name, "-o", "jsonpath={.spec.replicas}"]).unwrap()
}

#[tokio::test]
#[ignore]
async fn helm_is_found_and_reports_a_usable_version() {
    let tool = run::tool().await;
    assert!(tool.available, "{tool:?}");
    assert!(tool.path.as_deref().is_some_and(|p| p.ends_with("/helm")) && tool.version.as_deref().is_some_and(|v| v.starts_with('v')), "{tool:?}");
}

#[tokio::test]
#[ignore]
async fn the_app_reads_helm_releases_their_values_and_history_like_helm_does() {
    let (cluster, context) = cluster().await;
    let rows = read::list(&cluster, Some(NS)).await.unwrap();
    let flow = rows.iter().find(|r| r.name == "flow").expect("helm이 설치한 flow");
    assert_eq!((flow.revision, flow.revisions, flow.status.as_str(), flow.chart.as_str(), flow.app_version.as_str(), flow.problem), (2, 2, "deployed", "mmdemo-0.1.0", "1.0", false), "{flow:?}");
    let broken = rows.iter().find(|r| r.name == "broken").expect("서버가 거절한 broken 릴리스도 보여야 해요");
    assert!((broken.status.as_str(), broken.problem) == ("failed", true), "{broken:?}");
    // 모든 네임스페이스: ConfigMap 드라이버 릴리스도 같이 보인다
    let all = read::list(&cluster, None).await.unwrap();
    let cm = all.iter().find(|r| r.name == "cmrel").expect("ConfigMap 드라이버 릴리스");
    assert_eq!((cm.driver, cm.namespace.as_str(), cm.status.as_str()), (Driver::ConfigMap, "mm-helm-cm", "deployed"));
    assert!(all.iter().any(|r| r.name == "flow" && r.driver == Driver::Secret));
    // 상세: helm get과 같은 값·manifest
    let stored = read::locate(&cluster, NS, "flow").await.unwrap();
    assert_eq!(stored.iter().map(|s| s.revision).collect::<Vec<_>>(), [2, 1]);
    let release = read::fetch(&cluster, &stored[0]).await.unwrap();
    let revisions = read::history(&cluster, &stored).await.unwrap();
    let shown = detail::build(&release, stored[0].driver, 2, revisions).unwrap();
    assert_eq!(shown.user_values.trim(), "message: hello\nreplicaCount: 2");
    let computed: Value = serde_json::from_str(&helm_cli(&context, &["get", "values", "flow", "-n", NS, "--all", "-o", "json"]).unwrap()).unwrap();
    assert_eq!(serde_saphyr::from_str::<Value>(&shown.computed_values).unwrap(), computed, "계산된 값이 helm get values --all과 같아야 해요");
    let manifest = helm_cli(&context, &["get", "manifest", "flow", "-n", NS]).unwrap();
    assert_eq!(crate::k8s::helm::manifest::parse(&release.manifest).unwrap(), crate::k8s::helm::manifest::parse(&manifest).unwrap());
    assert_eq!(shown.resources.iter().map(|r| format!("{}/{}", r.kind, r.name)).collect::<Vec<_>>(), ["ConfigMap/flow-config", "Deployment/flow-web"]);
    assert_eq!(shown.notes.trim(), "Installed flow");
    let from_helm = history(&context, "flow", NS);
    assert_eq!(shown.history.iter().map(|h| (h.revision as u64, h.description.clone())).collect::<Vec<_>>(), [(2, from_helm[1]["description"].as_str().unwrap().to_string()), (1, from_helm[0]["description"].as_str().unwrap().to_string())]);
    let old = read::fetch(&cluster, &stored[1]).await.unwrap();
    assert_eq!(old.user_values(), json!({"message": "hi"}));
}

#[tokio::test]
#[ignore]
async fn upgrade_rollback_and_uninstall_run_through_preview_confirm_log_and_undo() {
    let (cluster, context) = cluster().await;
    let log_file = log_path("flow");
    let secret = "s3cr3t-live-value";

    // 업그레이드(values 편집): 저장된 릴리스에서 되살린 차트로 서버 dry-run 미리보기
    let upgrade = change(NS, "flow", Operation::HelmUpgrade { values: format!("message: {secret}\nreplicaCount: 3\n"), chart: None });
    let seen = plan::dry_plan(&cluster, &upgrade).await.unwrap();
    assert_eq!(diff_paths(&seen), ["values · message", "values · replicaCount", "ConfigMap flow-config · data.message", "Deployment flow-web · spec.replicas"].map(String::from).to_vec(), "{:?}", seen.preview.diff);
    assert!(seen.preview.confirm_name.is_none() && seen.preview.reversible);
    assert_eq!(seen.inverse.as_ref().unwrap().operation, Operation::HelmRollback { revision: 2 });
    // 미리보기 뒤에 다른 곳에서 업그레이드하면 적용은 낡았다고 거절한다
    helm_cli(&context, &["upgrade", "flow", &chart_dir(), "-n", NS, "--reset-values", "--set", "message=hello", "--set", "replicaCount=2", "--description", "outside"]).unwrap();
    assert_eq!(plan::apply(&cluster, &upgrade, &seen, None).await.map(|_| ()).unwrap_err(), AppError::other(STALE));
    assert_eq!(history(&context, "flow", NS).len(), 3, "낡은 미리보기는 아무것도 바꾸지 않아요");

    // 다시 미리보기 → 적용 → 기록
    let first = apply_and_log(&cluster, &upgrade, None, None, &log_file).await.unwrap();
    assert_eq!(replicas("flow-web"), "3");
    let values: Value = serde_json::from_str(&helm_cli(&context, &["get", "values", "flow", "-n", NS, "-o", "json"]).unwrap()).unwrap();
    assert_eq!(values, json!({"message": secret, "replicaCount": 3}));
    let logged = std::fs::read_to_string(&log_file).unwrap();
    assert!(!logged.contains(secret), "values는 변경 기록에 남지 않아요: {logged}");
    let entries = log::read_all(&log_file);
    assert_eq!((entries[0].ok, entries[0].change.operation.clone()), (true, Operation::HelmUpgrade { values: String::new(), chart: None }));
    let inverse = entries[0].inverse.clone().expect("업그레이드는 되돌릴 수 있어요");
    assert_eq!(inverse.operation, Operation::HelmRollback { revision: 3 });

    // 되돌리기: 기록된 역변경도 같은 미리보기를 거친다
    let before_undo = plan::dry_plan(&cluster, &inverse).await.unwrap();
    assert!(diff_paths(&before_undo).contains(&"Deployment flow-web · spec.replicas".to_string()), "{:?}", before_undo.preview.diff);
    apply_and_log(&cluster, &inverse, None, Some(&first), &log_file).await.unwrap();
    assert_eq!(replicas("flow-web"), "2");
    assert!(log::read_all(&log_file)[0].undone);

    // 롤백: 리비전 1(message=hi, replicas 1)
    let rollback = change(NS, "flow", Operation::HelmRollback { revision: 1 });
    let seen = plan::dry_plan(&cluster, &rollback).await.unwrap();
    assert!(diff_paths(&seen).contains(&"values · message".to_string()) && diff_paths(&seen).contains(&"Deployment flow-web · spec.replicas".to_string()), "{:?}", diff_paths(&seen));
    apply_and_log(&cluster, &rollback, None, None, &log_file).await.unwrap();
    assert_eq!(replicas("flow-web"), "1");
    let last = history(&context, "flow", NS).pop().unwrap();
    assert!(last["description"].as_str().unwrap().contains("Rollback to 1"), "{last}");
    assert_eq!(rollback_to_same(&cluster, &last["revision"]).await, AppError::other(plan::ALREADY_CURRENT));

    // 삭제: 이름을 입력해야 하고, 이력이 없어지면 되돌릴 수 없다
    let uninstall = change(NS, "flow", Operation::HelmUninstall { keep_history: false });
    let seen = plan::dry_plan(&cluster, &uninstall).await.unwrap();
    assert_eq!(seen.preview.confirm_name.as_deref(), Some("flow"));
    assert_eq!(diff_paths(&seen), ["ConfigMap flow-config", "Deployment flow-web"]);
    assert!(seen.inverse.is_none() && !seen.preview.reversible);
    assert_eq!(apply_and_log(&cluster, &uninstall, None, None, &log_file).await.unwrap_err(), AppError::other(CONFIRM_REQUIRED));
    assert_eq!(apply_and_log(&cluster, &uninstall, Some("wrong"), None, &log_file).await.unwrap_err(), AppError::other(CONFIRM_REQUIRED));
    assert!(helm_cli(&context, &["status", "flow", "-n", NS]).is_ok(), "확인 없이는 지워지지 않아요");
    apply_and_log(&cluster, &uninstall, Some("flow"), None, &log_file).await.unwrap();
    assert!(helm_cli(&context, &["status", "flow", "-n", NS]).unwrap_err().contains("not found"));
    assert!(kubectl_out(&["-n", NS, "get", "deployment", "flow-web"]).is_err());
    assert!(read::list(&cluster, Some(NS)).await.unwrap().iter().all(|r| r.name != "flow"));
    let entries = log::read_all(&log_file);
    assert!(entries.last().unwrap().ok && entries.last().unwrap().inverse.is_none());
    let _ = std::fs::remove_dir_all(log_file.parent().unwrap());
}

async fn rollback_to_same(cluster: &Cluster, revision: &Value) -> AppError {
    let same = change(NS, "flow", Operation::HelmRollback { revision: revision.as_u64().unwrap() as u32 });
    plan::dry_plan(cluster, &same).await.unwrap_err()
}

#[tokio::test]
#[ignore]
async fn uninstall_that_keeps_history_is_undone_by_rolling_back_and_a_failed_release_cannot_be_applied_over_unnoticed() {
    let (cluster, context) = cluster().await;
    let name = "keeper";
    helm_cli(&context, &["install", name, &chart_dir(), "-n", NS, "--set", "message=kept"]).unwrap();
    let uninstall = change(NS, name, Operation::HelmUninstall { keep_history: true });
    let seen = plan::dry_plan(&cluster, &uninstall).await.unwrap();
    let undo = seen.inverse.clone().expect("이력을 남기면 되돌릴 수 있어요");
    assert_eq!(undo.operation, Operation::HelmRollback { revision: 1 });
    plan::apply(&cluster, &uninstall, &seen, Some(name)).await.unwrap().1.unwrap();
    assert!(helm_cli(&context, &["status", name, "-n", NS]).unwrap().contains("uninstalled"));
    // 삭제돼 이력만 남은 릴리스: 목록에는 uninstalled, 되돌리기 미리보기는 모든 객체가 새로 생긴다
    let row = read::list(&cluster, Some(NS)).await.unwrap().into_iter().find(|r| r.name == name).unwrap();
    assert_eq!((row.status.as_str(), row.problem), ("uninstalled", false));
    let restore = plan::dry_plan(&cluster, &undo).await.unwrap();
    assert!(restore.preview.diff.iter().all(|d| d.before == Value::Null), "{:?}", restore.preview.diff);
    plan::apply(&cluster, &undo, &restore, None).await.unwrap().1.unwrap();
    assert_eq!(kubectl_out(&["-n", NS, "get", "configmap", &format!("{name}-config"), "-o", "jsonpath={.data.message}"]).unwrap(), "kept");
    assert_eq!(restore.inverse.unwrap().operation, Operation::HelmUninstall { keep_history: true });
    let final_uninstall = change(NS, name, Operation::HelmUninstall { keep_history: false });
    let seen = plan::dry_plan(&cluster, &final_uninstall).await.unwrap();
    plan::apply(&cluster, &final_uninstall, &seen, Some(name)).await.unwrap().1.unwrap();
    assert!(helm_cli(&context, &["status", name, "-n", NS]).is_err());
}

#[tokio::test]
#[ignore]
async fn a_chart_is_installed_from_a_local_path_and_from_a_repository_with_undo_by_uninstall() {
    let (cluster, context) = cluster().await;
    let new_ns = "mm-helm-new";
    // 로컬 경로: 네임스페이스를 만들면서. 서버 dry-run은 네임스페이스를 만들지 않고도 미리보기를 낸다
    let source = ChartSource { reference: chart_dir(), repo: None, version: None };
    let install = change(new_ns, "pathinst", Operation::HelmInstall { chart: source.clone(), values: "message: from-path\nreplicaCount: 2\n".into(), create_namespace: true });
    let seen = plan::dry_plan(&cluster, &install).await.unwrap();
    assert!(diff_paths(&seen).contains(&"Deployment pathinst-web".to_string()) && diff_paths(&seen).contains(&"values · message".to_string()), "{:?}", diff_paths(&seen));
    assert!(kubectl_out(&["get", "namespace", new_ns]).is_err(), "미리보기는 아무것도 만들지 않아요");
    assert_eq!(seen.inverse.as_ref().unwrap().operation, Operation::HelmUninstall { keep_history: false });
    // 값이 YAML 맵이 아니면 helm을 부르기 전에 거절한다
    let bad = change(new_ns, "pathinst", Operation::HelmInstall { chart: source.clone(), values: "- a\n".into(), create_namespace: true });
    assert_eq!(plan::dry_plan(&cluster, &bad).await.unwrap_err(), AppError::other(plan::VALUES_NOT_MAP));
    plan::apply(&cluster, &install, &seen, None).await.unwrap().1.unwrap();
    assert_eq!(kubectl_out(&["-n", new_ns, "get", "deployment", "pathinst-web", "-o", "jsonpath={.spec.replicas}"]).unwrap(), "2");
    assert_eq!(history(&context, "pathinst", new_ns).len(), 1);
    // 같은 이름은 거절
    assert_eq!(plan::dry_plan(&cluster, &install).await.unwrap_err(), AppError::other(plan::ALREADY_EXISTS));
    // 되돌리기 = 삭제(릴리스만. 만든 네임스페이스는 남는다)
    let undo = seen.inverse.unwrap();
    let seen_undo = plan::dry_plan(&cluster, &undo).await.unwrap();
    assert_eq!(seen_undo.preview.confirm_name.as_deref(), Some("pathinst"));
    plan::apply(&cluster, &undo, &seen_undo, Some("pathinst")).await.unwrap().1.unwrap();
    assert!(helm_cli(&context, &["status", "pathinst", "-n", new_ns]).is_err());
    assert!(kubectl_out(&["get", "namespace", new_ns]).is_ok());

    // 저장소 ref: 로컬 차트 저장소에서 이름과 버전으로
    let repo = ChartSource { reference: "mmdemo".into(), repo: Some(env("K8S_LIVE_HELM_REPO")), version: Some("0.1.0".into()) };
    let from_repo = change(new_ns, "repoinst", Operation::HelmInstall { chart: repo.clone(), values: String::new(), create_namespace: false });
    let seen = plan::dry_plan(&cluster, &from_repo).await.unwrap();
    plan::apply(&cluster, &from_repo, &seen, None).await.unwrap().1.unwrap();
    let row = read::list(&cluster, Some(new_ns)).await.unwrap().into_iter().find(|r| r.name == "repoinst").unwrap();
    assert_eq!((row.chart.as_str(), row.status.as_str()), ("mmdemo-0.1.0", "deployed"));
    // 없는 버전은 helm의 이유와 함께 미리보기에서 막힌다
    let missing = change(new_ns, "repomissing", Operation::HelmInstall { chart: ChartSource { version: Some("9.9.9".into()), ..repo }, values: String::new(), create_namespace: false });
    let error = plan::dry_plan(&cluster, &missing).await.unwrap_err();
    assert!(matches!(&error, AppError::Other { message } if message.starts_with("helm이 실패했어요")), "{error:?}");
    // 저장소 차트로 업그레이드: 저장소 접속 없이 되살린 차트가 아니라 새로 받은 차트로
    let to_ref = change(new_ns, "repoinst", Operation::HelmUpgrade { values: "message: from-repo\n".into(), chart: Some(ChartSource { reference: "mmdemo".into(), repo: Some(env("K8S_LIVE_HELM_REPO")), version: Some("0.1.0".into()) }) });
    let seen = plan::dry_plan(&cluster, &to_ref).await.unwrap();
    assert!(diff_paths(&seen).contains(&"ConfigMap repoinst-config · data.message".to_string()), "{:?}", diff_paths(&seen));
    plan::apply(&cluster, &to_ref, &seen, None).await.unwrap().1.unwrap();
    assert_eq!(kubectl_out(&["-n", new_ns, "get", "configmap", "repoinst-config", "-o", "jsonpath={.data.message}"]).unwrap(), "from-repo");
    helm_cli(&context, &["uninstall", "repoinst", "-n", new_ns]).unwrap();
    let _ = kubectl_out(&["delete", "namespace", new_ns]);
}

#[tokio::test]
#[ignore]
async fn a_charts_default_values_are_shown_from_a_path_without_touching_the_cluster() {
    let built = helm::cli::show_values(&plan::source_chart(&ChartSource { reference: chart_dir(), repo: None, version: None }).unwrap());
    let out = run::exec(&run::require().await.unwrap(), &built.args, &[], run::NO_CLUSTER, std::time::Duration::from_secs(30)).await.unwrap();
    assert!(out.contains("replicaCount: 1") && out.contains("message: hello"), "{out}");
}
