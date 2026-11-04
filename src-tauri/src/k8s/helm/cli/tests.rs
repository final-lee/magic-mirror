use super::*;

fn ctx<'a>(paths: &'a [PathBuf], driver: Driver) -> Ctx<'a> {
    Ctx { context: "kind-demo", kubeconfig_paths: paths, driver }
}

fn chart(reference: &str) -> ChartArg {
    ChartArg { arg: reference.into(), shown: reference.into(), repo: None, version: None }
}

fn source(reference: &str, repo: Option<&str>, version: Option<&str>) -> ChartSource {
    ChartSource { reference: reference.into(), repo: repo.map(str::to_string), version: version.map(str::to_string) }
}

#[test]
fn an_upgrade_resets_values_to_the_given_file_on_the_chosen_cluster() {
    let paths = [PathBuf::from("/home/u/.kube/config")];
    let built = upgrade(&ctx(&paths, Driver::Secret), "web", "apps", &chart("/tmp/x/chart"), Path::new("/tmp/x/values.yaml"), false);
    assert_eq!(
        built.args,
        ["upgrade", "web", "/tmp/x/chart", "--namespace", "apps", "--reset-values", "--values", "/tmp/x/values.yaml", "--kube-context", "kind-demo", "--kubeconfig", "/home/u/.kube/config"]
    );
    // 화면에는 임시 파일과 kubeconfig 경로가 없다
    assert_eq!(built.shown, "helm upgrade web /tmp/x/chart --namespace apps --reset-values --values values.yaml --kube-context kind-demo");
}

#[test]
fn a_server_dry_run_adds_json_output_only_to_the_executed_arguments() {
    let paths = [PathBuf::from("/k")];
    let real = upgrade(&ctx(&paths, Driver::Secret), "web", "apps", &chart("c"), Path::new("/v"), false);
    let dry = upgrade(&ctx(&paths, Driver::Secret), "web", "apps", &chart("c"), Path::new("/v"), true);
    assert!(dry.args.windows(3).any(|w| w == ["--dry-run=server", "--output", "json"]));
    assert!(!real.args.iter().any(|a| a.starts_with("--dry-run")));
    assert_eq!(real.shown, dry.shown);
}

#[test]
fn several_kubeconfig_files_go_through_the_environment_and_a_single_one_through_the_flag() {
    let two = [PathBuf::from("/a/config"), PathBuf::from("/b/config")];
    let built = rollback(&ctx(&two, Driver::ConfigMap), "web", "apps", 4);
    assert!(!built.args.contains(&"--kubeconfig".to_string()));
    assert_eq!(built.args, ["rollback", "web", "4", "--namespace", "apps", "--kube-context", "kind-demo"]);
    let env = ctx(&two, Driver::ConfigMap).env();
    assert!(env.contains(&("HELM_DRIVER".to_string(), "configmap".to_string())));
    assert!(env.contains(&("KUBECONFIG".to_string(), "/a/config:/b/config".to_string())));
    let one = [PathBuf::from("/a/config")];
    assert!(!ctx(&one, Driver::Secret).env().iter().any(|(k, _)| k == "KUBECONFIG"));
}

#[test]
fn install_adds_create_namespace_only_when_asked_and_uninstall_keep_history_only_when_asked() {
    let paths = [PathBuf::from("/k")];
    let c = ctx(&paths, Driver::Secret);
    let with = install(&c, "web", "apps", &chart("oci://r/web"), Path::new("/v"), true, false);
    let without = install(&c, "web", "apps", &chart("oci://r/web"), Path::new("/v"), false, false);
    assert!(with.args.contains(&"--create-namespace".to_string()) && !without.args.contains(&"--create-namespace".to_string()));
    assert_eq!(&without.args[..3], ["install", "web", "oci://r/web"]);
    assert!(uninstall(&c, "web", "apps", true).args.contains(&"--keep-history".to_string()));
    assert!(!uninstall(&c, "web", "apps", false).args.contains(&"--keep-history".to_string()));
}

#[test]
fn repo_and_version_follow_the_chart_in_the_arguments_and_in_the_displayed_command() {
    let paths = [PathBuf::from("/k")];
    let arg = resolve_chart(&source("nginx", Some("https://charts.example.com"), Some("1.2.3")), None).unwrap();
    let built = install(&ctx(&paths, Driver::Secret), "web", "apps", &arg, Path::new("/v"), false, false);
    assert_eq!(&built.args[..7], ["install", "web", "nginx", "--repo", "https://charts.example.com", "--version", "1.2.3"]);
    assert!(built.shown.starts_with("helm install web nginx --repo https://charts.example.com --version 1.2.3 "));
    // 차트 보기는 클러스터 인자가 없다
    assert_eq!(show_values(&arg).args, ["show", "values", "nginx", "--repo", "https://charts.example.com", "--version", "1.2.3"]);
}

#[test]
fn local_charts_must_be_absolute_and_exist() {
    let dir = tempfile::tempdir().unwrap();
    let existing = dir.path().to_string_lossy().into_owned();
    assert_eq!(resolve_chart(&source(&existing, None, None), None).unwrap().arg, existing);
    let file = dir.path().join("web-1.0.0.tgz");
    std::fs::write(&file, "x").unwrap();
    assert!(resolve_chart(&source(&file.to_string_lossy(), None, None), None).is_ok());
    let missing = dir.path().join("nope").to_string_lossy().into_owned();
    assert_eq!(resolve_chart(&source(&missing, None, None), None).unwrap_err(), AppError::other(CHART_PATH_MISSING));
    // 상대 경로는 helm의 작업 폴더에 기대므로 받지 않는다
    for relative in ["./chart", "../chart", ".hidden"] {
        assert_eq!(resolve_chart(&source(relative, None, None), None).unwrap_err(), AppError::other(CHART_PATH_MISSING), "{relative}");
    }
}

#[test]
fn a_tilde_path_expands_to_the_home_folder_and_fails_without_one() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("chart")).unwrap();
    let arg = resolve_chart(&source("~/chart", None, None), Some(home.path())).unwrap();
    assert_eq!(arg.arg, home.path().join("chart").to_string_lossy());
    assert_eq!(resolve_chart(&source("~/chart", None, None), None).unwrap_err(), AppError::other(CHART_PATH_MISSING));
    assert_eq!(resolve_chart(&source("~/missing", None, None), Some(home.path())).unwrap_err(), AppError::other(CHART_PATH_MISSING));
}

#[test]
fn a_local_path_refuses_a_repo_or_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_string_lossy().into_owned();
    assert_eq!(resolve_chart(&source(&path, Some("https://r.example"), None), None).unwrap_err(), AppError::other(LOCAL_WITH_REPO));
    assert_eq!(resolve_chart(&source(&path, None, Some("1.0.0")), None).unwrap_err(), AppError::other(LOCAL_WITH_REPO));
}

#[test]
fn oci_references_take_a_version_but_not_a_repo_and_names_with_a_repo_must_be_plain_names() {
    let arg = resolve_chart(&source("oci://ghcr.io/org/web", None, Some("2.0.0")), None).unwrap();
    assert_eq!((arg.arg.as_str(), arg.version.as_deref(), arg.repo), ("oci://ghcr.io/org/web", Some("2.0.0"), None));
    assert_eq!(resolve_chart(&source("oci://ghcr.io/org/web", Some("https://r.example"), None), None).unwrap_err(), AppError::other(REPO_WITH_OCI));
    assert_eq!(resolve_chart(&source("org/web", Some("https://r.example"), None), None).unwrap_err(), AppError::other(REPO_NEEDS_NAME));
    // 이미 helm에 등록한 저장소의 `repo/chart`는 저장소 주소 없이 그대로 넘긴다
    assert_eq!(resolve_chart(&source("bitnami/nginx", None, None), None).unwrap().arg, "bitnami/nginx");
    // 빈 저장소·버전 입력은 없는 것으로 본다
    let blank = resolve_chart(&source(" nginx ", Some(" "), Some("")), None).unwrap();
    assert_eq!((blank.arg.as_str(), blank.repo, blank.version), ("nginx", None, None));
}

#[test]
fn values_that_could_be_read_as_flags_or_split_into_arguments_are_refused() {
    for bad in ["--post-renderer=sh", "-f", "a b", "a\nb", "", "  "] {
        assert_eq!(resolve_chart(&source(bad, None, None), None).unwrap_err(), AppError::other(BAD_CHART), "{bad:?}");
    }
    assert_eq!(resolve_chart(&source("nginx", None, Some("--set x=1")), None).unwrap_err(), AppError::other(BAD_VERSION));
    assert_eq!(resolve_chart(&source("nginx", None, Some("1 2")), None).unwrap_err(), AppError::other(BAD_VERSION));
    for repo in ["file:///etc", "ftp://x", "https://u:p@charts.example", "https://", "charts.example.com", "--insecure"] {
        assert_eq!(resolve_chart(&source("nginx", Some(repo), None), None).unwrap_err(), AppError::other(BAD_REPO), "{repo}");
    }
    assert!(resolve_chart(&source("nginx", Some("http://charts.example/path@v1"), None), None).is_ok());
}

#[test]
fn release_and_namespace_names_follow_the_kubernetes_and_helm_rules() {
    for ok in ["web", "web-1", "a.b", "0abc", &"a".repeat(53)] {
        assert!(valid_release_name(ok), "{ok}");
    }
    for bad in ["", "Web", "-web", "web-", "web_1", ".a", "a b", "--set", &"a".repeat(54)] {
        assert!(!valid_release_name(bad), "{bad}");
    }
    for ok in ["default", "kube-system", "a", &"a".repeat(63)] {
        assert!(valid_namespace(ok), "{ok}");
    }
    for bad in ["", "A", "a.b", "-a", "a-", "a_b", &"a".repeat(64)] {
        assert!(!valid_namespace(bad), "{bad}");
    }
    assert_eq!(check_target("Web", "apps").unwrap_err(), AppError::other(BAD_RELEASE_NAME));
    assert_eq!(check_target("web", "Apps").unwrap_err(), AppError::other(BAD_NAMESPACE));
    assert!(check_target("web", "apps").is_ok());
}
