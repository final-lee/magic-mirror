//! 앱 안 터미널(5. 탐색)을 실제 kind 클러스터에서 확인한다: 고정한 셸에서 `kubectl`이 그 클러스터에 닿고,
//! 부모 환경·kubeconfig에 다른 context가 있어도 셸은 이 context 하나만 보고, 임시 kubeconfig는 닫으면 지워진다.
//! 픽스처는 따로 없다(kind의 기본 네임스페이스만 쓴다). `kubectl`은 PATH에 있어야 한다(스크립트가 확인한다).
use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

use super::*;
use crate::k8s::change::Operation;
use crate::k8s::shell::{ShellMessage, Shells};
use crate::k8s::target::K8sTarget;
use crate::k8s::terminal::{self, OpenRequest};

fn target() -> K8sTarget {
    K8sTarget { profile: "live".into(), region: "r".into(), cluster: "kind".into() }
}

/// kind kubeconfig에 다른 클러스터를 가리키는 context를 하나 더하고 그것을 현재 context로 만든다(고정하지 않으면 엉뚱한 곳으로 간다).
fn with_decoy() -> (String, Kubeconfig) {
    let (context, mut value) = base();
    value["clusters"].as_array_mut().unwrap().push(json!({ "name": "decoy", "cluster": { "server": "https://decoy.invalid:6443" } }));
    value["users"].as_array_mut().unwrap().push(json!({ "name": "decoy-user", "user": { "token": "decoy-secret" } }));
    value["contexts"].as_array_mut().unwrap().push(json!({ "name": "decoy", "context": { "cluster": "decoy", "user": "decoy-user" } }));
    value["current-context"] = json!("decoy");
    (context, build(&value))
}

struct Screen {
    rx: tokio::sync::mpsc::UnboundedReceiver<ShellMessage>,
    seen: String,
    exit: Option<Option<i32>>,
}

impl Screen {
    async fn until(&mut self, needle: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !self.seen.contains(needle) {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(ShellMessage::Output { data })) => self.seen.push_str(&data),
                Ok(Some(ShellMessage::Exit { code, .. })) => {
                    self.exit = Some(code);
                    return self.seen.contains(needle);
                }
                Ok(None) | Err(_) => return false,
            }
        }
        true
    }

    async fn exit(&mut self) -> Option<Option<i32>> {
        let deadline = Instant::now() + Duration::from_secs(60);
        while self.exit.is_none() {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(ShellMessage::Output { data })) => self.seen.push_str(&data),
                Ok(Some(ShellMessage::Exit { code, .. })) => self.exit = Some(code),
                Ok(None) | Err(_) => break,
            }
        }
        self.exit
    }
}

fn open(shells: &Arc<Shells>, log: &std::path::Path, config: &Kubeconfig, context: &str, command: Option<&str>) -> (u64, Screen, std::path::PathBuf) {
    // 부모 환경에는 다른 곳을 가리키는 값이 있다: 이 값들이 셸에 닿으면 시험이 실패해야 한다
    let mut parent_env: Vec<(String, String)> = std::env::vars().collect();
    parent_env.push(("KUBECONFIG".into(), "/nonexistent/elsewhere".into()));
    parent_env.push(("KUBE_CONTEXT_HINT".into(), "decoy".into()));
    let launched = terminal::launch(OpenRequest {
        target: target(),
        context: context.to_string(),
        config,
        command: command.map(str::to_owned),
        shell: "/bin/sh".into(),
        parent_env,
        path: std::env::var("PATH").unwrap_or_default(),
        cwd: None,
        cols: 120,
        rows: 40,
    })
    .expect("launch terminal");
    let kubeconfig = launched.kubeconfig_path().to_path_buf();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let opened = launched.register(shells, log, move |m| tx.send(m).is_ok()).expect("register terminal");
    (opened.id, Screen { rx, seen: String::new(), exit: None }, kubeconfig)
}

fn log_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("mm-live-terminal-{name}-{}", std::process::id())).join("k8s-changes.jsonl")
}

#[tokio::test]
#[ignore]
async fn pinned_shell_runs_kubectl_against_this_cluster_only_and_cleans_up() {
    let (context, config) = with_decoy();
    let shells = Arc::new(Shells::default());
    let log = log_path("interactive");
    let (id, mut screen, kubeconfig) = open(&shells, &log, &config, &context, None);

    // 고정한 셸에서 kubectl이 kind 클러스터에 닿는다
    shells.input(id, "kubectl get ns -o name; echo \"GET-DONE=$?\"\n".into());
    assert!(screen.until("GET-DONE=0").await, "output: {}", screen.seen);
    assert!(screen.seen.contains("namespace/kube-system") && screen.seen.contains("namespace/default"), "output: {}", screen.seen);
    // 현재 context는 이 탭의 것이고, 셸이 아는 context는 그것 하나뿐이다
    shells.input(id, "echo \"CTX=$(kubectl config current-context) N=$(kubectl config get-contexts -o name | wc -l | tr -d ' ') KC=$KUBECONFIG\"\n".into());
    assert!(screen.until(&format!("CTX={context} N=1 KC={}", kubeconfig.display())).await, "output: {}", screen.seen);

    // 임시 kubeconfig에도 이 context 하나뿐이고 다른 context의 정보는 없다
    let text = std::fs::read_to_string(&kubeconfig).unwrap();
    let read = Kubeconfig::from_yaml(&text).unwrap();
    assert_eq!(read.contexts.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), [context.as_str()]);
    assert_eq!(read.current_context.as_deref(), Some(context.as_str()));
    assert!(!text.contains("decoy"));

    // 대상을 닫으면 셸이 끝나고 임시 파일이 지워지고 기록에 닫은 시각이 남는다
    shells.close_target(&target());
    shells.settle(Duration::from_secs(10)).await;
    assert!(!kubeconfig.exists());
    let rows = crate::k8s::log::read_all(&log);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].closed_at.is_some());
    assert_eq!(rows[0].change.operation, Operation::Terminal { command: None });
    let _ = std::fs::remove_dir_all(log.parent().unwrap());
}

#[tokio::test]
#[ignore]
async fn a_plugin_command_runs_pinned_and_reports_its_exit_code() {
    let (context, config) = with_decoy();
    let shells = Arc::new(Shells::default());
    let log = log_path("command");
    let command = "kubectl get ns -o name && kubectl config get-contexts -o name";
    let (_, mut screen, kubeconfig) = open(&shells, &log, &config, &context, Some(command));
    assert_eq!(screen.exit().await, Some(Some(0)), "output: {}", screen.seen);
    assert!(screen.seen.contains("namespace/default"), "output: {}", screen.seen);
    assert!(screen.seen.contains(&context) && !screen.seen.contains("decoy"), "output: {}", screen.seen);
    shells.settle(Duration::from_secs(10)).await;
    for _ in 0..100 {
        if !kubeconfig.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!kubeconfig.exists());
    let rows = crate::k8s::log::read_all(&log);
    assert_eq!(rows[0].change.operation, Operation::Terminal { command: Some(command.into()) });
    assert!(rows[0].closed_at.is_some());
    let _ = std::fs::remove_dir_all(log.parent().unwrap());
}
