//! 변경 요청을 보내는 유일한 곳. 미리보기는 서버 dry-run으로 검증한다.
use kube::api::{DeleteParams, DynamicObject, Patch, PatchParams, PostParams, Preconditions};
use kube::Client;

use super::change::{Change, Operation, Plan};
use super::failure::{describe, failure_of, Endpoint};
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
