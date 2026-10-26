//! 경고 규칙(설계 문서 "직접 변경"). 막힘(block)은 적용할 수 없고, 확인(confirm)은 대상 이름을 입력해야 적용할 수 있고, 주의(warn)는 알려 주기만 한다.

use serde::Serialize;

use super::calls::calls;
use super::document;
use super::impact::{Analysis, MAX_AFFECTED};
use super::state::{is_attached, is_member};
use super::text::{policy_name, principal_label};
use super::IamChange;
use crate::iam::danger::policy_badges;
use crate::iam::eval::{evaluate_action, find_principal, Status};
use crate::iam::model::{Scope, Snapshot};
use crate::iam::text::shortened;
use crate::iam::view::BadgeKind;

/// 영향받는 주체가 이만큼 이상이면 알려 준다.
const MANY_IMPACTS: usize = 5;
/// 알려 줄 때 이름을 보여 주는 개수.
const SHOWN_NAMES: usize = 5;
const CFN_STACK_TAG: &str = "aws:cloudformation:stack-name";
const UNREADABLE_POLICY: &str = "정책 문서를 읽지 못해 권한 변화를 계산하지 못했어요";

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

/// 적용할 수 없는 이유: 서비스 연결·Identity Center 역할, AWS 관리형 정책 편집, 잘못된 정책 문서·이름, 잘못된 키 상태.
/// 대상이 스냅숏에 있는지 같은 상태 문제는 `apply_to_snapshot`이 알려 준다.
pub(super) fn blocks(s: &Snapshot, c: &IamChange) -> Vec<Warning> {
    let mut out = Vec::new();
    if let IamChange::AttachPolicy { target, .. } | IamChange::DetachPolicy { target, .. } | IamChange::PutInlinePolicy { target, .. } | IamChange::DeleteInlinePolicy { target, .. } = c {
        for badge in policy_badges(s, target) {
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
    out.extend(document::problems(s, c).into_iter().map(block));
    out
}

/// 대상이 CloudFormation 스택으로 만든 것이면 그 스택 이름.
fn cfn_stack(s: &Snapshot, arn: &str) -> Option<String> {
    if !policy_badges(s, arn).iter().any(|b| b.kind == BadgeKind::Cfn) {
        return None;
    }
    find_principal(s, arn)?.tags()?.get(CFN_STACK_TAG).cloned()
}

fn cfn_warning(stack: &str) -> Warning {
    warn(format!("CloudFormation 스택({stack})이 관리하는 대상이에요. 스택을 업데이트하면 이 변경이 원래대로 돌아갈 수 있어요"))
}

/// 가상 스냅숏 없이 알 수 있는 확인·주의: 키·인라인 정책 삭제, CloudFormation 스택 대상, 버전이 가득 찬 정책, 이미 그 상태인 변경, 읽지 못한 정책 문서.
pub(super) fn notices(s: &Snapshot, c: &IamChange, key_status: Option<&str>) -> Vec<Warning> {
    let mut out = Vec::new();
    match c {
        IamChange::DeleteAccessKey { .. } => out.push(confirm("액세스 키를 삭제하면 되돌릴 수 없어요. 이 키를 쓰는 프로그램은 AWS에 접근하지 못하게 돼요")),
        IamChange::DeleteInlinePolicy { name, .. } => out.push(confirm(format!("인라인 정책을 삭제해요: {name}. 이 정책이 주던 권한이 사라져요"))),
        _ => {}
    }
    if let Some(stack) = principal_arn(s, c).and_then(|arn| cfn_stack(s, &arn)) {
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
    if let IamChange::AttachPolicy { policy_arn, .. } | IamChange::DetachPolicy { policy_arn, .. } = c {
        if s.policies.get(policy_arn).and_then(|rec| rec.document.as_ref()).is_none() {
            out.push(warn(UNREADABLE_POLICY));
        }
    }
    out
}

/// 이 변경 뒤에도 앱이 쓰는 주체(`caller`)가 `inverse`를 실행할 IAM 권한을 갖고 있지 않으면 그 이유.
fn undo_problem(after: &Snapshot, caller: &str, inverse: Option<&IamChange>) -> Option<String> {
    let missing: Vec<String> = calls(after, inverse?)
        .into_iter()
        .map(|call| call.api)
        .filter(|api| !matches!(evaluate_action(after, caller, api, None).map(|eval| eval.status), Some(Status::Allowed | Status::Conditional)))
        .collect();
    (!missing.is_empty()).then(|| format!("이 변경을 되돌리는 데 필요한 권한({})도 없어져서 이 자격 증명으로는 되돌릴 수 없어요", missing.join(", ")))
}

fn names(s: &Snapshot, arns: &[String]) -> String {
    let labels: Vec<String> = arns.iter().map(|arn| principal_label(s, arn)).collect();
    shortened(&labels, SHOWN_NAMES)
}

/// 영향 계산에서 나오는 확인·주의: 앱 자격 증명의 권한 축소, 새 관리자급·권한 상승, 카탈로그에 없는 작업, 영향받는 주체 수.
/// `inverse`는 되돌리는 변경이다(적용 뒤에도 되돌릴 권한이 남는지 본다).
pub(super) fn from_analysis(before: &Snapshot, after: &Snapshot, c: &IamChange, a: &Analysis, inverse: Option<&IamChange>) -> Vec<Warning> {
    let mut out = Vec::new();
    if let (true, Some(caller)) = (a.caller_lost, before.caller_principal_arn.as_deref()) {
        let mut message = format!("지금 이 앱이 쓰는 자격 증명({})의 권한이 줄어요. 적용하면 이 앱이 AWS에 접근하지 못할 수 있어요", principal_label(before, caller));
        if let Some(problem) = undo_problem(after, caller, inverse) {
            message.push_str(". ");
            message.push_str(&problem);
        }
        out.push(confirm(message));
    }
    if !a.newly_admin.is_empty() {
        out.push(confirm(format!("관리자급 권한을 새로 얻는 주체: {}", names(before, &a.newly_admin))));
    }
    if !a.newly_privesc.is_empty() {
        out.push(confirm(format!("권한 상승에 쓸 수 있는 권한을 새로 얻는 주체: {}", names(before, &a.newly_privesc))));
    }
    // 카탈로그에 없는 작업 이름은 사용자가 쓴 문서에서만 점검한다: AWS가 만든 정책에 든 새 작업까지 오타로 보면 안 된다
    if !a.new_unknown.is_empty() && matches!(c, IamChange::PutInlinePolicy { .. } | IamChange::UpdateManagedPolicy { .. }) {
        out.push(warn(format!("카탈로그에 없는 작업이 있어요: {}. 오타인지 확인하세요", shortened(&a.new_unknown, SHOWN_NAMES))));
    }
    if a.truncated {
        out.push(warn(format!("영향받는 대상이 많아 처음 {MAX_AFFECTED}개만 계산했어요")));
    }
    if a.impacts.len() >= MANY_IMPACTS {
        out.push(warn(format!("영향받는 주체가 {}개예요", a.impacts.len())));
    }
    out
}
