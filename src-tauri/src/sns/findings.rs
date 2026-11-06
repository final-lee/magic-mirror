//! SNS 보안 점검(순수 함수). 주제 스냅샷·정책 문장·엔드포인트 존재 목록을 받아 점검 결과를 만든다. AWS 호출은 없다.

use std::collections::HashSet;
use serde::Serialize;
use super::access::grants;
use super::model::{SnsSubscription, SnsTopic};
use super::policy::{Reach, StatementView};

/// 수준. 선언 순서가 곧 심각도 순서다(높음이 앞).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level { High, Medium, Low, Info }

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInfo { pub id: &'static str, pub level: Level, pub title: &'static str }

/// 점검 목록. 순서는 화면에서 보여 주는 순서이기도 하다.
pub const CHECKS: &[CheckInfo] = &[
    CheckInfo { id: "publicPolicy", level: Level::High, title: "정책이 공개돼 있어요" },
    CheckInfo { id: "crossAccountAccess", level: Level::High, title: "다른 계정이 구독·수신할 수 있어요" },
    CheckInfo { id: "confusedDeputy", level: Level::Medium, title: "서비스 허용에 출처 조건이 없어요" },
    CheckInfo { id: "unencrypted", level: Level::Medium, title: "암호화되지 않았어요" },
    CheckInfo { id: "httpEndpoint", level: Level::Medium, title: "http:// 구독이 있어요" },
    CheckInfo { id: "signatureV1", level: Level::Low, title: "서명 버전 1(SHA1)이에요" },
    CheckInfo { id: "pendingConfirmation", level: Level::Low, title: "확인 대기 구독이 있어요" },
    CheckInfo { id: "orphanSubscription", level: Level::Low, title: "고아 구독이 있어요" },
    CheckInfo { id: "noDlq", level: Level::Low, title: "DLQ 없는 구독이 있어요" },
    CheckInfo { id: "noDeliveryLogging", level: Level::Info, title: "배달 상태 로깅이 꺼져 있어요" },
];

fn info(id: &str) -> &'static CheckInfo {
    CHECKS.iter().find(|c| c.id == id).expect("알 수 없는 점검 id")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsFinding {
    pub check: String,
    pub level: Level,
    pub topic_arn: String,
    pub topic_name: String,
    pub summary: String,
    pub detail: Option<String>,
    /// 해당하는 문장·구독·엔드포인트
    pub items: Vec<String>,
}

fn finding(check: &str, topic_arn: &str, summary: impl Into<String>, detail: Option<String>, items: Vec<String>) -> SnsFinding {
    SnsFinding { check: check.into(), level: info(check).level, topic_arn: topic_arn.into(), topic_name: topic_name(topic_arn).into(), summary: summary.into(), detail, items }
}

pub fn topic_name(arn: &str) -> &str { arn.rsplit(':').next().unwrap_or(arn) }

/// 구독의 DLQ 상태. 속성을 못 읽었거나 확인 대기면 `Unknown`이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dlq { Unknown, Missing, Present }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubFacts { pub arn: Option<String>, pub protocol: String, pub endpoint: String, pub confirmed: bool, pub pending: bool, pub dlq: Dlq }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopicFacts {
    pub arn: String,
    pub kms_key: Option<String>,
    pub signature_version: u32,
    pub logging_on: bool,
    pub subscriptions: Vec<SubFacts>,
}

/// 같은 프로필·리전에서 목록으로 읽은 존재 목록. `None`이면 못 읽은 것이라 그 점검은 건너뛴다.
#[derive(Debug, Clone, Default)]
pub struct Existence {
    /// 주제 ARN
    pub topics: Option<HashSet<String>>,
    /// 큐 이름
    pub queues: Option<HashSet<String>>,
    /// 함수 이름
    pub functions: Option<HashSet<String>>,
}

/// `CheckNoPublicAccess` 결과
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicAccess { pub fail: bool, pub message: Option<String>, pub reasons: Vec<String> }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OrphanReason { TopicMissing, EndpointMissing }

impl TopicFacts {
    pub fn from_topic(topic: &SnsTopic) -> Self {
        Self {
            arn: topic.arn.clone(), kms_key: topic.overview.kms_key.clone(), signature_version: topic.overview.signature_version,
            logging_on: topic.overview.delivery_logging.iter().any(|l| l.success_role.is_some() || l.failure_role.is_some()),
            subscriptions: topic.subscriptions.iter().map(SubFacts::from_subscription).collect(),
        }
    }
}

impl SubFacts {
    pub fn from_subscription(s: &SnsSubscription) -> Self {
        let confirmed = s.state == "confirmed";
        let dlq = if !confirmed || s.error.is_some() { Dlq::Unknown } else if s.dlq_arn.is_some() { Dlq::Present } else { Dlq::Missing };
        Self { arn: s.arn.clone(), protocol: s.protocol.clone(), endpoint: s.endpoint.clone(), confirmed, pending: s.state == "pending", dlq }
    }
}

/// `arn:aws:<service>:<region>:<account>:<resource…>`를 나눈다. 같은 계정·리전이 아니면 None
fn own_resource<'a>(arn: &'a str, service: &str, account: &str, region: &str) -> Option<&'a str> {
    let parts: Vec<_> = arn.splitn(6, ':').collect();
    (parts.len() == 6 && parts[0] == "arn" && parts[2] == service && parts[3] == region && parts[4] == account).then(|| parts[5])
}

/// 현재 계정·리전의 주제 ARN인가
pub fn is_own_topic(arn: &str, account: &str, region: &str) -> bool {
    own_resource(arn, "sns", account, region).is_some_and(|name| !name.is_empty())
}

/// 이 구독이 고아인 이유. 다른 계정·리전의 것은 건드리지 않고 판정하지 않는다.
pub fn orphan_reason(topic_arn: &str, protocol: &str, endpoint: &str, account: &str, region: &str, existence: &Existence) -> Option<OrphanReason> {
    if let (Some(topics), Some(_)) = (&existence.topics, own_resource(topic_arn, "sns", account, region)) {
        if !topics.contains(topic_arn) { return Some(OrphanReason::TopicMissing); }
    }
    match protocol {
        "sqs" => {
            let name = own_resource(endpoint, "sqs", account, region)?;
            existence.queues.as_ref().filter(|q| !q.contains(name)).map(|_| OrphanReason::EndpointMissing)
        }
        "lambda" => {
            let resource = own_resource(endpoint, "lambda", account, region)?;
            let name = resource.strip_prefix("function:")?.split(':').next()?;
            existence.functions.as_ref().filter(|f| !f.contains(name)).map(|_| OrphanReason::EndpointMissing)
        }
        _ => None,
    }
}

fn is_allow(s: &StatementView) -> bool { s.effect == "Allow" }

fn describes(s: &StatementView) -> String {
    match &s.sid { Some(sid) => format!("{sid}: {}", s.sentence), None => s.sentence.clone() }
}

fn has_source_condition(s: &StatementView) -> bool {
    s.conditions.iter().any(|c| {
        let key = c.split(" · ").next().unwrap_or("").to_ascii_lowercase();
        key == "aws:sourcearn" || key == "aws:sourceaccount"
    })
}

const LOGGABLE: &[&str] = &["lambda", "sqs", "http", "https", "application", "firehose"];

/// 주제 하나의 점검 결과. 수준(높음 먼저), 점검 목록 순서로 정렬한다.
pub fn topic_findings(facts: &TopicFacts, statements: &[StatementView], public: Option<&PublicAccess>, account: &str, region: &str, existence: &Existence) -> Vec<SnsFinding> {
    let arn = facts.arn.as_str();
    let mut out = Vec::new();

    let open: Vec<_> = statements.iter().filter(|s| is_allow(s) && s.scope == Reach::Public).collect();
    let analyzer_fail = public.filter(|p| p.fail);
    if !open.is_empty() || analyzer_fail.is_some() {
        let mut items: Vec<String> = open.iter().map(|s| describes(s)).collect();
        if let Some(p) = analyzer_fail { items.extend(p.reasons.iter().cloned()); }
        let summary = if open.is_empty() { "Access Analyzer가 공개 접근을 찾았어요" } else { "아무나(Principal *) 조건 없이 쓸 수 있는 문장이 있어요" };
        out.push(finding("publicPolicy", arn, summary, analyzer_fail.and_then(|p| p.message.clone()), items));
    }

    let cross: Vec<_> = statements.iter().filter(|s| is_allow(s) && s.scope == Reach::CrossAccount && (grants(s, "sns:Subscribe") || grants(s, "sns:Receive"))).collect();
    if !cross.is_empty() {
        out.push(finding("crossAccountAccess", arn, "다른 계정이 이 주제를 구독하거나 받을 수 있어요", None, cross.iter().map(|s| describes(s)).collect()));
    }

    let deputy: Vec<_> = statements.iter().filter(|s| is_allow(s) && s.scope == Reach::Service && !has_source_condition(s)).collect();
    if !deputy.is_empty() {
        out.push(finding("confusedDeputy", arn, "서비스 주체를 허용하면서 aws:SourceAccount·aws:SourceArn 조건이 없어요", Some("다른 계정의 같은 서비스가 이 주제를 쓸 수 있어요(confused deputy).".into()), deputy.iter().map(|s| describes(s)).collect()));
    }

    if facts.kms_key.is_none() {
        out.push(finding("unencrypted", arn, "저장 시 암호화(KMS)가 꺼져 있어요", None, Vec::new()));
    }

    let http: Vec<_> = facts.subscriptions.iter().filter(|s| s.protocol == "http").map(|s| s.endpoint.clone()).collect();
    if !http.is_empty() {
        out.push(finding("httpEndpoint", arn, format!("평문 http:// 구독이 {}개 있어요", http.len()), None, http));
    }

    if facts.signature_version == 1 {
        out.push(finding("signatureV1", arn, "서명 버전 1(SHA1)을 쓰고 있어요", Some("서명 버전 2(SHA256)로 바꾸는 것을 권장해요.".into()), Vec::new()));
    }

    let pending: Vec<_> = facts.subscriptions.iter().filter(|s| s.pending).map(|s| format!("{} · {}", s.protocol, s.endpoint)).collect();
    if !pending.is_empty() {
        out.push(finding("pendingConfirmation", arn, format!("확인 대기 구독이 {}개 있어요", pending.len()), Some("email·http 구독은 확인하지 않으면 3일 뒤 자동으로 지워져요.".into()), pending));
    }

    let orphans: Vec<_> = facts.subscriptions.iter()
        .filter(|s| orphan_reason(arn, &s.protocol, &s.endpoint, account, region, existence) == Some(OrphanReason::EndpointMissing))
        .map(|s| format!("{} · {}", s.protocol, s.endpoint)).collect();
    if !orphans.is_empty() {
        out.push(finding("orphanSubscription", arn, format!("엔드포인트가 없는 구독이 {}개 있어요", orphans.len()), None, orphans));
    }

    let no_dlq: Vec<_> = facts.subscriptions.iter().filter(|s| matches!(s.protocol.as_str(), "sqs" | "lambda") && s.dlq == Dlq::Missing).map(|s| format!("{} · {}", s.protocol, s.endpoint)).collect();
    if !no_dlq.is_empty() {
        out.push(finding("noDlq", arn, format!("DLQ가 없는 SQS·Lambda 구독이 {}개 있어요", no_dlq.len()), Some("배달에 실패한 메시지가 그냥 사라져요.".into()), no_dlq));
    }

    if !facts.logging_on && facts.subscriptions.iter().any(|s| LOGGABLE.contains(&s.protocol.as_str())) {
        out.push(finding("noDeliveryLogging", arn, "배달 상태 로깅이 꺼져 있어요", Some("배달이 실패해도 이유를 로그에서 볼 수 없어요.".into()), Vec::new()));
    }

    sort(&mut out);
    out
}

/// 계정 주제 목록에 없는 주제를 가리키는 고아 구독을 주제별 점검 결과로 묶는다.
pub fn missing_topic_findings(orphans: &[(String, String)]) -> Vec<SnsFinding> {
    let mut topics: Vec<&str> = orphans.iter().map(|(t, _)| t.as_str()).collect();
    topics.sort_unstable();
    topics.dedup();
    topics.into_iter().map(|t| {
        let items: Vec<String> = orphans.iter().filter(|(topic, _)| topic == t).map(|(_, item)| item.clone()).collect();
        finding("orphanSubscription", t, format!("주제가 없는 구독이 {}개 있어요", items.len()), Some("주제를 지워도 구독은 한동안 목록에 남아요.".into()), items)
    }).collect()
}

/// 유료 `CheckNoPublicAccess`가 FAIL일 때 `publicPolicy` 점검 결과. PASS면 None.
pub fn public_access_finding(topic_arn: &str, public: &PublicAccess) -> Option<SnsFinding> {
    public.fail.then(|| finding("publicPolicy", topic_arn, "Access Analyzer가 공개 접근을 찾았어요", public.message.clone(), public.reasons.clone()))
}

pub fn sort(findings: &mut [SnsFinding]) {
    let order = |f: &SnsFinding| CHECKS.iter().position(|c| c.id == f.check).unwrap_or(usize::MAX);
    findings.sort_by(|a, b| a.level.cmp(&b.level).then(order(a).cmp(&order(b))).then(a.topic_name.cmp(&b.topic_name)));
}

#[cfg(test)]
mod tests;
