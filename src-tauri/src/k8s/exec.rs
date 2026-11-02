//! 변경 요청을 보내는 유일한 곳. 미리보기는 서버 dry-run으로 검증한다.
use kube::api::{DeleteParams, DynamicObject, Patch, PatchParams, PostParams, Preconditions};
use kube::core::Status;
use kube::Client;
use serde_json::Value;

use super::change::apply::{conflicts_of, is_secret, FieldConflict, FIELD_MANAGER};
use super::change::{Change, Operation, Plan};
use super::failure::{describe, failure_of, Endpoint};
use super::read::api_for;
use crate::error::AppError;

pub const STALE: &str = "미리보기 이후 바뀌었어요. 다시 미리보기 해 주세요";
pub const WRITE_FAILED: &str = "클러스터에 변경을 보내지 못했어요";
pub const CONFLICT: &str = "다른 manager가 가진 필드와 충돌해요. 강제 적용으로 다시 미리보기 해 주세요";
pub const REJECTED: &str = "서버가 이 YAML을 받지 않았어요";
const REJECTION_MAX: usize = 400;

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
    if matches!(change.operation, Operation::Apply { .. }) {
        return server_apply(client, endpoint, change, plan, dry_run).await.map(|_| ()).map_err(ApplyFailure::into_error);
    }
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

/// server-side apply가 실패한 이유. 필드 충돌은 미리보기에 보여 주려고 목록으로 따로 돌려준다.
#[derive(Debug, PartialEq)]
pub enum ApplyFailure {
    Conflicts(Vec<FieldConflict>),
    Failed(AppError),
}

impl ApplyFailure {
    fn into_error(self) -> AppError {
        match self {
            ApplyFailure::Conflicts(_) => AppError::other(CONFLICT),
            ApplyFailure::Failed(error) => error,
        }
    }
}

/// 서버가 잘못된 객체라고 알려 준 이유. Secret이 아닌 객체에서만 서버 메시지를 보여 준다(값이 섞이지 않는다).
fn rejection(status: &Status) -> AppError {
    let message: String = status.message.chars().take(REJECTION_MAX).collect();
    AppError::other(format!("{REJECTED}: {message}"))
}

/// 계획의 본문을 field manager `magic-mirror`로 server-side apply한다. 돌려주는 값은 서버가 만든(dry-run이면 만들 뻔한) 객체다.
pub async fn server_apply(client: Client, endpoint: Endpoint, change: &Change, plan: &Plan, dry_run: bool) -> Result<Value, ApplyFailure> {
    let Operation::Apply { force, .. } = &change.operation else {
        return Err(ApplyFailure::Failed(AppError::other(WRITE_FAILED)));
    };
    let target = &change.target;
    let api = api_for(client, &target.kind, target.namespace.as_deref());
    let mut params = PatchParams::apply(FIELD_MANAGER);
    params.dry_run = dry_run;
    params.force = *force;
    let call = &plan.preview.calls[0];
    match api.patch(&target.name, &params, &Patch::Apply(&call.body)).await {
        Ok(object) => serde_json::to_value(object).map_err(|_| ApplyFailure::Failed(AppError::other(WRITE_FAILED))),
        Err(kube::Error::Api(status)) if status.code == 409 && !conflicts_of(&status).is_empty() => Err(ApplyFailure::Conflicts(conflicts_of(&status))),
        Err(kube::Error::Api(status)) if matches!(status.code, 400 | 422) && !is_secret(target) => Err(ApplyFailure::Failed(rejection(&status))),
        Err(other) => Err(ApplyFailure::Failed(error(other, endpoint, "patch", &target.kind.plural))),
    }
}
