//! 변경 시나리오 테스트. `fixtures::snapshot()`(계정 111111111111)에서 출발한다:
//! alice(관리자 그룹 admins 소속, 앱이 쓰는 주체), bob(인라인 정책 assets-read), carol(S3 전체 + 권한 경계),
//! 역할 deploy(CloudFormation 스택 대상, 인라인 정책 deploy-inline), 서비스 연결 역할과 Identity Center 역할.

mod calls;
mod checks;
mod impacts;
mod inverse;
mod limits;
mod notices;
mod own_key;
mod restricted;
mod rules;
mod shape;
mod sizes;
mod state;
mod wording;

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::impact::PermDelta;
use super::*;
use crate::iam::fixtures::*;
use crate::adapters::util::url_encode as url_encoded;
use crate::iam::model::{GroupRec, Scope, Snapshot, VersionRec};

/// 키 상태만 아는 미리보기(대부분의 시나리오). 다른 사실이 필요하면 `super::preview`에 `Facts`를 직접 넣는다.
fn preview(s: &Snapshot, c: &IamChange, key_status: Option<&str>) -> ChangePreview {
    super::preview(s, c, &Facts::with_key_status(key_status))
}

fn inverse(s: &Snapshot, c: &IamChange, key_status: Option<&str>) -> Option<IamChange> {
    super::inverse(s, c, &Facts::with_key_status(key_status))
}

fn attach(target: &str, policy: &str) -> IamChange {
    IamChange::AttachPolicy { target: target.into(), policy_arn: policy.into() }
}

fn detach(target: &str, policy: &str) -> IamChange {
    IamChange::DetachPolicy { target: target.into(), policy_arn: policy.into() }
}

fn add_to_group(user: &str, group: &str) -> IamChange {
    IamChange::AddToGroup { user_name: user.into(), group_name: group.into() }
}

fn remove_from_group(user: &str, group: &str) -> IamChange {
    IamChange::RemoveFromGroup { user_name: user.into(), group_name: group.into() }
}

fn set_status(user: &str, key: &str, status: &str) -> IamChange {
    IamChange::SetAccessKeyStatus { user_name: user.into(), access_key_id: key.into(), status: status.into() }
}

fn delete_key(user: &str, key: &str) -> IamChange {
    IamChange::DeleteAccessKey { user_name: user.into(), access_key_id: key.into() }
}

fn put_inline(target: &str, name: &str, document: String) -> IamChange {
    IamChange::PutInlinePolicy { target: target.into(), name: name.into(), document }
}

fn drop_inline(target: &str, name: &str) -> IamChange {
    IamChange::DeleteInlinePolicy { target: target.into(), name: name.into() }
}

fn update_managed(policy_arn: &str, document: String) -> IamChange {
    IamChange::UpdateManagedPolicy { policy_arn: policy_arn.into(), document }
}

/// 정책 문서 문자열(`Version` + 주어진 문장들).
fn doc(statements: Value) -> String {
    policy(statements).to_string()
}

/// 모든 리소스에 주어진 작업을 허용하는 문서.
fn allow(actions: &[&str]) -> String {
    doc(json!([{ "Effect": "Allow", "Action": actions, "Resource": "*" }]))
}

fn account_arn(resource: &str) -> String {
    format!("arn:aws:iam::{ACCOUNT}:{resource}")
}

/// 고객 관리형 정책을 스냅숏에 넣고 ARN을 돌려준다(붙은 곳은 없다).
fn add_policy(s: &mut Snapshot, name: &str, statements: Value) -> String {
    let arn = account_arn(&format!("policy/{name}"));
    s.policies.insert(arn.clone(), managed(&arn, Scope::Local, 0, policy(statements)));
    arn
}

fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn messages(p: &ChangePreview, level: WarnLevel) -> Vec<&str> {
    p.warnings.iter().filter(|w| w.level == level).map(|w| w.message.as_str()).collect()
}

fn has_level(p: &ChangePreview, level: WarnLevel) -> bool {
    !messages(p, level).is_empty()
}

/// 이 변경이 아무 경고도 확인 문구도 만들지 않는다.
fn assert_clean(p: &ChangePreview) {
    assert!(p.warnings.is_empty(), "{:?}", p.warnings);
    assert_eq!(p.confirm_text, None);
}

fn impact_names(p: &ChangePreview) -> Vec<&str> {
    p.impacts.iter().map(|i| i.principal.name.as_str()).collect()
}

/// 앱이 쓰는 주체를 바꾼 스냅숏.
fn called_by(mut s: Snapshot, arn: Option<&str>) -> Snapshot {
    s.caller_principal_arn = arn.map(str::to_string);
    s
}

/// 버전 번호들로 만든 버전 목록(`default`가 기본 버전).
fn versions(ids: &[&str], default: &str) -> Vec<VersionRec> {
    ids.iter().map(|id| VersionRec { id: id.to_string(), is_default: *id == default, created_at: None }).collect()
}

/// 붙은 관리형 정책이 `attached`인 그룹.
fn group_rec(name: &str, attached: &[&str]) -> GroupRec {
    GroupRec { arn: account_arn(&format!("group/{name}")), name: name.into(), path: "/".into(), attached: attached.iter().map(|a| a.to_string()).collect(), ..Default::default() }
}

/// 이 수준의 경고가 정확히 하나이고 그 메시지.
fn only(p: &ChangePreview, level: WarnLevel) -> &str {
    let found = messages(p, level);
    assert_eq!(found.len(), 1, "{:?}", p.warnings);
    found[0]
}
