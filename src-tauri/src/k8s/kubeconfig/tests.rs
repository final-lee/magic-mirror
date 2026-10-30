use super::*;

const ARN: &str = "arn:aws:eks:ap-northeast-2:111111111111:cluster/prod";
const ENDPOINT: &str = "https://ABCDEF.gr7.ap-northeast-2.eks.amazonaws.com";
const FIXTURE: &str = r#"
apiVersion: v1
kind: Config
clusters:
- name: arn:aws:eks:ap-northeast-2:111111111111:cluster/prod
  cluster: { server: "https://ABCDEF.gr7.ap-northeast-2.eks.amazonaws.com", certificate-authority-data: "Zm9v" }
- name: prod-alias
  cluster: { server: "https://abcdef.gr7.ap-northeast-2.eks.amazonaws.com/" }
- name: other
  cluster: { server: "https://OTHER.eks.amazonaws.com" }
contexts:
- name: arn:aws:eks:ap-northeast-2:111111111111:cluster/prod
  context: { cluster: "arn:aws:eks:ap-northeast-2:111111111111:cluster/prod", user: "arn-user" }
- name: prod-admin
  context: { cluster: prod-alias, user: admin-user, namespace: ops }
- name: other
  context: { cluster: other, user: arn-user }
users:
- name: arn-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: ["--region", "ap-northeast-2", "eks", "get-token", "--cluster-name", "prod", "--output", "json", "--profile", "prod-ro"]
- name: admin-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: ["eks", "get-token", "--cluster-name", "prod"]
      env: [{ name: AWS_PROFILE, value: prod-admin }]
"#;

fn fixture() -> Kubeconfig {
    Kubeconfig::from_yaml(FIXTURE).unwrap()
}

fn auth(json: serde_json::Value) -> AuthInfo {
    serde_json::from_value(json).unwrap()
}

#[test]
fn matches_by_arn_name_or_endpoint_case_and_slash_insensitively() {
    let c = candidates(&fixture(), ARN, ENDPOINT);
    let names: Vec<_> = c.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, [ARN, "prod-admin"]);
    assert_eq!(c[1].namespace.as_deref(), Some("ops"));
}

#[test]
fn exec_profile_from_args_or_env() {
    let c = candidates(&fixture(), ARN, ENDPOINT);
    assert_eq!(c[0].exec_profile.as_deref(), Some("prod-ro"));
    assert_eq!(c[1].exec_profile.as_deref(), Some("prod-admin"));
}

#[test]
fn exec_profile_equals_form_and_missing() {
    let exec = |args: serde_json::Value| auth(serde_json::json!({ "exec": { "apiVersion": "client.authentication.k8s.io/v1beta1", "command": "aws", "args": args } }));
    assert_eq!(exec_profile(&exec(serde_json::json!(["--profile=dev"]))).as_deref(), Some("dev"));
    assert_eq!(exec_profile(&exec(serde_json::json!(["eks", "get-token"]))), None);
    assert_eq!(exec_profile(&auth(serde_json::json!({ "token": "abc" }))), None);
}

#[test]
fn choose_saved_only_or_none() {
    let c = candidates(&fixture(), ARN, ENDPOINT);
    assert_eq!(choose(&c, Some("prod-admin")), (Some("prod-admin".into()), None));
    assert_eq!(choose(&c, Some("gone")), (None, Some("gone".into())));
    assert_eq!(choose(&c, None), (None, None));
    assert_eq!(choose(&c[..1], None), (Some(ARN.into()), None));
    assert_eq!(choose(&c[..1], Some("gone")), (Some(ARN.into()), Some("gone".into())));
}

#[test]
fn paths_setting_then_env_then_home() {
    let home = Path::new("/Users/me");
    assert_eq!(kubeconfig_paths(Some("/x/kc"), Some("/a:/b"), Some(home)), [PathBuf::from("/x/kc")]);
    assert_eq!(kubeconfig_paths(Some("  "), Some("/a::/b"), Some(home)), [PathBuf::from("/a"), PathBuf::from("/b")]);
    assert_eq!(kubeconfig_paths(None, None, Some(home)), [PathBuf::from("/Users/me/.kube/config")]);
    assert_eq!(kubeconfig_paths(Some("~/kc"), None, Some(home)), [PathBuf::from("/Users/me/kc")]);
}

#[test]
fn load_merges_first_wins_and_skips_missing_files() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    std::fs::write(&a, FIXTURE).unwrap();
    let b = dir.path().join("b");
    std::fs::write(&b, "apiVersion: v1\nkind: Config\ncontexts:\n- name: other\n  context: { cluster: x, user: y }\n- name: extra\n  context: { cluster: x, user: y }\n").unwrap();
    let loaded = load(&[dir.path().join("missing"), a.clone(), b.clone()]).unwrap();
    assert_eq!(loaded.paths, [a, b]);
    let other = loaded.config.contexts.iter().find(|c| c.name == "other").unwrap();
    assert_eq!(other.context.as_ref().unwrap().cluster, "other");
    assert!(loaded.config.contexts.iter().any(|c| c.name == "extra"));
}

#[test]
fn load_errors() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing");
    assert_eq!(load(std::slice::from_ref(&missing)).unwrap_err(), AppError::other(no_kubeconfig(&[missing])));
    let bad = dir.path().join("bad");
    std::fs::write(&bad, "{not yaml").unwrap();
    let AppError::Other { message } = load(std::slice::from_ref(&bad)).unwrap_err() else { panic!() };
    assert!(message.starts_with(&format!("kubeconfig를 읽지 못했어요({})", bad.display())), "{message}");
}

fn path_entries(kc: &Kubeconfig, user: &str) -> Option<Vec<std::collections::HashMap<String, String>>> {
    kc.auth_infos.iter().find(|u| u.name == user).unwrap().auth_info.as_ref().unwrap().exec.as_ref().unwrap().env.clone()
}

#[test]
fn with_path_adds_path_once() {
    let kc = with_path(&fixture(), "prod-admin", "/opt/homebrew/bin:/usr/bin");
    let env = path_entries(&kc, "admin-user").unwrap();
    assert!(env.iter().any(|e| e.get("name").map(String::as_str) == Some("PATH")));
    let again = with_path(&kc, "prod-admin", "/other");
    let env2 = path_entries(&again, "admin-user").unwrap();
    assert_eq!(env2.iter().filter(|e| e.get("name").map(String::as_str) == Some("PATH")).count(), 1);
    // 다른 사용자는 건드리지 않는다
    assert!(path_entries(&kc, "arn-user").is_none());
}

#[test]
fn update_command_text() {
    assert_eq!(update_command("prod", "ap-northeast-2", "prod-ro"), "aws eks update-kubeconfig --name prod --region ap-northeast-2 --profile prod-ro");
}

#[test]
fn a_malformed_kubeconfig_never_shows_its_source_text() {
    let dir = std::env::temp_dir().join(format!("mm-k8s-kc-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("config");
    std::fs::write(&path, "apiVersion: v1\nkind: Config\nusers:\n- name: u\n  user:\n    client-key-data: SECRETVALUE\n    client-certificate-data: [unclosed\n").unwrap();
    let AppError::Other { message } = load(&[path]).err().unwrap() else { panic!() };
    std::fs::remove_dir_all(&dir).ok();
    assert!(message.starts_with("kubeconfig를 읽지 못했어요("));
    assert!(!message.contains("SECRETVALUE"), "{message}");
    assert!(!message.contains('\n'), "{message}");
}

#[test]
fn a_secret_that_serde_would_quote_is_not_shown() {
    let dir = std::env::temp_dir().join(format!("mm-k8s-kc2-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("config");
    std::fs::write(&path, "apiVersion: v1\nkind: Config\nclusters: SECRETVALUE\nusers:\n- name: u\n  user:\n    client-key-data: [ \"SECRETVALUE\" ]\n").unwrap();
    let AppError::Other { message } = load(&[path]).err().unwrap() else { panic!() };
    std::fs::remove_dir_all(&dir).ok();
    assert!(!message.contains("SECRETVALUE"), "{message}");
    assert!(message.contains(MALFORMED), "{message}");
    assert!(message.contains("줄 "), "{message}");
}
