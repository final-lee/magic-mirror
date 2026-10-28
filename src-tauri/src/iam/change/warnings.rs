//! 경고 규칙(설계 문서 "직접 변경"). 막힘(block)은 적용할 수 없고, 확인(confirm)은 대상 이름을 입력해야 적용할 수 있고, 주의(warn)는 알려 주기만 한다.

use serde::Serialize;

use super::calls::calls;
use super::document;
use super::facts::{deletes_policy_version, stops_own_key, Facts, PolicyCheck};
use super::impact::{Analysis, MAX_AFFECTED};
use super::state::{inline_policy, is_attached, is_member};
use super::text::{policy_name, principal_label};
use super::IamChange;
use crate::iam::catalog::is_match_all;
use crate::iam::danger::policy_badges;
use crate::iam::eval::{evaluate_action, find_principal, Status};
use crate::iam::model::{Scope, Snapshot};
use crate::iam::policy::{parse_document, Effect, Resources, Statement};
use crate::iam::text::shortened;
use crate::iam::view::{Badge, BadgeKind};

/// 영향받는 주체가 이만큼 이상이면 알려 준다.
const MANY_IMPACTS: usize = 5;
/// 알려 줄 때 이름을 보여 주는 개수.
const SHOWN_NAMES: usize = 5;
const CFN_STACK_TAG: &str = "aws:cloudformation:stack-name";
const UNREADABLE_CHANGED: &str = "문서를 읽지 못한 정책이 있어 권한 변화를 다 계산하지 못했어요";
const CALLER_UNREADABLE: &str = "문서를 읽지 못한 정책이 있어 이 앱 자격 증명의 권한 변화를 다 계산하지 못했어요";
const UNREADABLE_KEPT: &str = "문서를 읽지 못한 정책은 계산에서 뺐어요";
const CALLER_RESTRICTED: &str = "조건에 따라 이 앱의 자격 증명이 막힐 수 있어요 (예: MFA·IP 조건)";
const OWN_KEY: &str = "적용하면 이 앱이 바로 AWS에 접근하지 못하고, 여기서는 되돌릴 수 없어요";
const POLICY_UNCHECKED: &str = "정책 검사를 할 수 없어 버전 삭제 뒤 저장이 실패할 수 있어요";
const SCOPED_DENY: &str = "일부 리소스에만 거는 거부(Deny) 문장을 더해요";
const SCOPED_DENY_HINT: &str = "영향받는 주체 목록은 서비스·접근 수준 단위라 이 문장이 막는 것은 나오지 않아요. 이 앱의 자격 증명에 걸리면 되돌리지 못할 수도 있어요";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WarnLevel {
    Block,
    Confirm,
    Warn,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Warning {
    pub level: WarnLevel,
    pub message: String,
}

impl Warning {
    pub(super) fn new(level: WarnLevel, message: impl Into<String>) -> Warning {
        Warning { level, message: message.into() }
    }
}

fn block(message: impl Into<String>) -> Warning {
    Warning::new(WarnLevel::Block, message)
}

fn confirm(message: impl Into<String>) -> Warning {
    Warning::new(WarnLevel::Confirm, message)
}

fn warn(message: impl Into<String>) -> Warning {
    Warning::new(WarnLevel::Warn, message)
}

/// 변경이 바꾸는 사용자·그룹·역할(ARN). 정책 변경은 `target`, 그룹 구성원·액세스 키 변경은 사용자다. 관리형 정책 편집은 주체가 아니다.
fn principal_arn(s: &Snapshot, c: &IamChange) -> Option<String> {
    match c {
        IamChange::AttachPolicy { target, .. }
        | IamChange::DetachPolicy { target, .. }
        | IamChange::PutInlinePolicy { target, .. }
        | IamChange::DeleteInlinePolicy { target, .. } => Some(target.clone()),
        IamChange::AddToGroup { user_name, .. }
        | IamChange::RemoveFromGroup { user_name, .. }
        | IamChange::SetAccessKeyStatus { user_name, .. }
        | IamChange::DeleteAccessKey { user_name, .. } => s.user(user_name).map(|u| u.arn.clone()),
        IamChange::UpdateManagedPolicy { .. } => None,
    }
}

fn is_aws_managed(s: &Snapshot, policy_arn: &str) -> bool {
    match s.policies.get(policy_arn) {
        Some(rec) => rec.scope == Scope::Aws,
        // 스냅숏에 없으면 ARN의 계정 칸이 `aws`인지로 본다
        None => policy_arn.split(':').nth(4) == Some("aws"),
    }
}

/// 변경이 바꾸는 사용자·그룹·역할의 배지. 막힘(서비스 연결·Identity Center 역할)과 주의(CloudFormation) 규칙이 함께 쓰도록 미리보기마다 한 번만 계산한다.
pub(super) fn target_badges(s: &Snapshot, c: &IamChange) -> Vec<Badge> {
    principal_arn(s, c).map(|arn| policy_badges(s, &arn)).unwrap_or_default()
}

/// 적용할 수 없는 이유: 서비스 연결·Identity Center 역할, AWS 관리형 정책 편집, 잘못된 정책 문서·이름, 잘못된 키 상태,
/// 버전을 지워야 하는 편집에서 검사기가 오류를 낸 문서. `badges`는 `target_badges`다.
/// 대상이 스냅숏에 있는지 같은 상태 문제는 `apply_to_snapshot`이 알려 준다.
pub(super) fn blocks(s: &Snapshot, c: &IamChange, facts: &Facts, badges: &[Badge]) -> Vec<Warning> {
    let mut out = Vec::new();
    if let IamChange::AttachPolicy { .. } | IamChange::DetachPolicy { .. } | IamChange::PutInlinePolicy { .. } | IamChange::DeleteInlinePolicy { .. } = c {
        for badge in badges {
            match badge.kind {
                BadgeKind::ServiceLinked => out.push(block("서비스 연결 역할은 AWS 서비스가 관리해서 바꿀 수 없어요")),
                BadgeKind::Sso => out.push(block("Identity Center가 만든 역할이라 여기서 바꿀 수 없어요. Identity Center에서 권한 세트를 바꿔 주세요")),
                _ => {}
            }
        }
    }
    match c {
        IamChange::UpdateManagedPolicy { policy_arn, .. } if is_aws_managed(s, policy_arn) => out.push(block("AWS 관리형 정책은 고칠 수 없어요")),
        IamChange::SetAccessKeyStatus { status, .. } if status != "Active" && status != "Inactive" => out.push(block("액세스 키 상태는 Active나 Inactive여야 해요")),
        _ => {}
    }
    let problems = document::problems(s, c);
    let readable = problems.is_empty();
    out.extend(problems.into_iter().map(block));
    // 문서 자체가 틀렸으면 위에서 이미 막았다. 같은 이유를 검사기 결과로 한 번 더 말하지 않는다
    if let (true, true, PolicyCheck::Errors(errors)) = (readable, deletes_policy_version(s, c), &facts.policy_check) {
        out.push(block(format!("정책 문서에 오류가 있어 적용할 수 없어요: {}", errors.join(" / "))));
    }
    out
}

/// 대상이 CloudFormation 스택으로 만든 것이면 그 스택 이름. `badges`는 그 대상의 배지다.
fn cfn_stack(s: &Snapshot, arn: &str, badges: &[Badge]) -> Option<String> {
    if !badges.iter().any(|b| b.kind == BadgeKind::Cfn) {
        return None;
    }
    find_principal(s, arn)?.tags()?.get(CFN_STACK_TAG).cloned()
}

fn cfn_warning(stack: &str) -> Warning {
    warn(format!("CloudFormation 스택({stack})이 관리하는 대상이에요. 스택을 업데이트하면 이 변경이 원래대로 돌아갈 수 있어요"))
}

/// 가상 스냅숏 없이 알 수 있는 확인·주의: 키·인라인 정책 삭제, 이 앱이 쓰는 키 끄기, 검사하지 못한 문서로 버전 지우기,
/// CloudFormation 스택 대상, 버전이 가득 찬 정책, 이미 그 상태인 변경, 붙일 정책을 읽지 못한 이유, 일부 리소스에만 거는 Deny를 더하는 문서.
/// `badges`는 `target_badges`다.
/// 읽지 못한 정책이 붙거나 떨어지는 것 자체는 영향 계산에서 확인으로 나온다(`from_analysis`).
pub(super) fn notices(s: &Snapshot, c: &IamChange, facts: &Facts, badges: &[Badge]) -> Vec<Warning> {
    let key_status = facts.key_status.as_deref();
    let mut out = Vec::new();
    match c {
        IamChange::DeleteAccessKey { .. } => out.push(confirm("액세스 키를 삭제하면 되돌릴 수 없어요. 이 키를 쓰는 프로그램은 AWS에 접근하지 못하게 돼요")),
        IamChange::DeleteInlinePolicy { name, .. } => out.push(confirm(format!("인라인 정책을 삭제해요: {name}. 이 정책이 주던 권한이 사라져요"))),
        _ => {}
    }
    if stops_own_key(s, c, facts) {
        out.push(confirm(OWN_KEY));
    }
    // 버전을 지운 뒤 새 버전 만들기가 실패하면 지운 버전은 돌아오지 않는다. 문서를 검사하지 못했으면 그 위험을 확인받는다
    if deletes_policy_version(s, c) && matches!(facts.policy_check, PolicyCheck::NotRun | PolicyCheck::Unavailable) {
        out.push(confirm(POLICY_UNCHECKED));
    }
    if let Some(stack) = principal_arn(s, c).and_then(|arn| cfn_stack(s, &arn, badges)) {
        out.push(cfn_warning(&stack));
    }
    match c {
        IamChange::UpdateManagedPolicy { policy_arn, .. } => {
            if let Some(version) = s.policies.get(policy_arn).and_then(super::calls::version_to_delete) {
                out.push(warn(format!("정책 버전이 이미 5개라서 가장 오래된 비기본 버전을 먼저 삭제해요: {}", version.id)));
            }
        }
        IamChange::AttachPolicy { target, policy_arn } => {
            if is_attached(s, target, policy_arn) {
                out.push(warn(format!("이미 붙어 있어서 달라지는 게 없어요: {}", policy_name(s, policy_arn))));
            }
        }
        IamChange::AddToGroup { user_name, group_name } => {
            if is_member(s, user_name, group_name) {
                out.push(warn(format!("이미 {group_name} 그룹의 구성원이라서 달라지는 게 없어요")));
            }
        }
        IamChange::SetAccessKeyStatus { status, .. } if key_status == Some(status.as_str()) => out.push(warn(format!("이미 {status} 상태라서 달라지는 게 없어요"))),
        _ => {}
    }
    // 붙일 정책을 따로 읽다가 실패했으면 그 이유(빠진 권한 등)를 알려 준다
    if let (IamChange::AttachPolicy { policy_arn, .. }, Some(reason)) = (c, facts.policy_error.as_deref()) {
        out.push(warn(format!("{} 정책을 읽지 못했어요: {reason}", policy_name(s, policy_arn))));
    }
    let scoped = scoped_denies_added(s, c);
    if !scoped.is_empty() {
        out.push(warn(format!("{SCOPED_DENY}: {}. {SCOPED_DENY_HINT}", shortened(&scoped, SHOWN_NAMES))));
    }
    out
}

/// Deny 문장이 영향 계산(서비스·접근 수준 단위)에 그대로 드러나는지: 모든 리소스(`*`)에 걸리거나 어떤 리소스에도 걸리지 않는다.
fn deny_shows_in_impacts(st: &Statement) -> bool {
    match &st.resources {
        Resources::Resource(patterns) => patterns.is_empty() || patterns.iter().any(|p| is_match_all(p)),
        Resources::NotResource(excluded) => excluded.is_empty() || excluded.iter().any(|p| is_match_all(p)),
        Resources::Unspecified => true,
    }
}

/// 같은 규칙의 문장인지(번호와 Sid는 보지 않는다).
fn same_rule(a: &Statement, b: &Statement) -> bool {
    a.effect == b.effect && a.actions == b.actions && a.resources == b.resources && a.conditions == b.conditions
}

/// 인라인 정책 저장·관리형 정책 편집이 새로 더하는, 일부 리소스에만 걸리는 Deny 문장(Sid, 없으면 "문장 N"). 지금 문서에 같은 규칙의
/// 문장이 있으면 새로 더하는 것이 아니다. 영향 계산은 서비스·접근 수준 단위라 이런 Deny가 막는 것(예: 이 앱의 자격 증명 ARN에 건
/// `iam:*` Deny, 운영 버킷에만 건 삭제 Deny)을 보여 주지 못하고, 되돌릴 권한이 남는지도 리소스를 가리지 않고 본다.
fn scoped_denies_added(s: &Snapshot, c: &IamChange) -> Vec<String> {
    let (document, current) = match c {
        IamChange::PutInlinePolicy { target, name, document } => (document, inline_policy(s, target, name).and_then(|p| p.document.as_ref())),
        IamChange::UpdateManagedPolicy { policy_arn, document } => (document, s.policies.get(policy_arn).and_then(|p| p.document.as_ref())),
        _ => return Vec::new(),
    };
    // 읽을 수 없는 문서는 막힘으로 이미 알렸다
    let Ok(next) = parse_document(document) else { return Vec::new() };
    next.statements
        .iter()
        .filter(|st| st.effect == Effect::Deny && !deny_shows_in_impacts(st))
        .filter(|st| !current.is_some_and(|doc| doc.statements.iter().any(|old| same_rule(old, st))))
        .map(|st| st.sid.clone().unwrap_or_else(|| format!("문장 {}", st.index + 1)))
        .collect()
}

/// 이 변경 뒤에 앱이 쓰는 주체(`caller`)가 `inverses`를 실행할 IAM 권한을 갖고 있지 않거나, 조건 없이 갖고 있던 그 권한이 조건부가 되면
/// (예: MFA가 없으면 거부) 그 이유. 원래부터 조건부였던 권한은 이 변경 탓이 아니라서 말하지 않는다. 되돌릴 변경이 없으면 None이다.
/// 되돌릴 변경이 여럿이면 같은 API가 겹치니, 처음 나온 순서를 지키면서 API마다 한 번만 말한다.
fn undo_problem(before: &Snapshot, after: &Snapshot, caller: &str, inverses: &[IamChange]) -> Option<String> {
    let status = |s: &Snapshot, api: &str| evaluate_action(s, caller, api, None).map(|eval| eval.status);
    let mut apis: Vec<String> = Vec::new();
    for api in inverses.iter().flat_map(|inverse| calls(after, inverse)).map(|call| call.api) {
        if !apis.contains(&api) {
            apis.push(api);
        }
    }
    let (mut gone, mut conditional) = (Vec::new(), Vec::new());
    for api in apis {
        match status(after, &api) {
            Some(Status::Allowed) => {}
            Some(Status::Conditional) => {
                if status(before, &api) == Some(Status::Allowed) {
                    conditional.push(api);
                }
            }
            _ => gone.push(api),
        }
    }
    if !gone.is_empty() {
        Some(format!("이 변경을 되돌리는 데 필요한 권한({})도 없어져서 이 자격 증명으로는 되돌릴 수 없어요", gone.join(", ")))
    } else if !conditional.is_empty() {
        Some(format!("이 변경을 되돌리는 데 필요한 권한({})도 조건부가 돼서 이 자격 증명으로는 되돌리지 못할 수 있어요", conditional.join(", ")))
    } else {
        None
    }
}

fn names(s: &Snapshot, arns: &[String]) -> String {
    let labels: Vec<String> = arns.iter().map(|arn| principal_label(s, arn)).collect();
    shortened(&labels, SHOWN_NAMES)
}

/// 변경 하나의 영향 비교에서 나오는 경고(`analysis_warnings`). `inverse`는 그 변경을 되돌리는 변경이다.
pub(super) fn from_analysis(before: &Snapshot, after: &Snapshot, c: &IamChange, a: &Analysis, inverse: Option<&IamChange>) -> (Vec<Warning>, bool) {
    let inverses: Vec<IamChange> = inverse.cloned().into_iter().collect();
    let edits_document = matches!(c, IamChange::PutInlinePolicy { .. } | IamChange::UpdateManagedPolicy { .. });
    analysis_warnings(before, after, a, &inverses, edits_document)
}

/// 영향 계산에서 나오는 확인·주의: 문서를 읽지 못한 정책이 붙거나 떨어짐(증감을 다 계산하지 못했다), 앱 자격 증명에게 그대로 남는 읽지 못한
/// 정책, 앱 자격 증명의 권한 축소(잃거나 조건부로 바뀜), 새 관리자급·권한 상승, 카탈로그에 없는 작업, 다른 주체의 권한이 조건부로 바뀜,
/// 그대로 계산에서 빠진 정책, 영향받는 주체 수. `inverses`는 되돌리는 변경들을 되돌리는 순서대로다(적용 뒤에도 되돌릴 권한이 남는지 본다).
/// `edits_document`는 사용자가 쓴 정책 문서를 다루는 변경인지다: 카탈로그에 없는 작업은 그런 변경에서만 오타로 본다. 두 번째 값은 앱이
/// 쓰는 자격 증명이 되돌릴 권한을 잃거나 그 권한이 조건부가 되는지, 또는 문서를 읽지 못한 정책 때문에 그것을 알 수 없는지다(그러면
/// 미리보기는 되돌릴 수 없다고 말한다).
pub(super) fn analysis_warnings(before: &Snapshot, after: &Snapshot, a: &Analysis, inverses: &[IamChange], edits_document: bool) -> (Vec<Warning>, bool) {
    let mut out = Vec::new();
    // 앱 자격 증명의 권한에 읽지 못한 정책이 끼어 있으면(붙거나 떨어지거나 그대로 남거나) 되돌릴 권한이 남는지 모른다
    let mut undo_lost = a.caller_unreadable;
    // 읽지 못한 정책이 주던 권한을 잃는지(앱의 자격 증명이 관리자 권한을 잃는 것일 수도 있다), 그런 정책으로 무엇을 얻는지 모른다.
    // 계산한 증감이 비어 보여도 확인받는다
    if !a.unreadable_changed.is_empty() {
        out.push(confirm(format!("{UNREADABLE_CHANGED}: {}", shortened(&a.unreadable_changed, SHOWN_NAMES))));
    }
    // 앱 자격 증명에게 그대로 남는 정책이어도, 그 위에 Deny를 더하거나 경계를 바꾸면 그 정책이 주던 권한을 잃는지 모른다(계산에 없는
    // 권한은 잃는 것으로 나오지 않는다). 드문 일이라 변경의 방향과 상관없이 확인받는다
    if !a.caller_unreadable_kept.is_empty() {
        out.push(confirm(format!("{CALLER_UNREADABLE}: {}", shortened(&a.caller_unreadable_kept, SHOWN_NAMES))));
    }
    if let (true, Some(caller)) = (a.caller_lost || a.caller_restricted, before.caller_principal_arn.as_deref()) {
        // 되돌릴 권한이 없다는 말은 앞의 확인 하나에만 붙인다
        let mut undo = undo_problem(before, after, caller, inverses);
        undo_lost |= undo.is_some();
        let mut with_undo = |mut message: String| {
            if let Some(problem) = undo.take() {
                message.push_str(". ");
                message.push_str(&problem);
            }
            confirm(message)
        };
        if a.caller_lost {
            out.push(with_undo(format!("지금 이 앱이 쓰는 자격 증명({})의 권한이 줄어요. 적용하면 이 앱이 AWS에 접근하지 못할 수 있어요", principal_label(before, caller))));
        }
        // 조건 없이 쓰던 작업이 조건부가 되면(예: MFA가 없으면 거부) 잃은 것은 아니어도 이 앱의 요청이 막힐 수 있다
        if a.caller_restricted {
            out.push(with_undo(CALLER_RESTRICTED.to_string()));
        }
    }
    if !a.newly_admin.is_empty() {
        out.push(confirm(format!("관리자급 권한을 새로 얻는 주체: {}", names(before, &a.newly_admin))));
    }
    if !a.newly_privesc.is_empty() {
        out.push(confirm(format!("권한 상승에 쓸 수 있는 권한을 새로 얻는 주체: {}", names(before, &a.newly_privesc))));
    }
    // 카탈로그에 없는 작업 이름은 사용자가 쓴 문서에서만 점검한다: AWS가 만든 정책에 든 새 작업까지 오타로 보면 안 된다
    if !a.new_unknown.is_empty() && edits_document {
        out.push(warn(format!("카탈로그에 없는 작업이 있어요: {}. 오타인지 확인하세요", shortened(&a.new_unknown, SHOWN_NAMES))));
    }
    if a.restricted_others > 0 {
        out.push(warn(format!("{}명의 일부 권한이 조건부로 바뀌어요", a.restricted_others)));
    }
    if !a.unreadable_kept.is_empty() {
        out.push(warn(format!("{UNREADABLE_KEPT}: {}", shortened(&a.unreadable_kept, SHOWN_NAMES))));
    }
    if a.truncated {
        out.push(warn(format!("영향받는 대상이 많아 처음 {MAX_AFFECTED}개만 계산했어요")));
    }
    if a.impacts.len() >= MANY_IMPACTS {
        out.push(warn(format!("영향받는 주체가 {}개예요", a.impacts.len())));
    }
    (out, undo_lost)
}
