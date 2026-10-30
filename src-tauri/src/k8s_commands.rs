//! EKS 탭의 명령. 대상(프로필·리전·클러스터)마다 열린 연결 하나(`Session`)를 둔다.
//! 열기는 시작할 때 대상의 닫힌 횟수(`epoch`)를 읽어 두고, 끝날 때 그사이 닫혔으면 연결을 버린다(PG 탭과 같은 규칙).
//! 잠금 순서: `epochs` 다음에 `sessions`. 두 잠금을 함께 잡는 곳은 모두 이 순서를 지킨다.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::State;

use crate::commands::AppState;
use crate::error::AppError;
use crate::k8s::connect;
use crate::k8s::failure::{describe, failure_of, Endpoint, NOT_OPENED};
use crate::k8s::kubeconfig::{self, Candidate, NO_CONTEXT};
use crate::k8s::review::{self, Identity, Rules};
use crate::k8s::target::{describe_cluster, K8sTarget};

pub struct Session {
    pub client: kube::Client,
    pub endpoint: Endpoint,
    pub context: String,
}

#[derive(Default)]
pub struct K8sState {
    sessions: Mutex<HashMap<K8sTarget, Arc<Session>>>,
    epochs: Mutex<HashMap<K8sTarget, u64>>,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl K8sState {
    pub fn epoch(&self, t: &K8sTarget) -> u64 {
        *locked(&self.epochs).get(t).unwrap_or(&0)
    }

    /// 시작할 때의 `epoch`와 같을 때만 넣는다. 다르면(그사이 닫힘) false.
    pub fn keep(&self, t: &K8sTarget, started: u64, session: Session) -> bool {
        let epochs = locked(&self.epochs);
        if *epochs.get(t).unwrap_or(&0) != started {
            return false;
        }
        locked(&self.sessions).insert(t.clone(), Arc::new(session));
        true
    }

    pub fn close(&self, t: &K8sTarget) {
        let mut epochs = locked(&self.epochs);
        *epochs.entry(t.clone()).or_insert(0) += 1;
        locked(&self.sessions).remove(t);
    }

    pub fn session(&self, t: &K8sTarget) -> Result<Arc<Session>, AppError> {
        locked(&self.sessions).get(t).cloned().ok_or_else(|| AppError::other(NOT_OPENED))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sContextInfo {
    pub arn: String,
    pub endpoint: String,
    pub version: String,
    pub endpoint_public: bool,
    pub endpoint_private: bool,
    pub public_cidrs: Vec<String>,
    pub kubeconfig_paths: Vec<String>,
    pub kubeconfig_missing: bool,
    pub candidates: Vec<Candidate>,
    pub chosen: Option<String>,
    pub saved_missing: Option<String>,
    pub update_command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sSession {
    pub context: String,
    pub exec_profile: Option<String>,
    pub identity: Identity,
    pub server_version: String,
}

fn kubeconfig_search(setting: Option<&str>) -> Vec<PathBuf> {
    let env = std::env::var("KUBECONFIG").ok();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    kubeconfig::kubeconfig_paths(setting, env.as_deref(), home.as_deref())
}

/// 어느 경로에도 파일이 없을 때만 true
fn none_exists(paths: &[PathBuf]) -> bool {
    !paths.iter().any(|p| p.is_file())
}

fn display_paths(paths: &[PathBuf]) -> Vec<String> {
    paths.iter().map(|p| p.display().to_string()).collect()
}

#[tauri::command]
pub async fn k8s_context(app: State<'_, AppState>, target: K8sTarget, kubeconfig: Option<String>, saved: Option<String>) -> Result<K8sContextInfo, AppError> {
    let cfg = app.ctx.config(&target.profile, &target.region).await?;
    let info = describe_cluster(&cfg, &target.cluster).await?;
    let update_command = kubeconfig::update_command(&target.cluster, &target.region, &target.profile);
    let paths = kubeconfig_search(kubeconfig.as_deref());
    let missing = none_exists(&paths);
    let (loaded_paths, candidates) = if missing {
        (display_paths(&paths), vec![])
    } else {
        let loaded = kubeconfig::load(&paths)?;
        (display_paths(&loaded.paths), kubeconfig::candidates(&loaded.config, &info.arn, &info.endpoint))
    };
    let (chosen, saved_missing) = kubeconfig::choose(&candidates, saved.as_deref());
    Ok(K8sContextInfo {
        arn: info.arn,
        endpoint: info.endpoint,
        version: info.version,
        endpoint_public: info.endpoint_public,
        endpoint_private: info.endpoint_private,
        public_cidrs: info.public_cidrs,
        kubeconfig_paths: loaded_paths,
        kubeconfig_missing: missing,
        candidates,
        chosen,
        saved_missing,
        update_command,
    })
}

#[tauri::command]
pub async fn k8s_open(app: State<'_, AppState>, k8s: State<'_, K8sState>, target: K8sTarget, kubeconfig: Option<String>, context: String) -> Result<K8sSession, AppError> {
    let started = k8s.epoch(&target);
    let cfg = app.ctx.config(&target.profile, &target.region).await?;
    let info = describe_cluster(&cfg, &target.cluster).await?;
    let endpoint = Endpoint { public: info.endpoint_public, private: info.endpoint_private };
    let loaded = kubeconfig::load(&kubeconfig_search(kubeconfig.as_deref()))?;
    let candidate = kubeconfig::candidates(&loaded.config, &info.arn, &info.endpoint)
        .into_iter()
        .find(|c| c.name == context)
        .ok_or_else(|| AppError::other(NO_CONTEXT))?;
    let client = connect::connect(&loaded, &context, endpoint).await?;
    let identity = review::identity(&client, &candidate.user, endpoint).await?;
    let version = client.apiserver_version().await.map_err(|e| describe(&failure_of(&e, "get", "version"), endpoint))?;
    let session = Session { client, endpoint, context: context.clone() };
    if !k8s.keep(&target, started, session) {
        return Err(AppError::other(NOT_OPENED));
    }
    Ok(K8sSession { context, exec_profile: candidate.exec_profile, identity, server_version: version.git_version })
}

#[tauri::command]
pub fn k8s_close(k8s: State<'_, K8sState>, target: K8sTarget) {
    k8s.close(&target);
}

#[tauri::command]
pub async fn k8s_rules(k8s: State<'_, K8sState>, target: K8sTarget, namespace: String) -> Result<Rules, AppError> {
    let s = k8s.session(&target)?;
    review::rules(&s.client, &namespace, s.endpoint).await
}

#[cfg(test)]
mod tests;
