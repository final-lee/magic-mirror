//! kubeconfig 읽기와 이 클러스터를 가리키는 context 찾기. 순수 함수만 있다(파일 읽기는 `load` 하나).
//! 인증 정보(토큰, 키, 인증서)는 읽은 그대로 `kube`에 넘기고 어디에도 꺼내 쓰지 않는다.

use std::path::{Path, PathBuf};

use kube::config::{AuthInfo, Kubeconfig};
use serde::Serialize;

use super::failure::short_reason;
use kube::config::KubeconfigError;
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

pub const MALFORMED: &str = "형식이 올바르지 않아요";

/// kubeconfig 오류의 사유. YAML 해석 오류는 serde 글이 읽은 값을 따옴표로 싣곤 해서 쓰지 않고, 고정 문구에 위치(줄, 열)만 붙인다.
pub fn reason(e: &KubeconfigError) -> String {
    match e {
        KubeconfigError::Parse(parse) => match parse.location() {
            Some(at) => format!("{MALFORMED} (줄 {}, 열 {})", at.line(), at.column()),
            None => MALFORMED.to_string(),
        },
        KubeconfigError::ReadConfig(io, _) => short_reason(io),
        other => short_reason(other),
    }
}

/// 있는 파일만 읽어 합친다(kubectl처럼 같은 이름은 앞 파일이 이긴다). 하나도 없으면 `no_kubeconfig`, 읽다가 깨지면 `unreadable_kubeconfig`.
pub fn load(paths: &[PathBuf]) -> Result<Loaded, AppError> {
    let mut merged: Option<Kubeconfig> = None;
    let mut read = Vec::new();
    for path in paths {
        if !path.is_file() {
            continue;
        }
        let kc = Kubeconfig::read_from(path).map_err(|e| AppError::other(unreadable_kubeconfig(path, &reason(&e))))?;
        merged = Some(match merged {
            None => kc,
            Some(m) => m.merge(kc).map_err(|e| AppError::other(unreadable_kubeconfig(path, &reason(&e))))?,
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

/// 지정한 context와 그 context가 가리키는 cluster·user만 남긴다.
pub fn minify(config: &Kubeconfig, name: &str) -> Result<Kubeconfig, AppError> {
    let entry = config.contexts.iter().find(|entry| entry.name == name)
        .filter(|entry| entry.context.is_some())
        .ok_or_else(|| AppError::other("선택한 context를 찾지 못했어요"))?;
    let context = entry.context.as_ref().expect("context checked above");
    let cluster = config.clusters.iter().find(|entry| entry.name == context.cluster && entry.cluster.is_some())
        .ok_or_else(|| AppError::other("context의 cluster를 찾지 못했어요"))?;
    let user = match context.user.as_ref().filter(|name| !name.is_empty()) {
        Some(name) => Some(config.auth_infos.iter().find(|entry| entry.name == *name && entry.auth_info.is_some())
            .ok_or_else(|| AppError::other("context의 user를 찾지 못했어요"))?),
        None => None,
    };
    let mut result = config.clone();
    result.contexts = vec![entry.clone()];
    result.clusters = vec![cluster.clone()];
    result.auth_infos = user.into_iter().cloned().collect();
    result.current_context = Some(name.to_string());
    Ok(result)
}

#[cfg(test)]
mod tests;
