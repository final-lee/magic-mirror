//! 보안 점검: 자격 증명 보고서와 스냅숏을 보고 설계 문서 "보안 점검 규칙"의 11가지를 찾는다. 순수 코드다.

use std::collections::BTreeMap;

use serde::Serialize;

use super::change::IamChange;
use super::eval::cmp_ignore_case;
use super::model::Snapshot;
use super::view::Level;
use crate::error::AppError;

mod creds;
mod principals;
mod report;
#[cfg(test)]
pub(super) mod sample;
#[cfg(test)]
mod tests;

pub use creds::{add_key_fixes, credential_badges, key_fix_users, user_last_used};
#[cfg(test)]
pub use report::parse_credential_report;
pub use report::read_credential_report;

/// 이 일수를 넘게 안 쓰거나 안 바꾸면 오래된 것으로 본다.
pub const STALE_DAYS: i64 = 90;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingKind {
    RootAccessKey,
    RootNoMfa,
    ConsoleNoMfa,
    OldAccessKey,
    UnusedAccessKey,
    InactiveUser,
    InactiveRole,
    AdminPrincipal,
    PrivescPrincipal,
    ExternalTrust,
    UnattachedPolicy,
}

/// 점검 표의 순서(= 화면에 나오는 순서)와 제목·심각도. 순서는 `FindingKind`의 선언 순서와 같다.
const TABLE: [(FindingKind, &str, Level); 11] = [
    (FindingKind::RootAccessKey, "루트 액세스 키", Level::Danger),
    (FindingKind::RootNoMfa, "루트 MFA 없음", Level::Danger),
    (FindingKind::ConsoleNoMfa, "MFA 없는 콘솔 사용자", Level::Danger),
    (FindingKind::OldAccessKey, "오래된 액세스 키", Level::Warn),
    (FindingKind::UnusedAccessKey, "안 쓰는 액세스 키", Level::Warn),
    (FindingKind::InactiveUser, "안 쓰는 사용자", Level::Info),
    (FindingKind::InactiveRole, "안 쓰는 역할", Level::Info),
    (FindingKind::AdminPrincipal, "관리자급 주체", Level::Warn),
    (FindingKind::PrivescPrincipal, "권한 상승 위험 주체", Level::Warn),
    // 누구나 조건 없이 맡을 수 있는 역할이 있으면 위험으로 올린다(`findings`)
    (FindingKind::ExternalTrust, "외부에 열린 신뢰", Level::Warn),
    (FindingKind::UnattachedPolicy, "붙은 곳 없는 정책", Level::Info),
];

const MISSING_REPORT: &str = "자격 증명 보고서가 없어서 루트·MFA·액세스 키·안 쓰는 사용자 점검은 건너뛰었어요";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingItem {
    pub target_arn: String,
    pub target_name: String,
    pub detail: String,
    /// 복사해서 쓰는 AWS CLI 명령
    pub cli: Option<String>,
    /// 변경 미리보기로 바로 이어지는 빠른 조치. 대상 키 ID를 알 때만 채운다: 자격 증명 보고서에는 키 ID가 없어서
    /// 액세스 키 점검은 키 목록에서 그 키를 찾았을 때만 단다(`add_key_fixes`)
    pub fix: Option<IamChange>,
    /// 액세스 키 점검이면 보고서의 그 키 칸에 적힌 마지막 교체 시각(유닉스 초, 키를 만든 시각과 같다고 본다). 키 ID를 찾는 데만 쓰고 보내지 않는다
    #[serde(skip)]
    pub(crate) key_rotated: Option<i64>,
}

/// `ListAccessKeys`로 읽은 액세스 키 하나: 키 ID, 지금 활성인지, 만든 시각(유닉스 초).
#[derive(Clone, Debug, PartialEq)]
pub struct ListedKey {
    pub id: String,
    pub active: bool,
    pub created: Option<i64>,
}

/// 사용자 이름별 키 목록. 목록을 읽지 못한 사용자는 그 오류다.
pub type ListedKeys = BTreeMap<String, Result<Vec<ListedKey>, AppError>>;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingGroup {
    pub kind: FindingKind,
    pub title: String,
    pub level: Level,
    pub items: Vec<FindingItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Findings {
    /// 점검의 기준 시각: 자격 증명 보고서를 만든 시각(AWS가 4시간 안의 보고서를 다시 써서 스냅숏보다 오래됐을 수 있다).
    /// 보고서가 그 시각을 알려 주지 않았으면 스냅숏을 읽은 시각, 보고서가 없으면 None이다
    pub generated_at: Option<String>,
    /// 11개 그룹이 표의 순서대로 모두 들어 있다(항목이 없어도)
    pub groups: Vec<FindingGroup>,
    pub warnings: Vec<String>,
}

/// 그룹마다 모은 항목. 인덱스는 `FindingKind as usize`다.
type Items = [Vec<FindingItem>; 11];

fn push(items: &mut Items, kind: FindingKind, item: FindingItem) {
    items[kind as usize].push(item);
}

fn item(target_arn: &str, target_name: &str, detail: String, cli: Option<String>) -> FindingItem {
    FindingItem { target_arn: target_arn.to_string(), target_name: target_name.to_string(), detail, cli, fix: None, key_rotated: None }
}

/// 복사해 붙여 넣는 명령에 들어가는 값. 정책 경로에는 `$`나 `;` 같은 글자가 올 수 있어서, 안전한 글자만 있을 때를 빼고는 따옴표로 싼다.
fn sh_quote(arg: &str) -> String {
    let safe = !arg.is_empty() && arg.bytes().all(|b| b.is_ascii_alphanumeric() || b"_+=,.@:/-".contains(&b));
    if safe {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

/// 스냅숏 전체를 점검한다. `now`는 유닉스 초다. 자격 증명 보고서가 없으면 그것으로 찾는 점검은 건너뛰고 경고를 남긴다.
pub fn findings(s: &Snapshot, now: i64) -> Findings {
    let mut items = Items::default();
    let mut warnings = s.warnings.clone();
    match &s.cred_report {
        Some(rows) => creds::report_findings(s, rows, now, &mut items),
        None => warnings.push(MISSING_REPORT.to_string()),
    }
    principals::principal_findings(s, now, &mut items);
    let open_to_anyone = principals::open_to_anyone(s);

    let groups = TABLE
        .iter()
        .zip(items)
        .map(|((kind, title, level), mut list)| {
            list.sort_by(|a, b| cmp_ignore_case(&a.target_name, &b.target_name).then_with(|| a.target_arn.cmp(&b.target_arn)));
            let level = if *kind == FindingKind::ExternalTrust && open_to_anyone { Level::Danger } else { *level };
            FindingGroup { kind: *kind, title: title.to_string(), level, items: list }
        })
        .collect();
    // 보고서가 없으면 보고서로 하는 점검을 건너뛰었으니 기준 시각도 없다
    let generated_at = s.cred_report.as_ref().map(|_| s.cred_generated_at.clone().unwrap_or_else(|| s.fetched_at.clone()));
    Findings { generated_at, groups, warnings }
}
