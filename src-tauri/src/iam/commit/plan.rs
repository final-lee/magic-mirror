//! 미리보기에서 사용자가 본 계획. 적용할 때 다시 계산한 계획이 이것과 같아야 IAM을 바꾼다.
//! 미리보기와 적용 사이에 IAM이 바뀌면(버전이 5개가 돼 DeletePolicyVersion이 생김, 다른 버전 ID, 달라진 확인 이유·요약,
//! 되돌릴 수 있는지가 달라짐, 프로필이 다른 계정을 가리킴 …) 사용자가 보지 않은 일을 하게 되므로 거부한다.
//! 순수 코드다: 시각은 부르는 쪽이 넘긴다.

use std::collections::VecDeque;
use std::fmt::Debug;

use serde::Serialize;

use crate::error::AppError;
use crate::iam::change::{ApiCall, BatchItem, BatchPreview, ChangePreview, WarnLevel, Warning};

/// 기억해 두는 미리보기 수의 한도. 넘으면 오래된 것부터 버린다.
pub const MAX_PLANS: usize = 50;
/// 이보다 오래된(초) 미리보기는 없는 것으로 친다.
pub const PLAN_TTL_SECS: i64 = 600;
/// 미리보기가 없거나 다시 계산한 계획이 달라서 거부할 때의 문구.
pub const DRIFTED: &str = "미리보기 뒤에 IAM이 바뀌었어요. 미리보기를 다시 받아 주세요.";

/// 미리보기 하나에서 사용자가 확인한 것: 어느 계정에서, 어떤 요약으로, 어떤 호출을(인자·버전 ID·정책 문서까지), 어떤 막힘·확인 이유와
/// 확인 문구로, 되돌릴 수 있다고 했는지. 주의(warn) 경고는 견주지 않는다.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub account_id: String,
    /// 한 줄 요약. 호출은 같아도 "추가하기"가 "수정하기"가 됐으면(그 사이 같은 이름의 인라인 정책이 생겼다) 사용자가 본 일이 아니다
    pub summary: String,
    pub calls: Vec<ApiCall>,
    /// 막힘·확인 경고, 미리보기 순서대로
    pub checks: Vec<Warning>,
    pub confirm_text: Option<String>,
    /// 되돌릴 수 있다고 보여 줬는지
    pub reversible: bool,
}

impl Plan {
    pub fn of(account_id: &str, p: &ChangePreview) -> Plan {
        Plan {
            account_id: account_id.to_string(),
            summary: p.summary.clone(),
            calls: p.calls.clone(),
            checks: checks_of(&p.warnings),
            confirm_text: p.confirm_text.clone(),
            reversible: p.reversible,
        }
    }
}

/// 묶음 미리보기에서 사용자가 확인한 것. 변경마다 (요약, 호출, 막힘·확인 경고)와 묶음 전체의 막힘·확인 경고, 확인 문구, 되돌릴 수 있는지.
/// 변경은 적용 순서대로이고, 주의(warn) 경고는 견주지 않는다.
#[derive(Clone, Debug, PartialEq)]
pub struct BatchPlan {
    pub account_id: String,
    pub items: Vec<(String, Vec<ApiCall>, Vec<Warning>)>,
    pub checks: Vec<Warning>,
    pub confirm_text: Option<String>,
    pub reversible: bool,
}

/// 경고 가운데 사용자가 확인해야 하는 것(막힘·확인), 순서 그대로.
fn checks_of(warnings: &[Warning]) -> Vec<Warning> {
    warnings.iter().filter(|w| matches!(w.level, WarnLevel::Block | WarnLevel::Confirm)).cloned().collect()
}

/// 묶음의 변경 하나에서 견주는 것: (요약, 호출, 막힘·확인 경고).
fn item_plan(item: &BatchItem) -> (String, Vec<ApiCall>, Vec<Warning>) {
    (item.summary.clone(), item.calls.clone(), checks_of(&item.warnings))
}

impl BatchPlan {
    pub fn of(account_id: &str, p: &BatchPreview) -> BatchPlan {
        BatchPlan {
            account_id: account_id.to_string(),
            items: p.changes.iter().map(item_plan).collect(),
            checks: checks_of(&p.warnings),
            confirm_text: p.confirm_text.clone(),
            reversible: p.reversible,
        }
    }
}

/// 적용 직전에 다시 계산한 계획(`now`)이 사용자가 본 계획(`seen`)과 같은지. 본 계획이 없어도 거부한다.
pub fn check<P: PartialEq>(seen: Option<&P>, now: &P) -> Result<(), AppError> {
    match seen {
        Some(seen) if seen == now => Ok(()),
        _ => Err(AppError::other(DRIFTED)),
    }
}

/// (프로필, 변경 또는 변경 목록의 JSON). 변경은 받은 JSON을 읽은 값을 다시 쓰므로 키 순서·공백이 달라도 같은 변경이면 같은 문자열이다.
type Key = (String, String);

fn key<K: Serialize + Debug + ?Sized>(profile: &str, k: &K) -> Key {
    // 문자열만 든 열거형이라 실패하지 않는다. 혹시 실패해도 다른 변경과 겹치지 않는 값을 쓴다
    let canonical = serde_json::to_string(k).unwrap_or_else(|_| format!("{k:?}"));
    (profile.to_string(), canonical)
}

struct Entry<P> {
    key: Key,
    plan: P,
    /// 기억한 시각(유닉스 초)
    at: i64,
}

/// 프로필·변경(또는 변경 묶음)마다 마지막 미리보기의 계획. 적용 한 번에 꺼내 쓰고 버리므로 미리보기 하나로는 많아야 한 번 적용한다.
pub struct PlanStore<P = Plan> {
    entries: VecDeque<Entry<P>>,
}

impl<P> Default for PlanStore<P> {
    fn default() -> Self {
        PlanStore { entries: VecDeque::new() }
    }
}

impl<P> PlanStore<P> {
    fn prune(&mut self, now: i64) {
        self.entries.retain(|e| now - e.at <= PLAN_TTL_SECS);
    }

    /// 미리보기의 계획을 기억한다. 같은 프로필·변경의 이전 계획은 새것으로 바뀐다.
    pub fn remember<K: Serialize + Debug + ?Sized>(&mut self, profile: &str, k: &K, plan: P, now: i64) {
        self.prune(now);
        let key = key(profile, k);
        self.entries.retain(|e| e.key != key);
        self.entries.push_back(Entry { key, plan, at: now });
        while self.entries.len() > MAX_PLANS {
            self.entries.pop_front();
        }
    }

    /// 이 프로필·변경의 계획을 꺼낸다(꺼낸 계획은 지워진다). 없거나 10분이 지났으면 None.
    pub fn take<K: Serialize + Debug + ?Sized>(&mut self, profile: &str, k: &K, now: i64) -> Option<P> {
        self.prune(now);
        let key = key(profile, k);
        let at = self.entries.iter().position(|e| e.key == key)?;
        self.entries.remove(at).map(|e| e.plan)
    }
}

#[cfg(test)]
mod tests;
