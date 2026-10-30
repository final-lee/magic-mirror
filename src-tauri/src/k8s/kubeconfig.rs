//! kubeconfig 읽기와 이 클러스터를 가리키는 context 찾기. 순수 함수만 있다(파일 읽기는 `load` 하나).
//! 인증 정보(토큰, 키, 인증서)는 읽은 그대로 `kube`에 넘기고 어디에도 꺼내 쓰지 않는다.

use std::path::{Path, PathBuf};

use kube::config::{AuthInfo, Kubeconfig};
use serde::Serialize;

use crate::error::AppError;

pub const NO_CONTEXT: &str = "kubeconfig에 이 클러스터의 context가 없어요. 터미널에서 아래 명령을 실행한 뒤 다시 열어 주세요";
pub const SEVERAL_CONTEXTS: &str = "이 클러스터를 가리키는 context가 여러 개예요. 접속할 context를 골라 주세요";

pub fn no_kubeconfig(paths: &[PathBuf]) -> String {
    let list: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
    format!("kubeconfig 파일이 없어요({}). 터미널에서 아래 명령을 실행한 뒤 다시 열어 주세요", list.join(", "))
}

pub fn unreadable_kubeconfig(path: &Path, reason: &str) -> String {
    format!("kubeconfig를 읽지 못했어요({}): {reason}", path.display())
}

pub fn update_command(cluster: &str, region: &str, profile: &str) -> String {
    format!("aws eks update-kubeconfig --name {cluster} --region {region} --profile {profile}")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: Option<String>,
    pub exec_profile: Option<String>,
}

#[derive(Debug)]
pub struct Loaded {
    pub config: Kubeconfig,
    pub paths: Vec<PathBuf>,
}

/// 읽을 파일들: 앱 설정 → `KUBECONFIG`(콜론으로 나눈 목록, 빈 칸은 건너뜀) → `~/.kube/config`. 설정의 `~/`는 홈으로 바꾼다.
pub fn kubeconfig_paths(setting: Option<&str>, env: Option<&str>, home: Option<&Path>) -> Vec<PathBuf> {
    let expand = |p: &str| match (p.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(p),
    };
    if let Some(s) = setting.map(str::trim).filter(|s| !s.is_empty()) {
        return vec![expand(s)];
    }
    if let Some(list) = env.filter(|e| !e.trim().is_empty()) {
        return list.split(':').map(str::trim).filter(|p| !p.is_empty()).map(expand).collect();
    }
    home.map(|h| vec![h.join(".kube").join("config")]).unwrap_or_default()
}

/// 있는 파일만 읽어 합친다(kubectl처럼 같은 이름은 앞 파일이 이긴다). 하나도 없으면 `no_kubeconfig`, 읽다가 깨지면 `unreadable_kubeconfig`.
pub fn load(paths: &[PathBuf]) -> Result<Loaded, AppError> {
    let mut merged: Option<Kubeconfig> = None;
    let mut read = Vec::new();
    for path in paths {
        if !path.is_file() {
            continue;
        }
        let kc = Kubeconfig::read_from(path).map_err(|e| AppError::other(unreadable_kubeconfig(path, &e.to_string())))?;
        merged = Some(match merged {
            None => kc,
            Some(m) => m.merge(kc).map_err(|e| AppError::other(unreadable_kubeconfig(path, &e.to_string())))?,
        });
        read.push(path.clone());
    }
    merged.map(|config| Loaded { config, paths: read }).ok_or_else(|| AppError::other(no_kubeconfig(paths)))
}

fn same_server(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches('/').to_ascii_lowercase();
    norm(a) == norm(b)
}

/// 이 클러스터를 가리키는 context들(kubeconfig 순서). context의 클러스터 이름이 ARN이거나 그 클러스터의 server가 엔드포인트와 같으면 맞다.
pub fn candidates(config: &Kubeconfig, arn: &str, endpoint: &str) -> Vec<Candidate> {
    config
        .contexts
        .iter()
        .filter_map(|named| {
            let ctx = named.context.as_ref()?;
            let server = config.clusters.iter().find(|c| c.name == ctx.cluster).and_then(|c| c.cluster.as_ref()).and_then(|c| c.server.clone());
            let hit = ctx.cluster == arn || server.is_some_and(|s| same_server(&s, endpoint));
            if !hit {
                return None;
            }
            let user = ctx.user.clone().unwrap_or_default();
            let exec_profile = config.auth_infos.iter().find(|u| u.name == user).and_then(|u| u.auth_info.as_ref()).and_then(exec_profile);
            Some(Candidate { name: named.name.clone(), cluster: ctx.cluster.clone(), user, namespace: ctx.namespace.clone(), exec_profile })
        })
        .collect()
}

/// 저장해 둔 context가 아직 후보면 그것, 아니면 후보가 하나일 때 그것. 두 번째 값은 사라진 저장값(안내용).
pub fn choose(candidates: &[Candidate], saved: Option<&str>) -> (Option<String>, Option<String>) {
    if let Some(saved) = saved {
        if candidates.iter().any(|c| c.name == saved) {
            return (Some(saved.to_string()), None);
        }
    }
    let missing = saved.map(str::to_string);
    match candidates {
        [only] => (Some(only.name.clone()), missing),
        _ => (None, missing),
    }
}

/// exec 플러그인이 쓰는 AWS 프로필: `--profile x`, `--profile=x`, 그다음 env의 `AWS_PROFILE`.
pub fn exec_profile(user: &AuthInfo) -> Option<String> {
    let exec = user.exec.as_ref()?;
    let args = exec.args.clone().unwrap_or_default();
    for (i, arg) in args.iter().enumerate() {
        if let Some(v) = arg.strip_prefix("--profile=") {
            return Some(v.to_string());
        }
        if arg == "--profile" {
            if let Some(v) = args.get(i + 1) {
                return Some(v.clone());
            }
        }
    }
    exec.env.as_ref()?.iter().find(|e| e.get("name").map(String::as_str) == Some("AWS_PROFILE")).and_then(|e| e.get("value").cloned())
}

/// macOS 앱은 셸의 PATH를 물려받지 않는다. context 사용자의 exec env에 PATH가 없으면 넣은 사본을 돌려준다.
pub fn with_path(config: &Kubeconfig, context: &str, path: &str) -> Kubeconfig {
    let mut kc = config.clone();
    let Some(user) = kc.contexts.iter().find(|c| c.name == context).and_then(|c| c.context.as_ref()).and_then(|c| c.user.clone()) else {
        return kc;
    };
    if let Some(exec) = kc.auth_infos.iter_mut().find(|u| u.name == user).and_then(|u| u.auth_info.as_mut()).and_then(|a| a.exec.as_mut()) {
        let env = exec.env.get_or_insert_with(Vec::new);
        if !env.iter().any(|e| e.get("name").map(String::as_str) == Some("PATH")) {
            env.push([("name".to_string(), "PATH".to_string()), ("value".to_string(), path.to_string())].into_iter().collect());
        }
    }
    kc
}

#[cfg(test)]
mod tests {
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
}
