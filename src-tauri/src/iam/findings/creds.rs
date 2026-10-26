//! 자격 증명 보고서로 찾는 점검: 루트, MFA, 액세스 키, 안 쓰는 사용자. 사용자 목록의 배지도 같은 규칙으로 만든다.

use std::collections::HashSet;

use super::{item, push, sh_quote, FindingKind, Items, STALE_DAYS};
use crate::iam::clock::{days_between, iso, parse_iso};
use crate::iam::model::{CredRow, Snapshot};
use crate::iam::view::{Badge, BadgeKind, Level};

const KEY_TAB_HINT: &str = "액세스 키 탭에서 바로 비활성화할 수 있어요";

fn time(text: &Option<String>) -> Option<i64> {
    text.as_deref().and_then(parse_iso)
}

fn is_root(row: &CredRow) -> bool {
    row.user == "<root_account>" || row.arn.ends_with(":root")
}

/// 콘솔 비밀번호를 쓰는데 MFA가 없다.
fn console_without_mfa(row: &CredRow) -> bool {
    row.password_enabled && !row.mfa_active
}

/// 액세스 키 한 개(보고서에는 키마다 1번·2번 칸이 있다).
struct KeyUse {
    slot: u8,
    active: bool,
    rotated: Option<i64>,
    last_used: Option<i64>,
}

enum Idle {
    /// 마지막으로 쓴 지 지난 일수
    Since(i64),
    /// 한 번도 안 쓰고 만든 지 지난 일수
    Never(i64),
}

impl KeyUse {
    /// 활성 키를 마지막으로 바꾼 지 90일을 넘었으면 지난 일수.
    fn old_days(&self, now: i64) -> Option<i64> {
        if !self.active {
            return None;
        }
        let days = days_between(self.rotated?, now);
        (days > STALE_DAYS).then_some(days)
    }

    /// 활성 키를 90일 넘게 안 썼거나, 만든 지 90일이 넘었는데 한 번도 안 썼다. 만든 때를 모르면 판단하지 않는다.
    fn idle(&self, now: i64) -> Option<Idle> {
        if !self.active {
            return None;
        }
        match self.last_used {
            Some(used) => {
                let days = days_between(used, now);
                (days > STALE_DAYS).then_some(Idle::Since(days))
            }
            None => {
                let age = days_between(self.rotated?, now);
                (age > STALE_DAYS).then_some(Idle::Never(age))
            }
        }
    }
}

fn keys(row: &CredRow) -> [KeyUse; 2] {
    [
        KeyUse { slot: 1, active: row.key1_active, rotated: time(&row.key1_rotated), last_used: time(&row.key1_last_used) },
        KeyUse { slot: 2, active: row.key2_active, rotated: time(&row.key2_rotated), last_used: time(&row.key2_last_used) },
    ]
}

enum Inactivity {
    Since(i64),
    Never(i64),
}

/// 만든 지 90일 이상인데 비밀번호와 액세스 키(비활성 키 포함)를 모두 90일 넘게 안 썼다. 만든 때를 모르면 판단하지 않는다.
fn inactivity(row: &CredRow, now: i64) -> Option<Inactivity> {
    let age = days_between(time(&row.created_at)?, now);
    if age < STALE_DAYS {
        return None;
    }
    let last = [&row.password_last_used, &row.key1_last_used, &row.key2_last_used].into_iter().filter_map(time).max();
    match last {
        Some(used) => {
            let days = days_between(used, now);
            (days > STALE_DAYS).then_some(Inactivity::Since(days))
        }
        None => Some(Inactivity::Never(age)),
    }
}

fn user_row<'a>(s: &'a Snapshot, user_arn: &str) -> Option<&'a CredRow> {
    s.cred_report.as_ref()?.iter().find(|r| r.arn == user_arn && !is_root(r))
}

/// 자격 증명 보고서로 알 수 있는 사용자 배지: MFA 없음, 오래된 키, 안 쓰는 키, 안 쓰는 사용자(점검과 같은 규칙).
/// 보고서에 없는 사용자는 빈 목록이다.
pub fn credential_badges(s: &Snapshot, user_arn: &str, now: i64) -> Vec<Badge> {
    let Some(row) = user_row(s, user_arn) else {
        return Vec::new();
    };
    let keys = keys(row);
    let mut badges = Vec::new();
    if console_without_mfa(row) {
        badges.push(Badge::new(BadgeKind::NoMfa, "MFA 없음", Level::Danger));
    }
    if keys.iter().any(|k| k.old_days(now).is_some()) {
        badges.push(Badge::new(BadgeKind::OldKey, "오래된 키", Level::Warn));
    }
    if keys.iter().any(|k| k.idle(now).is_some()) {
        badges.push(Badge::new(BadgeKind::UnusedKey, "안 쓰는 키", Level::Warn));
    }
    if inactivity(row, now).is_some() {
        badges.push(Badge::new(BadgeKind::Inactive, "안 쓰는 사용자", Level::Info));
    }
    badges
}

/// 사용자의 마지막 사용 시각: 비밀번호와 액세스 키(비활성 키 포함) 중 가장 최근 것. 기록이 없으면 None.
pub fn user_last_used(s: &Snapshot, user_arn: &str) -> Option<String> {
    let row = user_row(s, user_arn)?;
    [&row.password_last_used, &row.key1_last_used, &row.key2_last_used].into_iter().filter_map(time).max().map(iso)
}

fn key_cli(user: &str) -> String {
    format!("aws iam update-access-key --user-name {} --access-key-id <ACCESS_KEY_ID> --status Inactive", sh_quote(user))
}

fn root_findings(row: &CredRow, out: &mut Items) {
    let active = [row.key1_active, row.key2_active].into_iter().filter(|active| *active).count();
    // 루트는 CLI로 고칠 수 없다. 콘솔에서 해야 해서 명령도 빠른 조치도 없다
    if active > 0 {
        let detail = format!("루트 계정에 활성 액세스 키가 {active}개 있어요. 콘솔에서 삭제하세요");
        push(out, FindingKind::RootAccessKey, item(&row.arn, "루트 계정", detail, None));
    }
    if !row.mfa_active {
        let detail = "루트 계정에 MFA가 없어요. 콘솔에서 MFA를 켜세요".to_string();
        push(out, FindingKind::RootNoMfa, item(&row.arn, "루트 계정", detail, None));
    }
}

fn user_findings(row: &CredRow, now: i64, out: &mut Items) {
    let (arn, name) = (row.arn.as_str(), row.user.as_str());
    if console_without_mfa(row) {
        let cli = format!("aws iam list-mfa-devices --user-name {}", sh_quote(name));
        push(out, FindingKind::ConsoleNoMfa, item(arn, name, "콘솔 비밀번호를 쓰는데 MFA가 없어요".to_string(), Some(cli)));
    }
    for key in keys(row) {
        let slot = key.slot;
        if let Some(days) = key.old_days(now) {
            let detail = format!("액세스 키 {slot}번은 마지막으로 교체한 지 {days}일 지났어요. {KEY_TAB_HINT}");
            push(out, FindingKind::OldAccessKey, item(arn, name, detail, Some(key_cli(name))));
        }
        if let Some(idle) = key.idle(now) {
            let what = match idle {
                Idle::Since(days) => format!("액세스 키 {slot}번을 마지막으로 쓴 지 {days}일 지났어요"),
                Idle::Never(age) => format!("액세스 키 {slot}번은 만든 지 {age}일 지났는데 한 번도 안 썼어요"),
            };
            push(out, FindingKind::UnusedAccessKey, item(arn, name, format!("{what}. {KEY_TAB_HINT}"), Some(key_cli(name))));
        }
    }
    if let Some(inactive) = inactivity(row, now) {
        let detail = match inactive {
            Inactivity::Since(days) => format!("마지막으로 쓴 지 {days}일 지났어요. 비밀번호와 액세스 키 모두 {STALE_DAYS}일 넘게 안 썼어요"),
            Inactivity::Never(age) => format!("만든 지 {age}일 지났는데 로그인이나 액세스 키를 쓴 기록이 없어요"),
        };
        let cli = format!("aws iam get-user --user-name {}", sh_quote(name));
        push(out, FindingKind::InactiveUser, item(arn, name, detail, Some(cli)));
    }
}

/// 보고서 줄마다 루트 점검과 사용자 점검을 한다. 보고서는 4시간까지 묵은 것이 올 수 있으니
/// 스냅숏에 없는 사용자(그사이 지운 사용자)의 줄은 건너뛴다. 루트 줄은 늘 본다.
pub(super) fn report_findings(s: &Snapshot, rows: &[CredRow], now: i64, out: &mut Items) {
    let current: HashSet<&str> = s.users.iter().map(|u| u.arn.as_str()).collect();
    for row in rows {
        if is_root(row) {
            root_findings(row, out);
        } else if current.contains(row.arn.as_str()) {
            user_findings(row, now, out);
        }
    }
}
