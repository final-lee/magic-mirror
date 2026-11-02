//! 변경 요청을 보내는 유일한 곳. 미리보기는 서버 dry-run으로 검증한다.
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, DeleteParams, DynamicObject, Patch, PatchParams, PostParams, Preconditions};
use kube::core::Status;
use kube::Client;
use serde_json::json;

use super::change::{Change, Operation, Plan};
use super::connect::REQUEST_TIMEOUT;
use super::failure::{describe, failure_of, Endpoint, Failure};
use super::read::api_for;
use crate::error::AppError;

pub const STALE: &str = "미리보기 이후 바뀌었어요. 다시 미리보기 해 주세요";
pub const WRITE_FAILED: &str = "클러스터에 변경을 보내지 못했어요";

/// 서버가 돌려준 메시지에는 본문이나 비밀 값이 섞일 수 있어 쓰지 않는다.
fn error(error: kube::Error, endpoint: Endpoint, verb: &str, resource: &str) -> AppError {
    if matches!(&error, kube::Error::Api(e) if e.code == 409) {
        return AppError::other(STALE);
    }
    match &error {
        kube::Error::Api(e) if e.code != 401 && e.code != 403 => AppError::other(WRITE_FAILED),
        _ => describe(&failure_of(&error, verb, resource), endpoint),
    }
}

/// 같은 요청을 먼저 dry-run으로, 확인 후 실제로 실행한다.
pub async fn run(client: Client, endpoint: Endpoint, change: &Change, plan: &Plan, dry_run: bool) -> Result<(), AppError> {
    let mut target = change.target.clone();
    if matches!(change.operation, Operation::Rerun { .. }) {
        target.kind.kind = "Job".into();
        target.kind.plural = "jobs".into();
    }
    let api = api_for(client, &target.kind, target.namespace.as_deref());
    let call = &plan.preview.calls[0];
    let resource = target.kind.plural.as_str();
    let result = match call.verb.as_str() {
        "PATCH" => {
            let params = PatchParams { dry_run, ..PatchParams::default() };
            if matches!(change.operation, Operation::RolloutUndo { .. }) {
                api.patch(&target.name, &params, &Patch::Strategic(&call.body)).await.map(|_| ())
            } else {
                api.patch(&target.name, &params, &Patch::Merge(&call.body)).await.map(|_| ())
            }
        }
        "DELETE" => {
            let params = DeleteParams { dry_run, preconditions: Some(Preconditions { resource_version: plan.version.clone(), uid: None }), ..DeleteParams::default() };
            api.delete(&target.name, &params).await.map(|_| ())
        }
        "POST" => {
            let object: DynamicObject = serde_json::from_value(call.body.clone()).map_err(|_| AppError::other(WRITE_FAILED))?;
            let params = PostParams { dry_run, ..PostParams::default() };
            api.create(&params, &object).await.map(|_| ())
        }
        _ => return Err(AppError::other(WRITE_FAILED)),
    };
    result.map_err(|e| error(e, endpoint, &call.verb.to_lowercase(), resource))
}

/// Pod 하나를 Eviction한 결과
#[derive(Clone, Debug, PartialEq)]
pub enum Eviction {
    Evicted,
    /// 이미 없거나(404), 같은 이름의 다른 Pod로 바뀌었다(UID 조건이 맞지 않아 409)
    Gone,
    /// PodDisruptionBudget이 막았다(429). 나중에 다시 시도할 수 있다
    Blocked,
    /// 이 Pod만 실패했다. 다른 Pod는 계속할 수 있다
    Failed(AppError),
    /// 권한이 없거나 연결이 끊겨 다른 Pod도 계속할 수 없다
    Fatal(AppError),
}

/// Pod 하나에 Eviction을 만든다. 본문의 UID 조건으로 계획을 본 뒤 같은 이름으로 다시 만들어진 Pod는 건드리지 않는다.
/// kube의 `evict`는 `deleteOptions`를 잘못된 이름으로 보내 조건이 사라지므로 하위 리소스를 직접 만든다.
pub async fn evict(client: Client, endpoint: Endpoint, namespace: &str, name: &str, uid: &str) -> Eviction {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let body = json!({
        "apiVersion": "policy/v1",
        "kind": "Eviction",
        "metadata": {"name": name, "namespace": namespace},
        "deleteOptions": {"preconditions": {"uid": uid}},
    });
    let params = PostParams::default();
    let request = api.create_subresource::<_, Status>("eviction", name, &params, &body);
    match tokio::time::timeout(REQUEST_TIMEOUT, request).await {
        Err(_) => Eviction::Fatal(describe(&Failure::Unreachable, endpoint)),
        Ok(Ok(_)) => Eviction::Evicted,
        Ok(Err(kube::Error::Api(status))) if matches!(status.code, 404 | 409) => Eviction::Gone,
        Ok(Err(kube::Error::Api(status))) if status.code == 429 => Eviction::Blocked,
        Ok(Err(kube::Error::Api(status))) if status.code != 401 && status.code != 403 => Eviction::Failed(AppError::other(WRITE_FAILED)),
        Ok(Err(error)) => Eviction::Fatal(describe(&failure_of(&error, "create", "pods/eviction"), endpoint)),
    }
}

#[cfg(test)]
mod tests;
