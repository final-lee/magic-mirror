use std::time::Duration;

use super::*;

const CONFIG: &str = r#"
apiVersion: v1
kind: Config
current-context: other
clusters:
- name: mine
  cluster: { server: "https://mine.example.com" }
- name: elsewhere
  cluster: { server: "https://elsewhere.example.com" }
contexts:
- name: mine-admin
  context: { cluster: mine, user: mine-user }
- name: other
  context: { cluster: elsewhere, user: other-user }
users:
- name: mine-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: ["eks", "get-token", "--cluster-name", "mine"]
      env: [{ name: AWS_PROFILE, value: mine-admin }]
- name: other-user
  user:
    token: other-secret
"#;

fn config() -> Kubeconfig {
    Kubeconfig::from_yaml(CONFIG).unwrap()
}

fn target(cluster: &str) -> K8sTarget {
    K8sTarget { profile: "p".into(), region: "r".into(), cluster: cluster.into() }
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn value<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

#[test]
fn the_shell_environment_drops_everything_that_points_elsewhere_and_pins_the_kubeconfig() {
    let parent = pairs(&[
        ("HOME", "/Users/me"),
        ("KUBECONFIG", "/Users/me/.kube/config"),
        ("KUBECACHEDIR", "/tmp/cache"),
        ("KUBE_EDITOR", "vim"),
        ("HELM_KUBECONTEXT", "prod"),
        ("HELM_KUBEAPISERVER", "https://elsewhere.example.com"),
        ("HELM_DRIVER", "secret"),
        ("PATH", "/usr/bin"),
        ("TERM", "dumb"),
        ("AWS_PROFILE", "other"),
        ("LANG", "ko_KR.UTF-8"),
    ]);
    let env = env_of(parent, Path::new("/tmp/pinned.yaml"), Some("mine-admin"), "/opt/bin:/usr/bin");
    assert_eq!(value(&env, "KUBECONFIG"), Some("/tmp/pinned.yaml"));
    for key in ["KUBECACHEDIR", "KUBE_EDITOR", "HELM_KUBECONTEXT", "HELM_KUBEAPISERVER"] {
        assert_eq!(value(&env, key), None, "{key}");
    }
    // 가리키는 곳과 상관없는 값은 그대로 물려준다
    assert_eq!((value(&env, "HOME"), value(&env, "HELM_DRIVER"), value(&env, "LANG")), (Some("/Users/me"), Some("secret"), Some("ko_KR.UTF-8")));
    // 로그인 PATH와 터미널 종류가 이기고, 값은 하나씩만 있다
    assert_eq!((value(&env, "PATH"), value(&env, "TERM")), (Some("/opt/bin:/usr/bin"), Some("xterm-256color")));
    assert_eq!(env.iter().filter(|(k, _)| k == "PATH" || k == "TERM" || k == "KUBECONFIG").count(), 3);
    // exec 프로필이 있으면 부모의 AWS_PROFILE을 덮는다
    assert_eq!(env.iter().filter(|(k, _)| k == "AWS_PROFILE").map(|(_, v)| v.as_str()).collect::<Vec<_>>(), ["mine-admin"]);
}

#[test]
fn without_an_exec_profile_the_parents_aws_profile_is_left_alone() {
    let env = env_of(pairs(&[("AWS_PROFILE", "dev")]), Path::new("/tmp/k"), None, "/usr/bin");
    assert_eq!(value(&env, "AWS_PROFILE"), Some("dev"));
}

#[test]
fn the_exec_profile_comes_from_the_pinned_contexts_user() {
    assert_eq!(exec_profile_of(&config(), "mine-admin").as_deref(), Some("mine-admin"));
    assert_eq!(exec_profile_of(&config(), "other"), None);
    assert_eq!(exec_profile_of(&config(), "missing"), None);
}

#[test]
fn a_plugin_command_is_one_argument_and_a_terminal_is_a_login_shell() {
    assert_eq!(argv_of("/bin/zsh", None), ["/bin/zsh", "-l"]);
    let command = "kubectl -n 'a b' get 'x'\\''y'\nuptime";
    assert_eq!(argv_of("/bin/zsh", Some(command)), ["/bin/zsh", "-lc", command]);
}

#[test]
fn the_shell_is_the_users_when_it_exists_and_zsh_otherwise() {
    assert_eq!(shell_of(Some("/bin/sh")), "/bin/sh");
    assert_eq!(shell_of(Some("/no/such/shell")), FALLBACK_SHELL);
    assert_eq!(shell_of(Some("zsh")), FALLBACK_SHELL);
    assert_eq!(shell_of(None), FALLBACK_SHELL);
}

#[test]
fn the_pinned_kubeconfig_holds_only_this_context_and_is_private_and_removed_with_its_owner() {
    let file = write_pinned(&config(), "mine-admin").unwrap();
    let path = file.path().to_path_buf();
    let read = Kubeconfig::from_yaml(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(read.current_context.as_deref(), Some("mine-admin"));
    assert_eq!(read.contexts.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["mine-admin"]);
    assert_eq!(read.clusters.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["mine"]);
    assert_eq!(read.auth_infos.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(), ["mine-user"]);
    // 다른 context의 토큰은 어디에도 없다
    assert!(!std::fs::read_to_string(&path).unwrap().contains("other-secret"));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    drop(file);
    assert!(!path.exists());
    assert!(write_pinned(&config(), "missing").is_err());
}

fn temp_log(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mm-terminal-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join("k8s-changes.jsonl")
}

fn request<'a>(config: &'a Kubeconfig, cluster: &str, command: Option<&str>) -> OpenRequest<'a> {
    OpenRequest {
        target: target(cluster),
        context: "mine-admin".into(),
        config,
        command: command.map(str::to_owned),
        shell: "/bin/sh".into(),
        parent_env: pairs(&[("KUBECONFIG", "/elsewhere/config"), ("KUBE_FOO", "leak"), ("HELM_KUBECONTEXT", "prod")]),
        path: "/usr/bin:/bin".into(),
        cwd: None,
        cols: 100,
        rows: 30,
    }
}

/// 열린 터미널의 화면: 지금까지 받은 글과 끝난 상태
struct Screen {
    rx: mpsc::UnboundedReceiver<ShellMessage>,
    seen: String,
    exit: Option<(Option<i32>, Option<String>)>,
}

impl Screen {
    async fn until(&mut self, needle: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !self.seen.contains(needle) {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(ShellMessage::Output { data })) => self.seen.push_str(&data),
                Ok(Some(ShellMessage::Exit { code, reason })) => {
                    self.exit = Some((code, reason));
                    return self.seen.contains(needle);
                }
                Ok(None) | Err(_) => return false,
            }
        }
        true
    }

    async fn exit(&mut self) -> Option<(Option<i32>, Option<String>)> {
        let deadline = Instant::now() + Duration::from_secs(20);
        while self.exit.is_none() {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(ShellMessage::Output { data })) => self.seen.push_str(&data),
                Ok(Some(ShellMessage::Exit { code, reason })) => self.exit = Some((code, reason)),
                Ok(None) | Err(_) => break,
            }
        }
        self.exit.clone()
    }
}

fn open(shells: &Arc<Shells>, log: &Path, config: &Kubeconfig, cluster: &str, command: Option<&str>) -> (ShellOpened, Screen, PathBuf) {
    let launched = launch(request(config, cluster, command)).unwrap();
    let kubeconfig = launched.kubeconfig_path().to_path_buf();
    let (tx, rx) = mpsc::unbounded_channel();
    let opened = launched.register(shells, log, move |m| tx.send(m).is_ok()).unwrap();
    (opened, Screen { rx, seen: String::new(), exit: None }, kubeconfig)
}

#[tokio::test]
async fn the_shell_sees_only_the_pinned_kubeconfig_and_closing_the_target_removes_it() {
    let shells = Arc::new(Shells::default());
    let log = temp_log("pinned");
    let config = config();
    let command = "printf 'PID=%s\\n' $$; printf 'KC=%s\\n' \"$KUBECONFIG\"; printf 'KUBE=%s HELM=%s\\n' \"${KUBE_FOO:-unset}\" \"${HELM_KUBECONTEXT:-unset}\"; printf 'READY\\n'; sleep 60";
    let (opened, mut screen, kubeconfig) = open(&shells, &log, &config, "a", Some(command));
    let (_, mut other, other_file) = open(&shells, &log, &config, "b", Some("printf READY; sleep 60"));
    assert!(screen.until("READY").await, "output: {}", screen.seen);
    assert!(other.until("READY").await);
    assert!(screen.seen.contains(&format!("KC={}", kubeconfig.display())), "output: {}", screen.seen);
    assert!(screen.seen.contains("KUBE=unset HELM=unset"), "output: {}", screen.seen);
    assert!(kubeconfig.exists() && other_file.exists());
    let text = std::fs::read_to_string(&kubeconfig).unwrap();
    assert!(text.contains("mine-admin") && !text.contains("other-secret") && !text.contains("elsewhere"));
    let pid = screen.seen.lines().find_map(|line| line.trim().strip_prefix("PID=")).unwrap().to_string();
    let alive = |pid: &str| std::process::Command::new("kill").args(["-0", pid]).status().unwrap().success();
    assert!(alive(&pid));

    // 이 대상의 터미널만 닫히고, 임시 파일이 지워지고, 닫은 시각이 남는다
    shells.close_target(&target("a"));
    shells.settle(Duration::from_secs(5)).await;
    assert!(!kubeconfig.exists());
    // 셸 프로세스도 죽는다
    for _ in 0..100 {
        if !alive(&pid) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!alive(&pid));
    assert!(other_file.exists());
    let rows = log::read_all(&log);
    assert_eq!(rows.len(), 2);
    let mine = rows.iter().find(|r| r.target == target("a")).unwrap();
    assert!(mine.closed_at.is_some());
    assert_eq!(mine.change.target, terminal_object("mine-admin"));
    assert_eq!(mine.change.operation, Operation::Terminal { command: Some(command.into()) });
    assert!(rows.iter().find(|r| r.target == target("b")).unwrap().closed_at.is_none());
    // 닫은 터미널로 입력을 보내도 아무 일이 없다
    shells.input(opened.id, "echo after\n".into());

    shells.close_all();
    shells.settle(Duration::from_secs(5)).await;
    assert!(!other_file.exists());
    let _ = std::fs::remove_dir_all(log.parent().unwrap());
}

#[tokio::test]
async fn a_command_that_ends_reports_its_exit_code_forgets_the_session_and_removes_the_file() {
    let shells = Arc::new(Shells::default());
    let log = temp_log("exit");
    let config = config();
    let (_, mut screen, kubeconfig) = open(&shells, &log, &config, "a", Some("echo bye; exit 3"));
    assert_eq!(screen.exit().await, Some((Some(3), None)), "output: {}", screen.seen);
    assert!(screen.seen.contains("bye"), "output: {}", screen.seen);
    shells.settle(Duration::from_secs(5)).await;
    for _ in 0..100 {
        if !kubeconfig.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!kubeconfig.exists());
    assert!(log::read_all(&log)[0].closed_at.is_some());
    let _ = std::fs::remove_dir_all(log.parent().unwrap());
}

#[tokio::test]
async fn keys_and_resizes_reach_the_login_shell() {
    let shells = Arc::new(Shells::default());
    let log = temp_log("input");
    let config = config();
    let (opened, mut screen, _) = open(&shells, &log, &config, "a", None);
    shells.input(opened.id, "echo mm-$((20+22))\n".into());
    assert!(screen.until("mm-42").await, "output: {}", screen.seen);
    shells.resize(opened.id, 120, 40);
    shells.input(opened.id, "stty size\n".into());
    assert!(screen.until("40 120").await, "output: {}", screen.seen);
    shells.input(opened.id, "exit\n".into());
    assert_eq!(screen.exit().await, Some((Some(0), None)));
    let _ = std::fs::remove_dir_all(log.parent().unwrap());
}

#[tokio::test]
async fn a_terminal_that_cannot_be_recorded_is_not_opened_and_leaves_nothing_behind() {
    let shells = Arc::new(Shells::default());
    // 기록 파일이 들어갈 폴더 자리에 파일이 있어서 적을 수 없다
    let blocker = temp_log("blocked").parent().unwrap().to_path_buf();
    std::fs::create_dir_all(blocker.parent().unwrap()).unwrap();
    std::fs::write(&blocker, "x").unwrap();
    let config = config();
    let launched = launch(request(&config, "a", Some("sleep 60"))).unwrap();
    let kubeconfig = launched.kubeconfig_path().to_path_buf();
    assert!(kubeconfig.exists());
    let (tx, _rx) = mpsc::unbounded_channel();
    let result = launched.register(&shells, &blocker.join("k8s-changes.jsonl"), move |m| tx.send(m).is_ok());
    assert!(result.is_err());
    assert!(!kubeconfig.exists());
    let _ = std::fs::remove_file(&blocker);
}

#[test]
fn a_terminal_dropped_before_it_is_registered_leaves_nothing_behind() {
    let config = config();
    let launched = launch(request(&config, "a", Some("sleep 60"))).unwrap();
    let kubeconfig = launched.kubeconfig_path().to_path_buf();
    assert!(kubeconfig.exists());
    drop(launched);
    assert!(!kubeconfig.exists());
}

#[test]
fn a_missing_context_or_shell_fails_without_a_temp_file() {
    let config = config();
    let mut missing = request(&config, "a", None);
    missing.context = "missing".into();
    assert!(launch(missing).is_err());
    let mut no_shell = request(&config, "a", None);
    no_shell.shell = "/no/such/shell".into();
    assert!(launch(no_shell).is_err());
}

#[test]
fn a_signal_ending_is_reported_by_its_name_and_an_unknown_ending_by_nothing() {
    assert_eq!(exit_message(Some(Exited { code: Some(2), signal: None })), ShellMessage::Exit { code: Some(2), reason: None });
    assert_eq!(exit_message(Some(Exited { code: None, signal: Some("Hangup".into()) })), ShellMessage::Exit { code: None, reason: Some("Hangup".into()) });
    assert_eq!(exit_message(None), ShellMessage::Exit { code: None, reason: None });
}
