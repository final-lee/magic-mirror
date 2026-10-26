//! 스냅숏만으로 찾는 점검: 안 쓰는 역할, 관리자급·권한 상승 위험 주체, 외부에 열린 신뢰, 붙은 곳 없는 정책.

use super::{item, push, sh_quote, FindingKind, Items, STALE_DAYS};
use crate::iam::clock::{days_between, parse_iso};
use crate::iam::danger::{admin_like_statementwise, document_badges, is_service_linked, is_sso_role, privesc_reasons};
use crate::iam::eval::policy_sources;
use crate::iam::model::{RoleRec, Scope, Snapshot};
use crate::iam::text::shortened;
use crate::iam::trust::parse_trust;
use crate::iam::view::{BadgeKind, TrustEntry, TrustKind};

/// 정책·작업 이름을 이 개수까지만 보여 주고 나머지는 "외 N개"로 줄인다.
const SHOWN: usize = 3;

/// 만든 지 90일 이상인데 마지막 사용이 90일을 넘었거나 기록이 없는 역할. 서비스 연결·Identity Center 역할은 사람이 지우는 게 아니라서 뺀다.
fn inactive_detail(role: &RoleRec, now: i64) -> Option<String> {
    if is_service_linked(&role.path) || is_sso_role(&role.name, &role.path) {
        return None;
    }
    match role.last_used.as_deref().map(parse_iso) {
        Some(Some(used)) => {
            let days = days_between(used, now);
            (days > STALE_DAYS).then(|| format!("마지막 사용이 {days}일 전이에요"))
        }
        // 읽을 수 없는 시각은 판단하지 않는다
        Some(None) => None,
        None => {
            let age = days_between(role.created_at.as_deref().and_then(parse_iso)?, now);
            (age >= STALE_DAYS).then(|| format!("사용 기록이 없어요(만든 지 {age}일)"))
        }
    }
}

/// 관리자급 권한을 여는 정책 이름. 그룹에서 상속받았으면 그룹 이름을 붙인다.
fn admin_policy_names(s: &Snapshot, arn: &str) -> Vec<String> {
    policy_sources(s, arn)
        .0
        .iter()
        .filter(|src| src.document.is_some_and(|doc| document_badges(doc).iter().any(|b| b.kind == BadgeKind::Admin)))
        .map(|src| match &src.via {
            Some(group) => format!("{}(그룹 {group})", src.name),
            None => src.name.clone(),
        })
        .collect()
}

fn admin_detail(s: &Snapshot, arn: &str) -> String {
    let names = admin_policy_names(s, arn);
    let base = "모든 작업을 모든 리소스에 허용하는 관리자급 권한이에요";
    if names.is_empty() {
        base.to_string()
    } else {
        format!("{base}: {}", shortened(&names, SHOWN))
    }
}

/// `iam:PassRole 작업을 모든 리소스에 조건 없이 허용해요` 같은 이유에서 작업 이름만 뽑는다.
fn privesc_detail(reasons: &[String]) -> String {
    let actions: Vec<String> = reasons.iter().map(|r| r.split_whitespace().next().unwrap_or(r).to_string()).collect();
    format!("권한 상승에 쓸 수 있는 작업을 모든 리소스에 조건 없이 허용해요: {}", shortened(&actions, SHOWN))
}

fn user_or_role_cli(kind: &str, name: &str) -> String {
    format!("aws iam list-attached-{kind}-policies --{kind}-name {}", sh_quote(name))
}

/// 신뢰 정책 한 줄을 사람이 읽는 말로 푼다. 계정·주체에는 ExternalId 조건이 있는지(경고가 없으면 있다)를 함께 적는다.
fn describe_trust(entry: &TrustEntry) -> String {
    match entry.kind {
        TrustKind::Anyone if entry.conditional => "누구나 맡을 수 있게 열려 있고 조건이 걸려 있어요. 조건이 충분한지 확인해 주세요".to_string(),
        TrustKind::Anyone => "누구나 맡을 수 있어요(조건 없음)".to_string(),
        kind => {
            let who = if kind == TrustKind::Account { "계정" } else { "주체" };
            let tail = if entry.warning.is_some() { "ExternalId 없이 맡을 수 있어요" } else { "맡을 수 있어요(ExternalId 조건이 있어요)" };
            format!("외부 {who} {}에서 {tail}", entry.value)
        }
    }
}

/// 이 정책을 권한 경계로 쓰는 사용자·역할이 있다. AWS의 `AttachmentCount`는 권한 경계로 쓰이는 것을 세지 않는다.
fn used_as_boundary(s: &Snapshot, policy_arn: &str) -> bool {
    s.users.iter().any(|u| u.boundary.as_deref() == Some(policy_arn)) || s.roles.iter().any(|r| r.boundary.as_deref() == Some(policy_arn))
}

pub(super) fn principal_findings(s: &Snapshot, now: i64, out: &mut Items) {
    for role in &s.roles {
        if let Some(detail) = inactive_detail(role, now) {
            let cli = format!("aws iam get-role --role-name {}", sh_quote(&role.name));
            push(out, FindingKind::InactiveRole, item(&role.arn, &role.name, detail, Some(cli)));
        }
    }

    let principals = s.users.iter().map(|u| ("user", u.arn.as_str(), u.name.as_str())).chain(s.roles.iter().map(|r| ("role", r.arn.as_str(), r.name.as_str())));
    for (kind, arn, name) in principals {
        let cli = Some(user_or_role_cli(kind, name));
        if admin_like_statementwise(s, arn) {
            push(out, FindingKind::AdminPrincipal, item(arn, name, admin_detail(s, arn), cli));
        } else {
            // 관리자급이면 권한 상승 위험은 따로 알리지 않는다
            let reasons = privesc_reasons(s, arn);
            if !reasons.is_empty() {
                push(out, FindingKind::PrivescPrincipal, item(arn, name, privesc_detail(&reasons), cli));
            }
        }
    }

    for role in &s.roles {
        let Some(doc) = &role.trust else { continue };
        let mut lines: Vec<String> = Vec::new();
        for entry in parse_trust(doc, &s.account_id).iter().filter(|e| e.external) {
            let line = describe_trust(entry);
            if !lines.contains(&line) {
                lines.push(line);
            }
        }
        if !lines.is_empty() {
            let cli = format!("aws iam get-role --role-name {}", sh_quote(&role.name));
            push(out, FindingKind::ExternalTrust, item(&role.arn, &role.name, lines.join("; "), Some(cli)));
        }
    }

    for policy in s.policies.values().filter(|p| p.scope == Scope::Local && p.attachment_count == 0 && !used_as_boundary(s, &p.arn)) {
        let mut detail = "어떤 사용자·그룹·역할에도 붙어 있지 않은 고객 관리형 정책이에요".to_string();
        if let Some(description) = policy.description.as_deref().filter(|d| !d.is_empty()) {
            detail.push_str(&format!(". 설명: {description}"));
        }
        let cli = format!("aws iam list-entities-for-policy --policy-arn {}", sh_quote(&policy.arn));
        push(out, FindingKind::UnattachedPolicy, item(&policy.arn, &policy.name, detail, Some(cli)));
    }
}
