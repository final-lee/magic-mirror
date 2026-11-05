//! 리소스 액션 목록 읽기와, kubeconfig context를 EKS 클러스터에 이어 주는 정보.
use kube::config::Kubeconfig;
use serde::Serialize;
use serde_json::Value;

use super::{list, text};
use crate::k8s::kubeconfig::exec_profile;

/// 액션이 받는 인자 하나. 서버가 주는 `type`·`default`는 있으면 그대로 싣는다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionParam {
    pub name: String,
    pub value: Option<String>,
    /// 인자 종류(`string`·`number`·`boolean` 등). 서버가 안 주면 null
    pub kind: Option<String>,
    pub default: Option<String>,
}

/// 리소스에서 실행할 수 있는 액션 하나(`resource/actions`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceAction {
    pub name: String,
    pub display_name: Option<String>,
    pub disabled: bool,
    pub icon_class: Option<String>,
    pub params: Vec<ActionParam>,
}

fn opt(v: &Value, path: &str) -> Option<String> {
    text(v, path).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// 액션 목록 응답에서 이름이 있는 것만, 서버가 준 순서대로.
pub fn action_rows(body: &Value) -> Vec<ResourceAction> {
    list(body, "/actions")
        .iter()
        .filter_map(|a| {
            let name = opt(a, "/name")?;
            let params = list(a, "/params")
                .iter()
                .filter_map(|p| {
                    Some(ActionParam {
                        name: opt(p, "/name")?,
                        value: opt(p, "/value"),
                        kind: opt(p, "/type"),
                        default: opt(p, "/default"),
                    })
                })
                .collect();
            Some(ResourceAction {
                name,
                display_name: opt(a, "/displayName"),
                disabled: a.get("disabled").and_then(Value::as_bool).unwrap_or(false),
                icon_class: opt(a, "/iconClass"),
                params,
            })
        })
        .collect()
}

/// kubeconfig context 하나. EKS 클러스터를 가리키면 `eks`에 리전과 클러스터 이름이 있다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeContext {
    pub name: String,
    pub cluster: String,
    pub server: Option<String>,
    /// exec 플러그인의 AWS 프로필
    pub profile: Option<String>,
    pub eks: Option<EksCluster>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EksCluster {
    pub region: String,
    pub name: String,
}

/// `--flag value`·`--flag=value`로 준 인자 값(여러 이름 중 먼저 나온 것).
fn arg(args: &[String], flags: &[&str]) -> Option<String> {
    args.iter().enumerate().find_map(|(i, a)| {
        flags.iter().find_map(|f| match a.strip_prefix(&format!("{f}=")) {
            Some(v) => Some(v.to_owned()),
            None => (a == f).then(|| args.get(i + 1).cloned()).flatten(),
        })
    })
}

/// `https://<id>.gr7.<region>.eks.amazonaws.com`에서 리전.
fn region_of_server(server: &str) -> Option<String> {
    let host = server.split("://").nth(1)?.split(['/', ':']).next()?;
    let parts: Vec<&str> = host.split('.').collect();
    let at = parts.iter().position(|p| *p == "eks")?;
    (at > 0 && parts.get(at + 1) == Some(&"amazonaws")).then(|| parts[at - 1].to_owned())
}

/// 클러스터 항목 이름(ARN이면 거기서), exec 인자(`--cluster-name`·`--region`), 서버 주소 순으로 EKS 클러스터를 찾는다. 이름을 모르면 None.
pub fn eks_of(cluster: &str, server: Option<&str>, args: &[String]) -> Option<EksCluster> {
    let from_arn = cluster.strip_prefix("arn:aws:eks:").and_then(|rest| {
        let parts: Vec<&str> = rest.split(':').collect();
        Some((parts.first()?.to_string(), parts.get(2)?.strip_prefix("cluster/")?.to_owned()))
    });
    let name = from_arn.as_ref().map(|(_, n)| n.clone()).or_else(|| arg(args, &["--cluster-name", "--cluster-id", "-i"]))?;
    let region = from_arn
        .map(|(r, _)| r)
        .or_else(|| arg(args, &["--region"]))
        .or_else(|| server.and_then(region_of_server))?;
    Some(EksCluster { region, name })
}

/// kubeconfig의 모든 context. 인증 정보는 프로필 이름과 클러스터 인자만 읽는다.
pub fn kube_contexts(config: &Kubeconfig) -> Vec<KubeContext> {
    config
        .contexts
        .iter()
        .filter_map(|named| {
            let ctx = named.context.as_ref()?;
            let server = config
                .clusters
                .iter()
                .find(|c| c.name == ctx.cluster)
                .and_then(|c| c.cluster.as_ref())
                .and_then(|c| c.server.clone());
            let user = ctx
                .user
                .as_deref()
                .and_then(|u| config.auth_infos.iter().find(|a| a.name == u))
                .and_then(|a| a.auth_info.as_ref());
            let args = user.and_then(|u| u.exec.as_ref()).and_then(|e| e.args.clone()).unwrap_or_default();
            Some(KubeContext {
                name: named.name.clone(),
                eks: eks_of(&ctx.cluster, server.as_deref(), &args),
                cluster: ctx.cluster.clone(),
                server,
                profile: user.and_then(exec_profile),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests;
