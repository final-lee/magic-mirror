//! 쓰기 테스트: SDK가 실제로 보낸 요청(가짜 전송 계층이 기록한 것)이 미리보기에 보인 호출과 같은지 확인한다.

use serde_json::json;

use super::*;
use crate::iam::change::calls;
use crate::iam::fixtures::*;
use crate::iam::mock_aws::{error_xml, Recorder, Sent};
use crate::iam::model::VersionRec;

fn doc(actions: &[&str]) -> String {
    policy(json!([{ "Effect": "Allow", "Action": actions, "Resource": "*" }])).to_string()
}

/// 미리보기의 호출 목록을 서버로 간 요청의 모양(`Action` + 인자)으로 바꾼 것.
fn listed(s: &Snapshot, c: &IamChange) -> Vec<Sent> {
    calls(s, c).into_iter().map(|call| Sent { action: call.api.strip_prefix("iam:").unwrap().to_string(), params: call.params }).collect()
}

fn names(s: &Snapshot, c: &IamChange) -> Vec<String> {
    calls(s, c).into_iter().map(|call| call.api).collect()
}

async fn run(s: &Snapshot, c: &IamChange) -> (Result<Vec<String>, AppError>, Vec<Sent>) {
    let recorder = Recorder::ok();
    let result = apply(&recorder.client(), s, c).await;
    (result, recorder.sent())
}

fn sent(action: &str, params: &[(&str, &str)]) -> Sent {
    Sent { action: action.into(), params: params.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
}

/// 버전이 다섯 개 찬 관리형 정책(v5가 기본)이 있는 스냅숏.
fn full_policy_snapshot() -> Snapshot {
    let mut s = snapshot();
    s.policies.get_mut(UNUSED_POLICY).unwrap().versions =
        ["v1", "v2", "v3", "v4", "v5"].iter().map(|id| VersionRec { id: id.to_string(), is_default: *id == "v5", created_at: None }).collect();
    s
}

/// `action`만 실패하고 나머지는 성공하는 가짜 전송 계층.
fn failing(action: &'static str, status: u16, code: &'static str) -> Recorder {
    let fine = Recorder::ok();
    Recorder::new(move |sent| if sent.action == action { (status, error_xml(code, "실패")) } else { fine.respond(sent) })
}

#[tokio::test]
async fn every_change_sends_exactly_the_calls_the_preview_listed() {
    let s = full_policy_snapshot();
    let changes = [
        IamChange::AttachPolicy { target: BOB.into(), policy_arn: S3_FULL.into() },
        IamChange::AttachPolicy { target: ADMINS.into(), policy_arn: S3_FULL.into() },
        IamChange::AttachPolicy { target: DEPLOY.into(), policy_arn: S3_FULL.into() },
        IamChange::DetachPolicy { target: CAROL.into(), policy_arn: S3_FULL.into() },
        IamChange::DetachPolicy { target: ADMINS.into(), policy_arn: ADMIN_POLICY.into() },
        IamChange::DetachPolicy { target: DEPLOY.into(), policy_arn: S3_FULL.into() },
        IamChange::AddToGroup { user_name: "bob".into(), group_name: "admins".into() },
        IamChange::RemoveFromGroup { user_name: "alice".into(), group_name: "admins".into() },
        IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: "AKIA1".into(), status: "Inactive".into() },
        IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: "AKIA1".into(), status: "Active".into() },
        IamChange::DeleteAccessKey { user_name: "bob".into(), access_key_id: "AKIA1".into() },
        IamChange::PutInlinePolicy { target: BOB.into(), name: "p".into(), document: doc(&["s3:GetObject"]) },
        IamChange::PutInlinePolicy { target: ADMINS.into(), name: "p".into(), document: doc(&["s3:GetObject"]) },
        IamChange::PutInlinePolicy { target: DEPLOY.into(), name: "p".into(), document: doc(&["s3:GetObject"]) },
        IamChange::DeleteInlinePolicy { target: BOB.into(), name: "assets-read".into() },
        IamChange::DeleteInlinePolicy { target: ADMINS.into(), name: "p".into() },
        IamChange::DeleteInlinePolicy { target: DEPLOY.into(), name: "deploy-inline".into() },
        IamChange::UpdateManagedPolicy { policy_arn: UNUSED_POLICY.into(), document: doc(&["s3:ListBucket"]) },
        IamChange::UpdateManagedPolicy { policy_arn: CAROL_BOUNDARY.into(), document: doc(&["s3:ListBucket"]) },
    ];
    for change in changes {
        let (result, wire) = run(&s, &change).await;
        assert!(!wire.is_empty(), "{change:?}");
        assert_eq!(wire, listed(&s, &change), "{change:?}");
        assert_eq!(result, Ok(names(&s, &change)), "{change:?}");
    }
}

#[tokio::test]
async fn the_wire_requests_have_the_aws_api_names_and_parameters() {
    let s = snapshot();
    let (_, wire) = run(&s, &IamChange::AttachPolicy { target: BOB.into(), policy_arn: S3_FULL.into() }).await;
    assert_eq!(wire, vec![sent("AttachUserPolicy", &[("PolicyArn", S3_FULL), ("UserName", "bob")])]);
    let (_, wire) = run(&s, &IamChange::DetachPolicy { target: DEPLOY.into(), policy_arn: S3_FULL.into() }).await;
    assert_eq!(wire, vec![sent("DetachRolePolicy", &[("PolicyArn", S3_FULL), ("RoleName", "deploy")])]);
    let (_, wire) = run(&s, &IamChange::AddToGroup { user_name: "bob".into(), group_name: "admins".into() }).await;
    assert_eq!(wire, vec![sent("AddUserToGroup", &[("GroupName", "admins"), ("UserName", "bob")])]);
    let (_, wire) = run(&s, &IamChange::RemoveFromGroup { user_name: "alice".into(), group_name: "admins".into() }).await;
    assert_eq!(wire, vec![sent("RemoveUserFromGroup", &[("GroupName", "admins"), ("UserName", "alice")])]);
    let (_, wire) = run(&s, &IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: "AKIA1".into(), status: "Inactive".into() }).await;
    assert_eq!(wire, vec![sent("UpdateAccessKey", &[("AccessKeyId", "AKIA1"), ("Status", "Inactive"), ("UserName", "bob")])]);
    let (_, wire) = run(&s, &IamChange::DeleteAccessKey { user_name: "bob".into(), access_key_id: "AKIA1".into() }).await;
    assert_eq!(wire, vec![sent("DeleteAccessKey", &[("AccessKeyId", "AKIA1"), ("UserName", "bob")])]);
    let (_, wire) = run(&s, &IamChange::DeleteInlinePolicy { target: ADMINS.into(), name: "p".into() }).await;
    assert_eq!(wire, vec![sent("DeleteGroupPolicy", &[("GroupName", "admins"), ("PolicyName", "p")])]);
}

#[tokio::test]
async fn a_policy_document_goes_out_exactly_as_given() {
    let s = snapshot();
    let document = "{\n  \"Version\": \"2012-10-17\",\n  \"Statement\": [{ \"Sid\": \"한글 & 공백\", \"Effect\": \"Allow\", \"Action\": \"s3:GetObject\", \"Resource\": \"*\" }]\n}";
    let (result, wire) = run(&s, &IamChange::PutInlinePolicy { target: BOB.into(), name: "p".into(), document: document.into() }).await;
    result.unwrap();
    assert_eq!(wire, vec![sent("PutUserPolicy", &[("PolicyDocument", document), ("PolicyName", "p"), ("UserName", "bob")])]);
}

#[tokio::test]
async fn editing_a_managed_policy_creates_a_default_version() {
    let s = snapshot();
    let document = doc(&["s3:ListBucket"]);
    let (result, wire) = run(&s, &IamChange::UpdateManagedPolicy { policy_arn: UNUSED_POLICY.into(), document: document.clone() }).await;
    result.unwrap();
    assert_eq!(wire, vec![sent("CreatePolicyVersion", &[("PolicyArn", UNUSED_POLICY), ("PolicyDocument", &document), ("SetAsDefault", "true")])]);
}

#[tokio::test]
async fn a_full_policy_loses_its_oldest_non_default_version_before_the_new_one_is_made() {
    let s = full_policy_snapshot();
    let document = doc(&["s3:ListBucket"]);
    let (result, wire) = run(&s, &IamChange::UpdateManagedPolicy { policy_arn: UNUSED_POLICY.into(), document: document.clone() }).await;
    assert_eq!(result, Ok(vec!["iam:DeletePolicyVersion".to_string(), "iam:CreatePolicyVersion".to_string()]));
    assert_eq!(
        wire,
        vec![
            sent("DeletePolicyVersion", &[("PolicyArn", UNUSED_POLICY), ("VersionId", "v1")]),
            sent("CreatePolicyVersion", &[("PolicyArn", UNUSED_POLICY), ("PolicyDocument", &document), ("SetAsDefault", "true")]),
        ]
    );
}

#[tokio::test]
async fn a_failure_stops_there_and_keeps_the_kind_of_error() {
    let s = full_policy_snapshot();
    let change = IamChange::UpdateManagedPolicy { policy_arn: UNUSED_POLICY.into(), document: doc(&["s3:ListBucket"]) };
    let recorder = failing("DeletePolicyVersion", 403, "AccessDenied");
    let result = apply(&recorder.client(), &s, &change).await;
    assert_eq!(result, Err(AppError::AccessDenied { action: "iam:DeletePolicyVersion".into() }));
    let actions: Vec<String> = recorder.sent().into_iter().map(|s| s.action).collect();
    assert_eq!(actions, vec!["DeletePolicyVersion"], "앞 호출이 실패하면 새 버전을 만들지 않아요");
}

#[tokio::test]
async fn a_failure_after_an_earlier_call_is_reported_with_the_awss_message() {
    let s = full_policy_snapshot();
    let change = IamChange::UpdateManagedPolicy { policy_arn: UNUSED_POLICY.into(), document: doc(&["s3:ListBucket"]) };
    let recorder = failing("CreatePolicyVersion", 400, "MalformedPolicyDocument");
    let Err(AppError::Other { message }) = apply(&recorder.client(), &s, &change).await else { panic!("Other 오류여야 해요") };
    assert!(message.contains("MalformedPolicyDocument"), "{message}");
    assert_eq!(recorder.sent().len(), 2);
}

#[tokio::test]
async fn throttling_and_expired_sessions_are_told_apart() {
    let s = snapshot();
    let change = IamChange::AttachPolicy { target: BOB.into(), policy_arn: S3_FULL.into() };
    let throttled = failing("AttachUserPolicy", 400, "Throttling");
    assert_eq!(apply(&throttled.client(), &s, &change).await, Err(AppError::Throttled));
    let expired = failing("AttachUserPolicy", 400, "ExpiredToken");
    assert_eq!(apply(&expired.client(), &s, &change).await, Err(AppError::SsoExpired));
}

#[tokio::test]
async fn a_change_with_no_calls_sends_nothing_and_fails() {
    let s = snapshot();
    let missing = format!("arn:aws:iam::{ACCOUNT}:user/nobody");
    let (result, wire) = run(&s, &IamChange::AttachPolicy { target: missing, policy_arn: S3_FULL.into() }).await;
    assert!(matches!(result, Err(AppError::Other { .. })), "{result:?}");
    assert!(wire.is_empty());
}

#[tokio::test]
async fn a_key_status_other_than_active_or_inactive_is_never_sent() {
    let s = snapshot();
    for status in ["Disabled", "active", ""] {
        let (result, wire) = run(&s, &IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: "AKIA1".into(), status: status.into() }).await;
        assert!(matches!(result, Err(AppError::Other { .. })), "{status}: {result:?}");
        assert!(wire.is_empty(), "{status}");
    }
}
