//! 권한 변경의 입출력: 상태 읽기, 계획, 서버 dry-run, 적용 직전 재확인과 적용.
//! 계산(계획·영향·위험)은 `world`·`plan`·`eks`·`assess`의 순수 함수가 하고, 여기는 읽고 보내기만 한다.
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use aws_sdk_eks::Client as Eks;
use kube::Client;
use serde_json::Value;

use super::assess::Effect;
use super::plan::plan_binding;
use super::world::{binding_key, binding_target, check_batch, BindingKey, Planner, World};
use super::{is_eks, BATCH_NO_EKS};
use crate::error::AppError;
use crate::k8s::access::identity::{parse_mode, AuthMode};
use crate::k8s::access::read::{read_aws_auth, read_entries, read_rbac};
use crate::k8s::change::{Change, Plan};
use crate::k8s::commit::{current, CONFIRM_REQUIRED};
use crate::k8s::exec::{self, STALE};
use crate::k8s::failure::Endpoint;
use crate::k8s::read::eks::describe;
use crate::k8s::review::{self, Identity};

/// 읽고 보내는 데 필요한 연결 정보
pub struct Ctx {
    pub client: Client,
    pub endpoint: Endpoint,
    pub eks: Eks,
    pub cluster: String,
}

/// 충돌(409) 때 다시 계획하며 기다리는 최대 시간
const RETRY_WINDOW: Duration = Duration::from_secs(10);

fn join_error(error: tokio::task::JoinError) -> AppError {
    AppError::other(error.to_string())
}

/// 계획에 쓸 상태를 읽는다. RBAC 객체·access entry·aws-auth를 읽지 못해도 계획은 하되 `gaps`에 이유를 남겨 이름 입력을 받게 한다.
/// 변경이 건드리는 바인딩은 지금 객체를 읽고, 읽지 못하면 오류다.
pub async fn load_world(ctx: &Ctx, changes: &[Change]) -> Result<World, AppError> {
    let mut targets = Vec::new();
    for change in changes {
        if let Some(target) = binding_target(change) {
            if !targets.iter().any(|t| binding_key(t) == binding_key(target)) {
                targets.push(target.clone());
            }
        }
    }
    let objects = async {
        let mut out: BTreeMap<BindingKey, Option<Value>> = BTreeMap::new();
        for target in &targets {
            out.insert(binding_key(target), current(ctx.client.clone(), ctx.endpoint, target).await?);
        }
        Ok::<_, AppError>(out)
    };
    let (described, rbac, aws_auth, bindings) = tokio::join!(describe(&ctx.eks, &ctx.cluster), read_rbac(&ctx.client, ctx.endpoint), read_aws_auth(&ctx.client, ctx.endpoint), objects);
    let bindings = bindings?;
    let mut gaps = Vec::new();
    // 인증 모드를 읽지 못하면 두 출처가 모두 유효하다고 보고 계산한다
    let mode = described.as_ref().map_or(AuthMode::ApiAndConfigMap, |c| parse_mode(c.authentication_mode.as_deref()));
    let (entries, entries_error) = if mode == AuthMode::ConfigMap {
        (Vec::new(), None)
    } else {
        match read_entries(&ctx.eks, &ctx.cluster).await {
            Ok(entries) => (entries, None),
            Err(error) => {
                gaps.push(format!("access entry를 읽지 못해 IAM 주체의 영향이 빠졌어요: {error}"));
                (Vec::new(), Some(error.to_string()))
            }
        }
    };
    let rbac = rbac.unwrap_or_else(|error| {
        gaps.push(format!("RBAC 객체를 읽지 못해 영향을 계산하지 못했어요: {error}"));
        Default::default()
    });
    let aws_auth = aws_auth.unwrap_or_else(|error| {
        gaps.push(format!("aws-auth를 읽지 못해 영향이 빠졌어요: {error}"));
        None
    });
    Ok(World { cluster: ctx.cluster.clone(), rbac, entries, entries_error, aws_auth, mode, bindings, gaps })
}

/// 이 앱의 신원(SelfSubjectReview). 읽지 못하면 None.
async fn own_identity(ctx: &Ctx) -> Option<Identity> {
    review::identity(&ctx.client, "", ctx.endpoint).await.ok().filter(|i| !i.username.is_empty() || i.arn.is_some())
}

/// 변경 하나를 지금 상태에서 계획한다(서버 dry-run 없이).
async fn plan_now(ctx: &Ctx, change: &Change) -> Result<Plan, AppError> {
    let world = load_world(ctx, std::slice::from_ref(change)).await?;
    let identity = own_identity(ctx).await;
    let change = change.clone();
    tokio::task::spawn_blocking(move || Planner::new(world, identity.as_ref(), false).plan(&change)).await.map_err(join_error)?
}

/// 최신 상태로 계획하고 쿠버네티스 변경이면 서버 dry-run한다(EKS API에는 dry-run이 없다).
pub async fn dry_plan(ctx: &Ctx, change: &Change) -> Result<Plan, AppError> {
    let deadline = Instant::now() + RETRY_WINDOW;
    let mut plan = plan_now(ctx, change).await?;
    loop {
        if is_eks(change) {
            return Ok(plan);
        }
        match exec::run(ctx.client.clone(), ctx.endpoint, change, &plan, true).await {
            Ok(()) => return Ok(plan),
            Err(error) if error == AppError::other(STALE) && plan.version.is_some() && Instant::now() < deadline => {
                let next = plan_now(ctx, change).await?;
                if next.version == plan.version {
                    return Err(error);
                }
                plan = next;
            }
            Err(error) => return Err(error),
        }
    }
}

fn without_versions(plan: &Plan) -> Plan {
    let mut plan = plan.clone();
    plan.version = None;
    plan.fingerprint = None;
    for call in &mut plan.preview.calls {
        for pointer in ["/metadata/resourceVersion", "/preconditions/resourceVersion"] {
            if let Some(Value::String(version)) = call.body.pointer_mut(pointer) {
                version.clear();
            }
        }
    }
    plan
}

/// 두 계획이 같은가. 객체의 리소스 버전과 상태 해시는 보지 않는다: 호출(버전 조건 제외)·차이·영향·경고·이름 입력·되돌리기·실효 권한 영향이 모두 같아야 한다.
/// 미리보기 뒤 다른 곳에서 주체나 역할이 바뀌었다면 호출이나 영향이 달라져 여기서 걸린다.
pub fn same_plan(seen: &Plan, current: &Plan) -> bool {
    let (seen, current) = (without_versions(seen), without_versions(current));
    seen.preview == current.preview && seen.inverse == current.inverse
}

/// 영향과 위험 판단은 빼고 변경 자체(호출·차이·되돌리기)만 비교한다. 일괄 적용이 항목마다 바인딩 하나만 다시 읽어 확인할 때 쓴다.
fn same_change(seen: &Plan, current: &Plan) -> bool {
    let (seen, current) = (without_versions(seen), without_versions(current));
    seen.preview.calls == current.preview.calls && seen.preview.diff == current.preview.diff && seen.inverse == current.inverse
}

/// 적용 직전 확인: 미리보기와 같은 계획이고 이름 입력이 맞는가
pub fn check(seen: Option<&Plan>, current: &Plan, confirmation: Option<&str>) -> Result<(), AppError> {
    let seen = seen.ok_or_else(|| AppError::other(STALE))?;
    if !same_plan(seen, current) {
        return Err(AppError::other(STALE));
    }
    if seen.preview.confirm_name.as_deref().is_some_and(|name| Some(name) != confirmation) {
        return Err(AppError::other(CONFIRM_REQUIRED));
    }
    Ok(())
}

async fn send(ctx: &Ctx, change: &Change, plan: &Plan) -> Result<(), AppError> {
    if is_eks(change) {
        exec::eks::run(&ctx.eks, &ctx.cluster, change).await
    } else {
        exec::run(ctx.client.clone(), ctx.endpoint, change, plan, false).await
    }
}

/// 사용자가 본 계획을 다시 만들어 보고 같을 때만 적용한다. 바인딩이 그사이 버전만 바뀌었으면 새 버전으로 한 번 더 시도한다.
pub async fn apply_plan(ctx: &Ctx, change: &Change, seen: &Plan, confirmation: Option<&str>) -> Result<(Plan, Result<(), AppError>), AppError> {
    let deadline = Instant::now() + RETRY_WINDOW;
    let mut plan = dry_plan(ctx, change).await?;
    loop {
        check(Some(seen), &plan, confirmation)?;
        let result = send(ctx, change, &plan).await;
        if result != Err(AppError::other(STALE)) || plan.version.is_none() || Instant::now() >= deadline {
            return Ok((plan, result));
        }
        let next = dry_plan(ctx, change).await?;
        if next.version == plan.version {
            return Ok((plan, result));
        }
        check(Some(seen), &next, confirmation)?;
        plan = next;
    }
}

/// 일괄 미리보기 항목 하나
pub struct BatchItem {
    pub plan: Result<Plan, AppError>,
}

/// 일괄 미리보기 결과: 항목마다 앞 변경이 적용된 상태에서 만든 계획과, 전체가 적용된 뒤의 영향
pub struct BatchPlan {
    pub items: Vec<BatchItem>,
    pub total: Option<Effect>,
}

/// 변경들을 차례로 계획한다. 앞 변경에 이어서 하는 변경이 아닌 쿠버네티스 변경은 서버 dry-run도 한다.
pub async fn plan_batch(ctx: &Ctx, changes: &[Change]) -> Result<BatchPlan, AppError> {
    check_batch(changes)?;
    if changes.iter().any(is_eks) {
        return Err(AppError::other(BATCH_NO_EKS));
    }
    let world = load_world(ctx, changes).await?;
    let identity = own_identity(ctx).await;
    let list = changes.to_vec();
    let (plans, total) = tokio::task::spawn_blocking(move || {
        let mut planner = Planner::new(world, identity.as_ref(), true);
        let plans: Vec<Result<Plan, AppError>> = list.iter().map(|change| planner.plan(change)).collect();
        (plans, planner.total())
    })
    .await
    .map_err(join_error)?;
    let mut touched: Vec<BindingKey> = Vec::new();
    let mut items = Vec::new();
    for (change, plan) in changes.iter().zip(plans) {
        let key = binding_key(&change.target);
        let dependent = touched.contains(&key);
        let plan = match plan {
            Ok(plan) if !dependent => exec::run(ctx.client.clone(), ctx.endpoint, change, &plan, true).await.map(|()| plan),
            other => other,
        };
        if plan.is_ok() {
            touched.push(key);
        }
        items.push(BatchItem { plan });
    }
    Ok(BatchPlan { items, total })
}

/// 일괄 적용 직전에 모든 변경을 다시 계획해 미리보기와 같은지 확인한다. 하나라도 다르면 아무것도 적용하지 않는다.
pub async fn recheck_batch(ctx: &Ctx, changes: &[Change], seen: &[Plan]) -> Result<(), AppError> {
    let world = load_world(ctx, changes).await?;
    let identity = own_identity(ctx).await;
    let list = changes.to_vec();
    let plans = tokio::task::spawn_blocking(move || {
        let mut planner = Planner::new(world, identity.as_ref(), false);
        list.iter().map(|change| planner.plan(change)).collect::<Vec<_>>()
    })
    .await
    .map_err(join_error)?;
    if plans.len() != seen.len() || plans.iter().zip(seen).any(|(now, seen)| !now.as_ref().is_ok_and(|now| same_plan(seen, now))) {
        return Err(AppError::other(STALE));
    }
    Ok(())
}

/// 일괄 적용의 항목 하나: 그 바인딩만 다시 읽어 변경이 미리보기와 같은지 확인하고 보낸다(리소스 버전 조건과 함께).
pub async fn apply_item(ctx: &Ctx, change: &Change, seen: &Plan) -> Result<Plan, (Plan, AppError)> {
    let stale = || (seen.clone(), AppError::other(STALE));
    let target = binding_target(change).ok_or_else(stale)?;
    let object = current(ctx.client.clone(), ctx.endpoint, target).await.map_err(|e| (seen.clone(), e))?;
    let (plan, _) = plan_binding(change, object.as_ref()).map_err(|e| (seen.clone(), e))?;
    if !same_change(seen, &plan) {
        return Err(stale());
    }
    let mut applied = seen.clone();
    applied.version = plan.version.clone();
    applied.preview.calls = plan.preview.calls.clone();
    match exec::run(ctx.client.clone(), ctx.endpoint, change, &plan, false).await {
        Ok(()) => Ok(applied),
        Err(error) => Err((applied, error)),
    }
}

/// 일괄 적용에서 항목 하나의 결과
#[derive(Debug, PartialEq)]
pub enum ItemOutcome {
    Applied,
    Failed(AppError),
    Skipped,
}

/// 변경들을 순서대로 하나씩 적용한다. 항목마다 보낸 계획과 결과를 `record`에 넘기고(변경 기록), `record`가 false를 돌려주거나 항목이 실패하면
/// 거기서 멈추고 나머지는 건너뛴다. 이미 적용한 것은 그대로 남는다.
pub async fn apply_items(ctx: &Ctx, changes: &[Change], seen: &[Plan], mut record: impl FnMut(usize, &Plan, &Result<(), AppError>) -> bool) -> Vec<ItemOutcome> {
    let mut outcomes = Vec::new();
    let mut stopped = false;
    for (i, change) in changes.iter().enumerate() {
        if stopped {
            outcomes.push(ItemOutcome::Skipped);
            continue;
        }
        let (plan, outcome) = match apply_item(ctx, change, &seen[i]).await {
            Ok(plan) => (plan, Ok(())),
            Err((plan, error)) => (plan, Err(error)),
        };
        stopped = !record(i, &plan, &outcome) || outcome.is_err();
        outcomes.push(match outcome {
            Ok(()) => ItemOutcome::Applied,
            Err(error) => ItemOutcome::Failed(error),
        });
    }
    outcomes
}

#[cfg(test)]
mod tests;
