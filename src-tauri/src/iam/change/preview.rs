//! 변경 미리보기: 호출할 API, 영향받는 주체의 권한 증감, 경고, 확인 문구, 되돌릴 수 있는지를 한 값으로 모은다.

use serde::Serialize;

use super::impact::{affected, analyze};
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
    pub impacts: Vec<Impact>,
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

/// 변경의 미리보기. 순수 함수이므로 적용할 때 백엔드가 다시 계산해 같은 규칙으로 거른다.
/// `key_status`는 액세스 키 변경일 때 그 키의 지금 상태(`"Active"`/`"Inactive"`)다.
///
/// 막힌 변경은 영향을 계산하지 않고(적용되지 않으니 보여 줄 영향이 없다) 확인 경고도 내지 않는다.
pub fn preview(s: &Snapshot, c: &IamChange, key_status: Option<&str>) -> ChangePreview {
    let undo = inverse(s, c, key_status);
    let mut warnings = warnings::blocks(s, c);
    let mut impacts = Vec::new();
    if warnings.is_empty() {
        match apply_to_snapshot(s, c) {
            Err(reason) => warnings.push(Warning::new(WarnLevel::Block, reason)),
            Ok(after) => {
                let analysis = analyze(s, &after, affected(s, c), s.caller_principal_arn.as_deref());
                warnings.extend(warnings::from_analysis(s, &after, c, &analysis, undo.as_ref()));
                impacts = analysis.impacts;
            }
        }
    }
    warnings.extend(warnings::notices(s, c, key_status));

    let blocked = warnings.iter().any(|w| w.level == WarnLevel::Block);
    if blocked {
        // 영향은 막힘이 없을 때만 계산했으니 여기서 비울 것은 없고, 알림에서 나온 확인만 뺀다
        warnings.retain(|w| w.level != WarnLevel::Confirm);
    }
    warnings.sort_by_key(|w| rank(w.level));
    let confirm_text = warnings.iter().any(|w| w.level == WarnLevel::Confirm).then(|| confirm_name(s, c));
    ChangePreview { change: c.clone(), summary: describe(s, c), calls: calls(s, c), impacts, warnings, confirm_text, reversible: !blocked && undo.is_some() }
}
