//! 계획에 쓰는 한 시점의 상태(RBAC 객체, access entry, aws-auth)와, 변경을 차례로 적용해 보며 계획하는 `Planner`(순수).
//! 장바구니는 변경 하나하나를 앞 변경이 적용된 상태에서 계획하므로 같은 바인딩을 여러 번 고치거나 방금 만든 바인딩을 고쳐도 미리보기가 맞는다.
use std::collections::BTreeMap;

use serde_json::Value;

use super::assess::{effect_between, finish, locate_own, Effect, Own};
use super::{eks, is_binding, plan::plan_binding, BATCH_DUPLICATE, BATCH_MAX, BATCH_TOO_LARGE};
use crate::error::AppError;
use crate::k8s::access::engine::{evaluate, Evaluation, Principal};
use crate::k8s::access::identity::{principals, resolve, AuthMode, AwsAuth, EntryInput};
use crate::k8s::access::rbac::{binding_of, cluster_binding_of, Binding, Rbac};
use crate::k8s::change::{Change, ChangeObject, Plan, MISSING_VERSION};
use crate::k8s::review::Identity;
use k8s_openapi::api::rbac::v1 as k;

/// (종류, 네임스페이스, 이름)
pub type BindingKey = (String, String, String);

pub fn binding_key(target: &ChangeObject) -> BindingKey {
    (target.kind.kind.clone(), target.namespace.clone().unwrap_or_default(), target.name.clone())
}

/// 변경이 읽어 둬야 하는 바인딩(바인딩 변경이면 그 대상)
pub fn binding_target(change: &Change) -> Option<&ChangeObject> {
    (!super::is_eks(change) && is_binding(&change.target.kind)).then_some(&change.target)
}

#[derive(Clone)]
pub struct World {
    pub cluster: String,
    pub rbac: Rbac,
    pub entries: Vec<EntryInput>,
    /// access entry를 읽지 못한 이유. 있으면 access entry 변경은 계획하지 않는다.
    pub entries_error: Option<String>,
    pub aws_auth: Option<AwsAuth>,
    pub mode: AuthMode,
    /// 계획할 변경이 건드리는 바인딩의 지금 객체(없으면 None). 변경을 적용해 가며 갱신된다.
    pub bindings: BTreeMap<BindingKey, Option<Value>>,
    /// 영향을 끝까지 계산하지 못한 이유들(RBAC 객체나 access entry를 읽지 못함)
    pub gaps: Vec<String>,
}

/// 변경 하나를 계획한 결과. 적용해 보기 전의 상태는 바뀌지 않았다.
struct Stepped {
    plan: Plan,
    /// 변경이 만들거나 고치는 바인딩 객체(적용 전 객체 포함, 판단에 쓴다)
    object: Option<Value>,
    binding: Option<(BindingKey, Option<Value>)>,
    entries: Option<Vec<EntryInput>>,
}

impl World {
    pub fn principals(&self) -> Vec<Principal> {
        principals(&resolve(self.mode, &self.entries, self.aws_auth.as_ref()))
    }

    pub fn evaluate(&self, extra: Option<&Principal>) -> Evaluation {
        let mut list = self.principals();
        list.extend(extra.cloned());
        evaluate(self.rbac.clone(), list)
    }

    fn step(&self, change: &Change) -> Result<Stepped, AppError> {
        if super::is_eks(change) {
            if let Some(error) = &self.entries_error {
                return Err(AppError::other(error.clone()));
            }
            let (plan, entries) = eks::plan_entry(change, &self.cluster, &self.entries, self.mode)?;
            return Ok(Stepped { plan, object: None, binding: None, entries: Some(entries) });
        }
        let target = binding_target(change).ok_or_else(|| AppError::other(crate::k8s::change::INVALID_CHANGE))?;
        let key = binding_key(target);
        let current = self.bindings.get(&key).ok_or_else(|| AppError::other(MISSING_VERSION))?;
        let (plan, next) = plan_binding(change, current.as_ref())?;
        // 위험 판단은 만들거나 고치는 바인딩을 본다(지울 때는 지우는 바인딩)
        let object = match &change.operation {
            crate::k8s::change::Operation::BindingCreate { object } => Some(object.clone()),
            _ => current.clone(),
        };
        Ok(Stepped { plan, object, binding: Some((key, next)), entries: None })
    }

    /// 바인딩 하나를 RBAC 객체 모음에서 바꾸거나(`next`) 뺀다(None).
    fn set_binding(&mut self, key: &BindingKey, next: Option<&Value>) {
        let cluster = key.0 == "ClusterRoleBinding";
        let list: &mut Vec<Binding> = if cluster { &mut self.rbac.cluster_bindings } else { &mut self.rbac.bindings };
        list.retain(|b| !(b.name == key.2 && b.namespace.clone().unwrap_or_default() == key.1));
        let Some(value) = next else { return };
        let parsed = if cluster {
            serde_json::from_value::<k::ClusterRoleBinding>(value.clone()).ok().and_then(|b| cluster_binding_of(&b))
        } else {
            serde_json::from_value::<k::RoleBinding>(value.clone()).ok().and_then(|b| binding_of(&b))
        };
        list.extend(parsed);
    }

    fn apply(&mut self, stepped: &Stepped) {
        if let Some((key, next)) = &stepped.binding {
            self.set_binding(key, next.as_ref());
            self.bindings.insert(key.clone(), next.clone());
        }
        if let Some(entries) = &stepped.entries {
            self.entries = entries.clone();
        }
    }
}

/// 변경을 하나씩 앞 변경이 적용된 상태에서 계획한다. 계획마다 실효 권한 영향과 위험 판단이 붙는다.
pub struct Planner {
    world: World,
    own: Option<Own>,
    /// 처음 상태(일괄 전체의 영향을 구하려고 둔다)
    start: Option<Evaluation>,
    current: Evaluation,
}

impl Planner {
    /// `identity`는 이 앱의 신원(읽지 못했으면 None). `keep_start`면 `total`로 전체 영향을 구할 수 있다.
    pub fn new(world: World, identity: Option<&Identity>, keep_start: bool) -> Planner {
        let own = identity.map(|identity| locate_own(identity, &world.principals()));
        let extra = own.as_ref().and_then(|o| o.extra.as_ref());
        let current = world.evaluate(extra);
        let start = keep_start.then(|| world.evaluate(extra));
        Planner { world, own, start, current }
    }

    fn gaps(&self, mut effect: Effect) -> Effect {
        if !self.world.gaps.is_empty() {
            effect.unavailable = Some(self.world.gaps.join("; "));
        }
        effect
    }

    /// 변경 하나를 계획하고 그 변경을 적용한 상태로 넘어간다. 실패하면 상태는 그대로다.
    pub fn plan(&mut self, change: &Change) -> Result<Plan, AppError> {
        let mut stepped = self.world.step(change)?;
        self.world.apply(&stepped);
        let extra = self.own.as_ref().and_then(|o| o.extra.as_ref());
        let after = self.world.evaluate(extra);
        let effect = self.gaps(effect_between(&self.current, &after, self.own.as_ref().map(|o| &o.subject)));
        finish(&mut stepped.plan, change, stepped.object.as_ref(), effect);
        self.current = after;
        Ok(stepped.plan)
    }

    /// 지금까지 계획한 변경 전체의 영향(`keep_start`로 만들었을 때만)
    pub fn total(&self) -> Option<Effect> {
        let start = self.start.as_ref()?;
        Some(self.gaps(effect_between(start, &self.current, self.own.as_ref().map(|o| &o.subject))))
    }
}

/// 일괄 미리보기·적용에 넣을 수 있는 변경 묶음인가(개수 한도, 같은 변경 중복)
pub fn check_batch(changes: &[Change]) -> Result<(), AppError> {
    if changes.len() > BATCH_MAX {
        return Err(AppError::other(BATCH_TOO_LARGE));
    }
    for (i, change) in changes.iter().enumerate() {
        if changes[..i].contains(change) {
            return Err(AppError::other(BATCH_DUPLICATE));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
