//! 정책(ACL) 화면의 백엔드: 읽기·지적, 누가 무엇에 닿나, 검사, 저장(`If-Match`), 되돌리기.
//! 저장·되돌리기만 쓰기 스코프(`policy_file`)를 쓰고, 나머지는 읽기 스코프다(검사·미리보기는 정책을 바꾸지 않는다).
use std::collections::BTreeSet;
use std::path::Path;

use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::api::{Request, Scope, TailscaleState, RESPONSE_ERROR};
use super::changes::{self, Entry, Target};
use crate::error::AppError;

mod findings;
pub use findings::Finding;

#[cfg(test)]
mod tests;

const HUJSON: &str = "application/hujson";
const ACL: &str = "/tailnet/-/acl";
const WRITE_SCOPE: &str = "policy_file";
/// 기록 대상 이름과 변경 종류.
const ACTION: &str = "policy";
/// 되돌릴 기록 뒤에 정책이 또 바뀌었을 때의 안내.
pub const CHANGED_SINCE: &str = "그 뒤에 정책이 또 바뀌어서 되돌릴 수 없어요. 지금 정책을 확인한 뒤 직접 고쳐 주세요";

/// 정책 보기에 필요한 모든 것.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyView {
    /// HuJSON 원문(주석 포함). 편집기의 처음 글이다.
    pub text: String,
    /// 저장할 때 `If-Match`로 되돌려 보낼 값.
    pub etag: Option<String>,
    /// 정책을 다른 곳(Git 등)에서 관리해서 여기서는 못 바꾼다.
    pub externally_managed: bool,
    pub external_link: Option<String>,
    pub findings: Vec<Finding>,
}

/// 편집한 정책의 검사 결과 한 항목(시험 실패·경고 등).
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Issue {
    pub subject: Option<String>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Validation {
    /// 오류(문법·시험 실패)가 없다. 경고만 있으면 true.
    pub ok: bool,
    pub message: Option<String>,
    pub issues: Vec<Issue>,
}

/// 규칙 하나: 이 사용자·주소에 적용되는 출발지와 목적지, 그 규칙이 정책 글의 몇 번째 줄인지.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleMatch {
    pub users: Vec<String>,
    pub ports: Vec<String>,
    pub line_number: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewKind {
    User,
    Ipport,
}

impl PreviewKind {
    fn name(self) -> &'static str {
        match self {
            PreviewKind::User => "user",
            PreviewKind::Ipport => "ipport",
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    /// 저장된 정책의 새 ETag.
    pub etag: Option<String>,
    /// 정책은 저장했지만 변경 기록을 남기지 못했을 때의 안내.
    pub record_error: Option<String>,
}

fn query_path(path: &str, pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse("http://localhost/").expect("static URL");
    url.query_pairs_mut().extend_pairs(pairs);
    format!("{path}?{}", url.query().unwrap_or_default())
}

fn device_tags(devices: &Value) -> Option<BTreeSet<String>> {
    let devices = devices.get("devices")?.as_array()?;
    Some(devices.iter().flat_map(|d| d.get("tags").and_then(Value::as_array).into_iter().flatten()).filter_map(Value::as_str).map(str::to_owned).collect())
}

/// 외부 링크는 웹 주소만 받는다(앱이 그대로 연다).
fn external_link(settings: &Value) -> Option<String> {
    let link = settings.get("aclsExternalLink").and_then(Value::as_str)?.trim();
    (link.starts_with("https://") || link.starts_with("http://")).then(|| link.to_owned())
}

/// 정책 원문(HuJSON)과 ETag, 지적을 읽는다. 테일넷 설정과 기기 목록은 보조라서 못 읽어도 정책은 보여 준다
/// (설정을 못 읽으면 외부 관리가 아니라고 보고, 기기를 못 읽으면 쓰지 않는 태그는 말하지 않는다).
pub async fn load(state: &TailscaleState, tailnet: &str) -> Result<PolicyView, AppError> {
    let (hujson, json, settings, devices) = tokio::join!(
        state.request(tailnet, Request::get(ACL).accept(HUJSON)),
        state.request(tailnet, Request::get(ACL).accept("application/json")),
        state.get_json(tailnet, "/tailnet/-/settings"),
        state.get_json(tailnet, "/tailnet/-/devices"),
    );
    let hujson = hujson?;
    let policy = json?.json()?;
    let settings = settings.unwrap_or(Value::Null);
    Ok(PolicyView {
        findings: findings::analyze(&policy, device_tags(&devices.unwrap_or(Value::Null)).as_ref()),
        externally_managed: settings.get("aclsExternallyManagedOn").and_then(Value::as_bool).unwrap_or(false),
        external_link: external_link(&settings),
        etag: hujson.etag,
        text: hujson.body,
    })
}

/// `previewFor`가 누구(이메일)·어디(`ip:포트`)인지에 맞는 규칙들. 저장하지 않고 `text`(편집 중인 정책)로 판정한다.
pub async fn preview(state: &TailscaleState, tailnet: &str, kind: PreviewKind, subject: &str, text: &str) -> Result<Vec<RuleMatch>, AppError> {
    let subject = subject.trim();
    if subject.is_empty() {
        return Err(AppError::other("이메일이나 IP:포트를 넣어 주세요"));
    }
    let path = query_path("/tailnet/-/acl/preview", &[("type", kind.name()), ("previewFor", subject)]);
    let body = state.request(tailnet, Request::new(Method::POST, &path, Scope::Read).text(HUJSON, text)).await?.json()?;
    let matches = body.get("matches").and_then(Value::as_array).ok_or_else(|| AppError::other(RESPONSE_ERROR))?;
    Ok(matches
        .iter()
        .map(|m| RuleMatch {
            users: string_list(m.get("users")),
            ports: string_list(m.get("ports")),
            line_number: m.get("lineNumber").and_then(Value::as_u64).unwrap_or(0) as u32,
        })
        .collect())
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

fn issue(entry: &Value) -> Issue {
    let subject = ["user", "src", "test"].iter().find_map(|k| entry.get(k).and_then(Value::as_str)).map(str::to_owned);
    Issue { subject, errors: string_list(entry.get("errors")), warnings: string_list(entry.get("warnings")) }
}

/// 검사 응답: 본문이 비었거나 `{}`이면 통과, 아니면 `message`와 `data`(주체별 오류·경고).
fn validation(body: &str) -> Result<Validation, AppError> {
    if body.trim().is_empty() {
        return Ok(Validation { ok: true, message: None, issues: Vec::new() });
    }
    let value: Value = serde_json::from_str(body).map_err(|_| AppError::other(RESPONSE_ERROR))?;
    let message = value.get("message").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_owned);
    let issues: Vec<Issue> = value.get("data").and_then(Value::as_array).into_iter().flatten().map(issue).collect();
    let failed = issues.iter().any(|i| !i.errors.is_empty()) || (issues.is_empty() && message.is_some());
    Ok(Validation { ok: !failed, message, issues })
}

/// 정책을 저장하지 않고 문법과 `tests`를 검사한다. 문법이 틀리면 API가 400으로 거절하고 그 메시지가 오류로 나간다.
pub async fn validate(state: &TailscaleState, tailnet: &str, text: &str) -> Result<Validation, AppError> {
    let response = state.request(tailnet, Request::new(Method::POST, "/tailnet/-/acl/validate", Scope::Read).text(HUJSON, text)).await?;
    validation(&response.body)
}

fn record(path: &Path, tailnet: &str, before: &str, after: &str) -> std::io::Result<()> {
    let at = crate::iam::clock::now_secs();
    let entry = Entry {
        id: format!("policy-{at}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos())),
        at: crate::iam::clock::iso(at),
        tailnet: tailnet.trim().to_owned(),
        action: ACTION.into(),
        target: Target { device_id: None, name: Some("policy".into()) },
        summary: "정책 파일을 저장했어요".into(),
        before: Value::String(before.to_owned()),
        after: Value::String(after.to_owned()),
        undo_of: None,
        undone: false,
    };
    changes::record(path, &entry)
}

/// `after`를 정책으로 저장한다. `etag`는 `before`를 읽을 때 받은 값이라, 그 뒤 다른 곳에서 정책이 바뀌었으면 412(`CHANGED_ELSEWHERE`)로 거절된다.
/// 저장하면 `before`·`after` 글을 변경 기록(`tailscale-changes.jsonl`)에 남긴다. 기록 실패는 저장 결과를 뒤집지 않고 `record_error`로 알린다.
pub async fn save(state: &TailscaleState, tailnet: &str, before: &str, after: &str, etag: &str) -> Result<SaveOutcome, AppError> {
    let request = Request::new(Method::POST, ACL, Scope::Write(WRITE_SCOPE)).text(HUJSON, after).if_match(etag);
    let response = state.request(tailnet, request).await?;
    let record_error = record(state.changes_path(), tailnet, before, after).err().map(|e| format!("정책은 저장했지만 변경 기록을 남기지 못했어요 ({e})"));
    Ok(SaveOutcome { etag: response.etag, record_error })
}

/// 변경 기록의 `before` 글로 정책을 되돌린다. 지금 정책이 그 기록이 남긴 `expected_after`와 다르면(그 뒤에 또 바뀜) 덮어쓰지 않고 거절한다.
/// 같을 때만 지금 정책의 ETag를 `If-Match`로 보낸다.
pub async fn restore(state: &TailscaleState, tailnet: &str, before_text: &str, expected_after: &str) -> Result<(), AppError> {
    let current = state.request(tailnet, Request::get(ACL).accept(HUJSON)).await?;
    if current.body.trim_end() != expected_after.trim_end() {
        return Err(AppError::other(CHANGED_SINCE));
    }
    let etag = current.etag.ok_or_else(|| AppError::other(RESPONSE_ERROR))?;
    let request = Request::new(Method::POST, ACL, Scope::Write(WRITE_SCOPE)).text(HUJSON, before_text).if_match(etag);
    state.request(tailnet, request).await?;
    Ok(())
}
