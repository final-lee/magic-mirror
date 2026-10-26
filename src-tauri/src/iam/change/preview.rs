//! 변경 미리보기: 호출할 API, 영향받는 주체의 권한 증감, 경고, 확인 문구, 되돌릴 수 있는지를 한 값으로 모은다.

use serde::Serialize;

use super::facts::Facts;
use super::impact::{affected, analyze, is_zero, shown};
use super::text::{confirm_name, describe};
use super::warnings;
use super::{apply_to_snapshot, calls, inverse, ApiCall, IamChange, Impact, WarnLevel, Warning};
use crate::iam::model::Snapshot;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePreview {
    pub change: IamChange,
    pub summary: String,
    pub calls: Vec<ApiCall>,
    /// 권한이 달라지는 주체. 앞에서부터 30명까지(앱이 쓰는 주체는 늘 들어간다)
    pub impacts: Vec<Impact>,
    /// `impacts`에 넣지 못한 주체 수. 0이면 보내지 않는다(계약에 더한 선택 필드)
    #[serde(skip_serializing_if = "is_zero")]
    pub impacts_omitted: usize,
    /// 막힘 → 확인 → 주의 순서
    pub warnings: Vec<Warning>,
    /// 확인 경고가 있으면 입력해야 할 문자열(대상 이름)
    pub confirm_text: Option<String>,
    pub reversible: bool,
}

fn rank(level: WarnLevel) -> u8 {
    match level {
        WarnLevel::Block => 0,
        WarnLevel::Confirm => 1,
        WarnLevel::Warn => 2,
    }
}

/// 변경의 미리보기. 순수 함수이므로 적용할 때 백엔드가 같은 재료(`facts`)로 다시 계산해 같은 규칙으로 거른다.
///
/// 막힌 변경은 영향을 계산하지 않고(적용되지 않으니 보여 줄 영향이 없다) 확인 경고도 내지 않는다.
/// 되돌리는 변경이 없거나, 적용하면 이 앱의 자격 증명이 그 변경을 실행할 권한을 잃으면(조건부가 되는 것도) 되돌릴 수 없다고 말한다.
/// 기록에는 역변경이 그대로 남으니 권한이 있는 다른 자격 증명으로는 되돌릴 수 있다.
pub fn preview(s: &Snapshot, c: &IamChange, facts: &Facts) -> ChangePreview {
    let undo = inverse(s, c, facts);
    let badges = warnings::target_badges(s, c);
    let mut warnings = warnings::blocks(s, c, facts, &badges);
    let mut impacts = Vec::new();
    let mut undo_lost = false;
    if warnings.is_empty() {
        match apply_to_snapshot(s, c) {
            Err(reason) => warnings.push(Warning::new(WarnLevel::Block, reason)),
            Ok(after) => {
                let analysis = analyze(s, &after, affected(s, c), s.caller_principal_arn.as_deref());
                let (found, lost) = warnings::from_analysis(s, &after, c, &analysis, undo.as_ref());
                warnings.extend(found);
                undo_lost = lost;
                impacts = analysis.impacts;
            }
        }
    }
    warnings.extend(warnings::notices(s, c, facts, &badges));

    let blocked = warnings.iter().any(|w| w.level == WarnLevel::Block);
    if blocked {
        // 영향은 막힘이 없을 때만 계산했으니 여기서 비울 것은 없고, 알림에서 나온 확인만 뺀다
        warnings.retain(|w| w.level != WarnLevel::Confirm);
    }
    warnings.sort_by_key(|w| rank(w.level));
    let confirm_text = warnings.iter().any(|w| w.level == WarnLevel::Confirm).then(|| confirm_name(s, c));
    let (impacts, impacts_omitted) = shown(impacts, s.caller_principal_arn.as_deref());
    ChangePreview {
        change: c.clone(),
        summary: describe(s, c),
        calls: calls(s, c),
        impacts,
        impacts_omitted,
        warnings,
        confirm_text,
        reversible: !blocked && undo.is_some() && !undo_lost,
    }
}
