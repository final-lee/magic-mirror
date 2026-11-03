//! kubeconfig 자격 증명은 만료 직전까지 메모리에만 둔다.
use crate::{
    error::AppError,
    k8s::{
        failure::{self, Endpoint},
        kubeconfig, path,
    },
};
use chrono::{DateTime, Duration, Utc};
use kube::config::{AuthInfo, Kubeconfig};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tokio::sync::Mutex;

#[derive(Clone)]
struct Credential {
    token: String,
    expiry: Option<DateTime<Utc>>,
}
impl Credential {
    fn valid(&self, now: DateTime<Utc>) -> bool {
        self.expiry.is_some_and(|e| e > now + Duration::minutes(1))
    }
}
fn parse_credential(bytes: &[u8]) -> Result<Credential, AppError> {
    let v: Value = serde_json::from_slice(bytes).map_err(|_| AppError::other(failure::exec_failed(failure::EXEC_OUTPUT_UNPARSEABLE)))?;
    let token = v
        .pointer("/status/token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::other(failure::exec_failed(failure::EXEC_OUTPUT_UNPARSEABLE)))?;
    let expiry = v
        .pointer("/status/expirationTimestamp")
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc));
    Ok(Credential {
        token: token.to_owned(),
        expiry,
    })
}

pub fn load(settings_path: &Path) -> Result<kubeconfig::Loaded, AppError> {
    use std::sync::{LazyLock, Mutex as SyncMutex};
    use std::time::SystemTime;
    struct Cached {
        settings: PathBuf,
        environment: Option<String>,
        home: Option<PathBuf>,
        paths: Vec<PathBuf>,
        stamps: Vec<Option<SystemTime>>,
        loaded: kubeconfig::Loaded,
    }
    static CACHE: LazyLock<SyncMutex<Option<Cached>>> = LazyLock::new(|| SyncMutex::new(None));
    let environment = std::env::var("KUBECONFIG").ok();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let stamp = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cached) = cache.as_ref() {
        let stamps: Vec<_> = std::iter::once(settings_path)
            .chain(cached.paths.iter().map(PathBuf::as_path))
            .map(stamp)
            .collect();
        if cached.settings == settings_path && cached.environment == environment && cached.home == home && cached.stamps == stamps {
            return Ok(kubeconfig::Loaded {
                config: cached.loaded.config.clone(),
                paths: cached.loaded.paths.clone(),
            });
        }
    }
    let setting = crate::settings::load(settings_path, &[]).kubeconfig_path;
    let paths = kubeconfig::kubeconfig_paths(setting.as_deref(), environment.as_deref(), home.as_deref());
    let loaded = kubeconfig::load(&paths)?;
    let stamps = std::iter::once(settings_path).chain(paths.iter().map(PathBuf::as_path)).map(stamp).collect();
    let result = kubeconfig::Loaded {
        config: loaded.config.clone(),
        paths: loaded.paths.clone(),
    };
    *cache = Some(Cached {
        settings: settings_path.to_owned(),
        environment,
        home,
        paths,
        stamps,
        loaded,
    });
    Ok(result)
}
fn user<'a>(config: &'a Kubeconfig, context: &str) -> Result<&'a AuthInfo, AppError> {
    let name = config
        .contexts
        .iter()
        .find(|c| c.name == context)
        .and_then(|c| c.context.as_ref())
        .and_then(|c| c.user.as_ref())
        .ok_or_else(|| AppError::other("kubeconfig context를 찾지 못했어요"))?;
    config
        .auth_infos
        .iter()
        .find(|u| &u.name == name)
        .and_then(|u| u.auth_info.as_ref())
        .ok_or_else(|| AppError::other("kubeconfig 사용자를 찾지 못했어요"))
}
pub fn profile(config: &Kubeconfig, context: &str) -> Option<String> {
    user(config, context).ok().and_then(kubeconfig::exec_profile)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    name: String,
    cluster: String,
    server: Option<String>,
    sso_profile: Option<String>,
}
pub fn contexts(config: &Kubeconfig) -> Vec<Context> {
    config
        .contexts
        .iter()
        .filter_map(|c| {
            let ctx = c.context.as_ref()?;
            let cluster = ctx.cluster.clone();
            let server = config
                .clusters
                .iter()
                .find(|x| x.name == cluster)
                .and_then(|x| x.cluster.as_ref())
                .and_then(|x| x.server.clone());
            Some(Context {
                name: c.name.clone(),
                cluster,
                server,
                sso_profile: profile(config, &c.name),
            })
        })
        .collect()
}
/// 캐시 열쇠: context 이름에 그 사용자 설정(명령·인자·env·토큰)의 해시를 붙인다. kubeconfig를 바꿔 같은 이름의 context가
/// 다른 신원을 가리키면 새 열쇠라 이전 신원의 토큰을 쓰지 않는다.
fn cache_key(context: &str, user: &Value) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    user.to_string().hash(&mut h);
    format!("{context}\u{0}{:016x}", h.finish())
}
#[derive(Default)]
pub struct Auth {
    cache: Mutex<HashMap<String, Credential>>,
}
impl Auth {
    pub async fn token(&self, config: &Kubeconfig, context: &str, refresh: bool) -> Result<String, AppError> {
        let mut cache = self.cache.lock().await;
        let user = user(config, context)?;
        // AuthInfo의 SecretString 직렬화는 명시적으로 선택한 토큰만 사용한다.
        let value = serde_json::to_value(user).map_err(|_| AppError::other("kubeconfig 사용자를 읽지 못했어요"))?;
        let key = cache_key(context, &value);
        if !refresh {
            if let Some(c) = cache.get(&key).filter(|c| c.valid(Utc::now())) {
                return Ok(c.token.clone());
            }
        }
        if let Some(token) = value.get("token").and_then(Value::as_str).filter(|t| !t.is_empty()) {
            return Ok(token.to_string());
        }
        let exec = user
            .exec
            .as_ref()
            .ok_or_else(|| AppError::other(failure::exec_failed("토큰이나 인증 명령이 없어요")))?;
        let command = exec
            .command
            .as_deref()
            .filter(|c| !c.is_empty())
            .ok_or_else(|| AppError::other(failure::exec_failed("인증 명령이 없어요")))?;
        let mut cmd = tokio::process::Command::new(command);
        cmd.args(exec.args.as_deref().unwrap_or_default())
            .env("PATH", path::login_path().await)
            .kill_on_drop(true);
        if let Some(env) = &exec.env {
            for e in env {
                if let (Some(k), Some(v)) = (e.get("name"), e.get("value")) {
                    cmd.env(k, v);
                }
            }
        }
        let mut info = json!({"apiVersion": exec.api_version.as_deref().unwrap_or("client.authentication.k8s.io/v1beta1"), "kind": "ExecCredential", "spec": {"interactive": false}});
        if exec.provide_cluster_info {
            if let Some(cluster) = config
                .contexts
                .iter()
                .find(|c| c.name == context)
                .and_then(|c| c.context.as_ref())
                .and_then(|c| config.clusters.iter().find(|cluster| cluster.name == c.cluster))
                .and_then(|c| c.cluster.as_ref())
            {
                info["spec"]["cluster"] = serde_json::to_value(cluster).unwrap_or(Value::Null);
            }
        }
        cmd.env("KUBERNETES_EXEC_INFO", info.to_string());
        let output = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output())
            .await
            .map_err(|_| AppError::other(failure::exec_failed(crate::k8s::connect::EXEC_TIMEOUT_REASON)))?
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    AppError::other(failure::exec_missing(command))
                } else {
                    AppError::other(failure::exec_failed("인증 명령을 실행하지 못했어요"))
                }
            })?;
        if !output.status.success() {
            return Err(failure::describe(
                &failure::exec_failure(&String::from_utf8_lossy(&output.stderr)),
                Endpoint { public: true, private: true },
            ));
        }
        let credential = parse_credential(&output.stdout)?;
        let token = credential.token.clone();
        cache.insert(key, credential);
        Ok(token)
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    fn config_printing(token: &str) -> Kubeconfig {
        let script = format!("printf '%s' '{{\"status\":{{\"token\":\"{token}\",\"expirationTimestamp\":\"2099-01-01T00:00:00Z\"}}}}'");
        let yaml = json!({
            "apiVersion": "v1", "kind": "Config",
            "clusters": [{ "name": "c", "cluster": { "server": "https://example.test" } }],
            "contexts": [{ "name": "same", "context": { "cluster": "c", "user": "u" } }],
            "users": [{ "name": "u", "user": { "exec": { "apiVersion": "client.authentication.k8s.io/v1beta1", "command": "/bin/sh", "args": ["-c", script] } } }]
        });
        serde_json::from_value(yaml).unwrap()
    }

    #[tokio::test]
    async fn a_context_with_the_same_name_in_another_kubeconfig_does_not_reuse_the_old_token() {
        let auth = Auth::default();
        assert_eq!(auth.token(&config_printing("first-user"), "same", false).await.unwrap(), "first-user");
        assert_eq!(auth.token(&config_printing("first-user"), "same", false).await.unwrap(), "first-user");
        assert_eq!(auth.token(&config_printing("second-user"), "same", false).await.unwrap(), "second-user");
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argowf_exec_credential_expiry() {
        let c = parse_credential(br#"{"status":{"token":"secret","expirationTimestamp":"2030-01-01T00:00:00Z"}}"#).unwrap();
        assert!(c.valid(DateTime::parse_from_rfc3339("2029-12-31T23:58:59Z").unwrap().with_timezone(&Utc)));
        assert!(!c.valid(DateTime::parse_from_rfc3339("2029-12-31T23:59:00Z").unwrap().with_timezone(&Utc)));
        assert!(parse_credential(br#"{"status":{}}"#).is_err());
    }
}
