//! S5b 변경의 계획: 구독 만들기·해지, 필터 정책, raw 전달, HTTP 배달 정책, 주제 정책, 배달 상태 로깅, 시험 발행.
//! 읽기(AWS에서 현재 값을 읽는 일)와 순수 계산(검증·호출·바뀌는 값 만들기)을 나눠서, 계산은 AWS 없이 시험한다.
//! 실제 쓰기 호출은 `write.rs`에만 있다. 여기서는 어떤 호출을 보낼지만 정한다.
use super::*;
use crate::sns::{
    fetch,
    filter::{self, Scope},
    model::{SnsSubscription, SnsTopic},
    policy::Reach,
    roles,
};
use std::collections::{BTreeMap, HashMap};

/// 계획이 만든 조각. `plan`이 이것을 합쳐 지문·진단 변화·확인 문구를 붙인다.
pub struct Built {
    pub topic: String,
    pub calls: Vec<SnsCall>,
    pub fields: Vec<SnsFieldChange>,
    pub state: Vec<Value>,
    pub warnings: Vec<String>,
    /// 정책이 공개·다른 계정으로 넓어진다: 주제 이름을 입력해야 적용할 수 있다
    pub widen: bool,
    /// 주제 이름에 `prod`가 있으면 이름 입력을 요구하는 변경(구독 해지·필터 변경·주제 정책 저장)
    pub name_rule: bool,
    /// 이미 읽은 주제 스냅샷. 있으면 `plan`이 진단 변화를 계산할 때 다시 읽지 않는다
    pub snapshot: Option<SnsTopic>,
}
impl Built {
    fn new(topic: &str) -> Self {
        Self {
            topic: topic.into(),
            calls: vec![],
            fields: vec![],
            state: vec![],
            warnings: vec![],
            widen: false,
            name_rule: false,
            snapshot: None,
        }
    }
    fn push(&mut self, parts: (Vec<SnsCall>, Vec<SnsFieldChange>)) {
        self.calls.extend(parts.0);
        self.fields.extend(parts.1);
    }
}

const PROTOCOLS: [&str; 6] = ["sqs", "lambda", "https", "http", "email", "email-json"];
/// SNS가 원시 전달(raw)을 지원하는 구독 프로토콜(Lambda는 늘 SNS 봉투로 받는다)
const RAW_PROTOCOLS: [&str; 3] = ["sqs", "http", "https"];
const PENDING_PROTOCOLS: [&str; 4] = ["http", "https", "email", "email-json"];
const LOG_PROTOCOLS: [&str; 5] = ["Lambda", "SQS", "HTTP", "Application", "Firehose"];
/// 필터·배달 정책을 지울 때 보내는 값
const NO_POLICY: &str = "{}";
/// 해지한 구독을 다시 만들 때 되살리는 속성
const SAVED: [&str; 5] = [
    "FilterPolicy",
    "FilterPolicyScope",
    "RawMessageDelivery",
    "RedrivePolicy",
    "DeliveryPolicy",
];
const MAX_MESSAGE_BYTES: usize = 262_144;

/// 시험 발행의 메시지 속성 하나
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishAttribute {
    pub name: String,
    pub data_type: String,
    pub value: String,
}

fn arn_is(arn: &str, service: &str) -> bool {
    let p: Vec<_> = arn.splitn(6, ':').collect();
    p.len() == 6 && p[0] == "arn" && p[2] == service && !p[5].is_empty()
}
fn is_local(arn: &str, account: &str, region: &str) -> bool {
    checked_arn(arn, arn.split(':').nth(2).unwrap_or(""), account, region).is_ok()
}
fn blank(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}
fn compact(raw: &str) -> Result<String, String> {
    serde_json::from_str::<Value>(raw)
        .map(|v| v.to_string())
        .map_err(|e| format!("JSON 문법 오류: {e}"))
}
fn same_json(a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => match (
            serde_json::from_str::<Value>(a),
            serde_json::from_str::<Value>(b),
        ) {
            (Ok(a), Ok(b)) => a == b,
            _ => a == b,
        },
        _ => false,
    }
}
/// 기록의 이전 값: 그 필드가 기록에 없으면 `None`(바뀌지 않았다), 있고 비었으면 `Some(None)`
fn prior_opt(record: &SnsChangeRecord, name: &str) -> Option<Option<String>> {
    record
        .before
        .get(name)
        .map(|v| v.as_str().map(str::to_owned))
}
fn has_sid(document: &str, sid: &str) -> bool {
    serde_json::from_str::<Value>(&crate::iam::policy::decode_document(document))
        .ok()
        .and_then(|d| d.get("Statement").cloned())
        .is_some_and(|s| match s {
            Value::Array(a) => a
                .iter()
                .any(|s| s.get("Sid").and_then(Value::as_str) == Some(sid)),
            one => one.get("Sid").and_then(Value::as_str) == Some(sid),
        })
}
/// 같은 구독인지 알아보는 짧은 지문: 이메일 같은 개인 엔드포인트를 기록에 남기지 않고도 확인 뒤의 구독을 찾는다
pub fn endpoint_digest(protocol: &str, endpoint: &str) -> String {
    let digest = Sha256::digest(format!("{protocol}|{endpoint}").as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}
fn masked_endpoint(protocol: &str, endpoint: &str) -> String {
    super::super::mask::endpoint(protocol, endpoint)
}

// ───────────────────────── 순수 검증·계산

pub fn endpoint_problem(protocol: &str, endpoint: &str) -> Option<&'static str> {
    if endpoint.is_empty() {
        return Some("엔드포인트를 입력하세요");
    }
    if endpoint.trim() != endpoint {
        return Some("엔드포인트 앞뒤에 공백이 있어요");
    }
    match protocol {
        "sqs" => (!arn_is(endpoint, "sqs")).then_some("SQS 큐 ARN을 입력하세요"),
        "lambda" => (!arn_is(endpoint, "lambda")
            || !endpoint
                .splitn(6, ':')
                .nth(5)
                .is_some_and(|r| r.starts_with("function:")))
        .then_some("Lambda 함수 ARN을 입력하세요"),
        "http" => (!endpoint.starts_with("http://") || endpoint.len() <= 7)
            .then_some("http://로 시작하는 주소를 입력하세요"),
        "https" => (!endpoint.starts_with("https://") || endpoint.len() <= 8)
            .then_some("https://로 시작하는 주소를 입력하세요"),
        "email" | "email-json" => (!endpoint.contains('@')
            || endpoint.chars().any(char::is_whitespace)
            || endpoint.starts_with('@')
            || endpoint.ends_with('@'))
        .then_some("이메일 주소를 입력하세요"),
        _ => Some("지원하지 않는 프로토콜이에요"),
    }
}

/// 필터 정책이 이 범위에서 올바른가. 문제는 한 줄로 이어 돌려준다
pub fn filter_check(raw: &str, scope: &str) -> Result<(), String> {
    let scope = match scope {
        "MessageAttributes" => Scope::MessageAttributes,
        "MessageBody" => Scope::MessageBody,
        _ => return Err("필터 범위는 MessageAttributes나 MessageBody여야 해요".into()),
    };
    let text = |e: &filter::PolicyError| match &e.path {
        Some(p) => format!("{p}: {}", e.message),
        None => e.message.clone(),
    };
    let policy = filter::parse_policy(raw).map_err(|e| text(&e))?;
    let errors = filter::validate(&policy, scope);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.iter().map(text).collect::<Vec<_>>().join(" · "))
    }
}

type Parts = (Vec<SnsCall>, Vec<SnsFieldChange>);

/// 필터 정책·범위를 `before` → `after`로. 범위를 본문으로 옮길 때는 범위를 먼저, 그 밖에는 정책을 먼저 보낸다(SNS가 정책을 범위에 맞춰 검사해서)
pub fn filter_parts(
    subscription_arn: &str,
    before: (Option<&str>, &str),
    after: (Option<&str>, &str),
) -> Result<Parts, String> {
    let (before_policy, before_scope) = before;
    let (after_policy, after_scope) = after;
    if !["MessageAttributes", "MessageBody"].contains(&after_scope) {
        return Err("필터 범위는 MessageAttributes나 MessageBody여야 해요".into());
    }
    let after_policy = match after_policy {
        Some(p) => {
            filter_check(p, after_scope)?;
            Some(compact(p)?)
        }
        None => None,
    };
    let policy_changed = !same_json(before_policy, after_policy.as_deref());
    let scope_changed = before_scope != after_scope;
    let policy_call = policy_changed.then(|| {
        call(
            "sns:SetSubscriptionAttributes",
            subscription_arn,
            json!({"FilterPolicy": after_policy.clone().unwrap_or_else(|| NO_POLICY.into())}),
        )
    });
    let scope_call = scope_changed.then(|| {
        call(
            "sns:SetSubscriptionAttributes",
            subscription_arn,
            json!({"FilterPolicyScope": after_scope}),
        )
    });
    let ordered = if after_scope == "MessageBody" {
        [scope_call, policy_call]
    } else {
        [policy_call, scope_call]
    };
    let mut fields = Vec::new();
    if policy_changed {
        fields.push(field(
            "filterPolicy",
            before_policy,
            after_policy.as_deref(),
            true,
        ));
    }
    if scope_changed {
        fields.push(field(
            "filterPolicyScope",
            Some(before_scope),
            Some(after_scope),
            false,
        ));
    }
    Ok((ordered.into_iter().flatten().collect(), fields))
}

pub fn raw_parts(
    subscription_arn: &str,
    protocol: &str,
    current: bool,
    enabled: bool,
) -> Result<Parts, String> {
    if !RAW_PROTOCOLS.contains(&protocol) {
        return Err("이 프로토콜의 구독은 원시 전달(raw)을 지원하지 않아요".into());
    }
    if current == enabled {
        return Ok((vec![], vec![]));
    }
    let text = |on: bool| if on { "true" } else { "false" };
    Ok((
        vec![call(
            "sns:SetSubscriptionAttributes",
            subscription_arn,
            json!({"RawMessageDelivery": text(enabled)}),
        )],
        vec![field(
            "rawMessageDelivery",
            Some(text(current)),
            Some(text(enabled)),
            false,
        )],
    ))
}

/// 배달 정책(`DeliveryPolicy`)을 `before` → `after`로. `api`는 구독이면 `sns:SetSubscriptionAttributes`, 주제면 `sns:SetTopicAttributes`
pub fn delivery_parts(
    api: &str,
    target: &str,
    before: Option<&str>,
    after: Option<&str>,
) -> Result<Parts, String> {
    let after = match after {
        Some(p) => {
            let value: Value =
                serde_json::from_str(p).map_err(|e| format!("JSON 문법 오류: {e}"))?;
            if !value.is_object() {
                return Err("배달 정책은 JSON 객체여야 해요".into());
            }
            Some(value.to_string())
        }
        None => None,
    };
    if same_json(before, after.as_deref()) {
        return Ok((vec![], vec![]));
    }
    Ok((
        vec![call(
            api,
            target,
            json!({"DeliveryPolicy": after.clone().unwrap_or_else(|| NO_POLICY.into())}),
        )],
        vec![field("deliveryPolicy", before, after.as_deref(), true)],
    ))
}

/// 주제 정책을 바꿀 때 새로 열리는 공개·다른 계정 허용 문장(문장 풀이 글). 비어 있으면 넓어지지 않는다
pub fn widened(before: Option<&str>, after: &str, account: &str) -> Vec<String> {
    let reach = |doc: &str| -> Vec<String> {
        policy::describe(doc, account)
            .unwrap_or_default()
            .into_iter()
            .filter(|s| {
                s.effect == "Allow" && matches!(s.scope, Reach::Public | Reach::CrossAccount)
            })
            .map(|s| s.sentence)
            .collect()
    };
    let old = before.map(reach).unwrap_or_default();
    reach(after)
        .into_iter()
        .filter(|s| !old.contains(s))
        .collect()
}

/// 주제 정책 저장: 문서를 확인하고 `Policy`를 바꾸는 호출 하나와 줄 차이를 만든다. 둘째는 넓어지는 허용 문장들
pub fn topic_policy_parts(
    topic_arn: &str,
    before: Option<&str>,
    after: &str,
    account: &str,
) -> Result<(Parts, Vec<String>), String> {
    let doc: Value =
        serde_json::from_str(after).map_err(|e| format!("정책이 올바른 JSON이 아니에요: {e}"))?;
    let statements = policy::describe(after, account)?;
    if statements.is_empty() {
        return Err("정책에 문장이 하나 이상 있어야 해요".into());
    }
    let compact = doc.to_string();
    if same_json(before, Some(&compact)) {
        return Ok(((vec![], vec![]), vec![]));
    }
    let wide = widened(before, &compact, account);
    Ok((
        (
            vec![call(
                "sns:SetTopicAttributes",
                topic_arn,
                json!({"Policy": compact}),
            )],
            vec![field("topicPolicy", before, Some(&compact), true)],
        ),
        wide,
    ))
}

pub fn logging_attribute(protocol: &str, kind: &str) -> String {
    format!("{protocol}{kind}")
}

/// 배달 상태 로깅: 프로토콜 하나의 성공·실패 역할과 성공 로그 표본 비율(0~100)을 원하는 값으로. 바뀌는 속성만 호출한다. 셋째는 경고
pub fn logging_parts(
    topic_arn: &str,
    protocol: &str,
    attrs: &HashMap<String, String>,
    success: Option<&str>,
    failure: Option<&str>,
    rate: u32,
) -> Result<(Parts, Vec<String>), String> {
    if !LOG_PROTOCOLS.contains(&protocol) {
        return Err("지원하지 않는 프로토콜이에요".into());
    }
    if rate > 100 {
        return Err("표본 비율은 0~100이어야 해요".into());
    }
    let current = |name: &str| {
        attrs
            .get(name)
            .filter(|s| !s.is_empty())
            .map(String::as_str)
    };
    let (success_name, failure_name, rate_name) = (
        logging_attribute(protocol, "SuccessFeedbackRoleArn"),
        logging_attribute(protocol, "FailureFeedbackRoleArn"),
        logging_attribute(protocol, "SuccessFeedbackSampleRate"),
    );
    let current_rate = current(&rate_name)
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    let (mut calls, mut fields, mut warnings) = (Vec::new(), Vec::new(), Vec::new());
    for (name, before, after) in [
        (&success_name, current(&success_name), success),
        (&failure_name, current(&failure_name), failure),
    ] {
        if before != after {
            fields.push(field(name, before, after, false));
            calls.push(call(
                "sns:SetTopicAttributes",
                topic_arn,
                json!({ (name.as_str()): after.unwrap_or("") }),
            ));
        }
    }
    if current_rate != rate {
        fields.push(field(
            &rate_name,
            Some(&current_rate.to_string()),
            Some(&rate.to_string()),
            false,
        ));
        calls.push(call(
            "sns:SetTopicAttributes",
            topic_arn,
            json!({ (rate_name.as_str()): rate.to_string() }),
        ));
    }
    if success.is_none() && rate > 0 {
        warnings.push("성공 로그 역할이 없어서 표본 비율이 있어도 성공 로그는 남지 않아요".into());
    }
    if success.is_some() && rate == 0 {
        warnings.push(
            "표본 비율이 0%라서 성공 로그는 남지 않아요(실패 로그는 역할만 있으면 남아요)".into(),
        );
    }
    Ok(((calls, fields), warnings))
}

/// 로깅 되돌리기: 기록이 바꾼 속성마다 이전 값으로(역할은 지움, 비율은 0)
pub fn restore_topic_attributes(
    record: &SnsChangeRecord,
    topic_arn: &str,
    attrs: &HashMap<String, String>,
) -> Parts {
    let (mut calls, mut fields) = (Vec::new(), Vec::new());
    for recorded in record
        .calls
        .iter()
        .filter(|c| c.api == "sns:SetTopicAttributes")
    {
        let Some(name) = recorded.body.as_object().and_then(|m| m.keys().next()) else {
            continue;
        };
        let rate = name.ends_with("SampleRate");
        let before = prior_opt(record, name).flatten();
        let now = attrs
            .get(name)
            .filter(|s| !s.is_empty())
            .map(String::as_str);
        let want = before.as_deref().or(if rate { Some("0") } else { None });
        if now == want || (rate && now.is_none() && want == Some("0")) {
            continue;
        }
        fields.push(field(name, now, want, false));
        calls.push(call(
            "sns:SetTopicAttributes",
            topic_arn,
            json!({ (name.as_str()): want.unwrap_or("") }),
        ));
    }
    (calls, fields)
}

fn attribute_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.contains("..")
        && !name.starts_with("AWS.")
        && !name.starts_with("Amazon.")
}

/// 시험 발행: 입력을 검증하고 `Publish` 호출과 기록에 남길 메타데이터(크기, 속성 이름, 본문 SHA-256)를 만든다
pub fn publish_parts(
    topic_arn: &str,
    fifo: bool,
    content_dedup: bool,
    input: &PublishInput,
) -> Result<Parts, String> {
    let message = input.message;
    if message.is_empty() {
        return Err("메시지를 입력하세요".into());
    }
    if message.len() > MAX_MESSAGE_BYTES {
        return Err("메시지는 256KB(262,144바이트)까지예요".into());
    }
    let subject = input.subject.map(str::trim).filter(|s| !s.is_empty());
    if let Some(s) = subject {
        if s.chars().count() > 100 || !s.chars().all(|c| (' '..='~').contains(&c)) {
            return Err("제목은 100자 이하의 영문·숫자·기호여야 해요".into());
        }
    }
    if input.json_structure {
        let value: Value = serde_json::from_str(message)
            .map_err(|e| format!("MessageStructure=json 메시지는 JSON이어야 해요: {e}"))?;
        if value.get("default").and_then(Value::as_str).is_none() {
            return Err(
                "MessageStructure=json 메시지에는 문자열 `default` 키가 있어야 해요".into(),
            );
        }
    }
    if input.attributes.len() > 10 {
        return Err("메시지 속성은 10개까지예요".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut attrs = serde_json::Map::new();
    for a in input.attributes {
        if !attribute_name_ok(&a.name) {
            return Err(format!("속성 이름이 올바르지 않아요: {}", a.name));
        }
        if !seen.insert(a.name.as_str()) {
            return Err(format!("속성 이름이 겹쳐요: {}", a.name));
        }
        if a.value.is_empty() {
            return Err(format!("속성 값이 비었어요: {}", a.name));
        }
        match a.data_type.as_str() {
            "String" => {}
            "Number" => {
                if !a.value.parse::<f64>().is_ok_and(f64::is_finite) {
                    return Err(format!("숫자 속성 값이 올바르지 않아요: {}", a.name));
                }
            }
            "String.Array" => {
                if !serde_json::from_str::<Value>(&a.value).is_ok_and(|v| v.is_array()) {
                    return Err(format!(
                        "String.Array 속성 값은 JSON 배열이어야 해요: {}",
                        a.name
                    ));
                }
            }
            _ => return Err(format!("지원하지 않는 속성 타입이에요: {}", a.data_type)),
        }
        attrs.insert(
            a.name.clone(),
            json!({"DataType": a.data_type, "StringValue": a.value}),
        );
    }
    let group = input.group_id.map(str::trim).filter(|s| !s.is_empty());
    let dedup = input.dedup_id.map(str::trim).filter(|s| !s.is_empty());
    if fifo {
        if group.is_none() {
            return Err("FIFO 주제에는 메시지 그룹 ID가 필요해요".into());
        }
        if dedup.is_none() && !content_dedup {
            return Err(
                "이 FIFO 주제는 내용 기반 중복 제거가 꺼져 있어서 중복 제거 ID가 필요해요".into(),
            );
        }
    } else if group.is_some() || dedup.is_some() {
        return Err("메시지 그룹 ID와 중복 제거 ID는 FIFO 주제에만 쓸 수 있어요".into());
    }
    let mut body = serde_json::Map::new();
    body.insert("Message".into(), json!(message));
    if let Some(s) = subject {
        body.insert("Subject".into(), json!(s));
    }
    if input.json_structure {
        body.insert("MessageStructure".into(), json!("json"));
    }
    if !attrs.is_empty() {
        body.insert("MessageAttributes".into(), Value::Object(attrs));
    }
    if let Some(g) = group {
        body.insert("MessageGroupId".into(), json!(g));
    }
    if let Some(d) = dedup {
        body.insert("MessageDeduplicationId".into(), json!(d));
    }
    let names: Vec<&str> = input.attributes.iter().map(|a| a.name.as_str()).collect();
    let after = json!({"size": message.len(), "attributeNames": names, "bodySha256": format!("{:x}", Sha256::digest(message.as_bytes()))});
    Ok((
        vec![call("sns:Publish", topic_arn, Value::Object(body))],
        vec![SnsFieldChange {
            field: "publish".into(),
            before: Value::Null,
            after,
            diff: None,
        }],
    ))
}

/// `publish_parts`에 넘기는 입력(요청을 빌려 쓴다)
pub struct PublishInput<'a> {
    pub message: &'a str,
    pub subject: Option<&'a str>,
    pub json_structure: bool,
    pub attributes: &'a [PublishAttribute],
    pub group_id: Option<&'a str>,
    pub dedup_id: Option<&'a str>,
}

fn subscribe_attributes(
    filter: Option<&str>,
    scope: &str,
    raw: bool,
    dlq: Option<&str>,
) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    if let Some(f) = filter {
        map.insert("FilterPolicy".into(), f.into());
        if scope == "MessageBody" {
            map.insert("FilterPolicyScope".into(), scope.into());
        }
    }
    if raw {
        map.insert("RawMessageDelivery".into(), "true".into());
    }
    if let Some(d) = dlq {
        map.insert(
            "RedrivePolicy".into(),
            json!({"deadLetterTargetArn": d}).to_string(),
        );
    }
    map
}

/// 해지할 구독에서 다시 구독할 때 되살릴 속성
pub fn saved_attributes(attrs: &HashMap<String, String>) -> BTreeMap<String, String> {
    SAVED
        .iter()
        .filter_map(|k| {
            attrs
                .get(*k)
                .filter(|v| !v.is_empty())
                .map(|v| (k.to_string(), v.clone()))
        })
        .filter(|(k, v)| !(k == "RawMessageDelivery" && v == "false"))
        .collect()
}

fn subscribe_call(
    topic_arn: &str,
    protocol: &str,
    endpoint: &str,
    attributes: &BTreeMap<String, String>,
) -> SnsCall {
    let mut body = json!({"Protocol": protocol, "Endpoint": endpoint});
    if !attributes.is_empty() {
        body["Attributes"] = json!(attributes);
    }
    call("sns:Subscribe", topic_arn, body)
}

fn pending_notice(protocol: &str) -> Option<&'static str> {
    match protocol {
        "email" | "email-json" => Some("확인 대기 상태로 남아요. 받는 사람이 메일의 확인 링크를 눌러야 메시지를 받아요(확인하지 않으면 3일 뒤 지워져요). 되돌리기는 확인된 뒤에만 할 수 있어요"),
        "http" | "https" => Some("확인 대기 상태로 남아요. 엔드포인트가 SNS가 보내는 확인 요청의 SubscribeURL을 열어야 메시지를 받아요(확인하지 않으면 3일 뒤 지워져요). 되돌리기는 확인된 뒤에만 할 수 있어요"),
        _ => None,
    }
}

// ───────────────────────── 읽기를 섞은 계획

fn queue_field_policy(
    b: &mut Built,
    name: &str,
    q: &Queue,
    topic: &str,
    arn: &str,
    account: &str,
) -> Result<(), AppError> {
    b.state.push(json!({ (name): q.policy }));
    if allowed(q.policy.as_deref(), topic, arn, account) {
        return Ok(());
    }
    let after = policy::add_statement(
        q.policy.as_deref(),
        arn,
        queue_statement(topic, arn, &q.url),
    )
    .map_err(AppError::other)?;
    b.fields
        .push(field(name, q.policy.as_deref(), Some(&after), true));
    b.calls.push(call(
        "sqs:SetQueueAttributes",
        &q.url,
        json!({"Policy": after}),
    ));
    Ok(())
}

async fn load_sub(
    cfg: &SdkConfig,
    account: &str,
    region: &str,
    arn: &str,
) -> Result<(SnsTopic, SnsSubscription), AppError> {
    checked_arn(arn, "sns", account, region)?;
    let topic = arn
        .rsplit_once(':')
        .map(|(t, _)| t)
        .ok_or_else(|| AppError::other("구독 ARN이 올바르지 않아요"))?;
    checked_arn(topic, "sns", account, region)?;
    let snapshot = fetch::topic(cfg, topic, account, region).await?;
    let sub = snapshot
        .subscriptions
        .iter()
        .find(|s| s.arn.as_deref() == Some(arn))
        .cloned()
        .ok_or_else(|| AppError::other("구독을 찾을 수 없어요"))?;
    if sub.error.is_some() {
        return Err(AppError::other("구독 속성을 읽지 못해서 바꿀 수 없어요"));
    }
    Ok((snapshot, sub))
}

async fn topic_attributes(
    cfg: &SdkConfig,
    account: &str,
    region: &str,
    arn: &str,
) -> Result<HashMap<String, String>, AppError> {
    checked_arn(arn, "sns", account, region)?;
    let out = aws_sdk_sns::Client::new(cfg)
        .get_topic_attributes()
        .topic_arn(arn)
        .send()
        .await
        .map_err(|e| from_sdk(e, "sns:GetTopicAttributes"))?;
    Ok(out.attributes().cloned().unwrap_or_default())
}

async fn subscribe(
    cfg: &SdkConfig,
    account: &str,
    region: &str,
    request: &SnsChangeRequest,
) -> Result<Built, AppError> {
    let SnsChangeRequest::Subscribe {
        topic_arn,
        protocol,
        endpoint,
        filter_policy,
        filter_policy_scope,
        raw_message_delivery,
        dlq_arn,
    } = request
    else {
        unreachable!()
    };
    checked_arn(topic_arn, "sns", account, region)?;
    if !PROTOCOLS.contains(&protocol.as_str()) {
        return Err(AppError::other("지원하지 않는 프로토콜이에요"));
    }
    if let Some(problem) = endpoint_problem(protocol, endpoint) {
        return Err(AppError::other(problem));
    }
    let scope = filter_policy_scope
        .as_deref()
        .unwrap_or("MessageAttributes");
    let filter = match blank(filter_policy) {
        Some(raw) => {
            filter_check(raw, scope).map_err(AppError::other)?;
            Some(compact(raw).map_err(AppError::other)?)
        }
        None => None,
    };
    if *raw_message_delivery && !RAW_PROTOCOLS.contains(&protocol.as_str()) {
        return Err(AppError::other(
            "이 프로토콜의 구독은 원시 전달(raw)을 지원하지 않아요",
        ));
    }
    let dlq = blank(dlq_arn);
    if dlq.is_some() && !matches!(protocol.as_str(), "sqs" | "lambda" | "http" | "https") {
        return Err(AppError::other(
            "이 프로토콜의 구독에는 DLQ를 붙일 수 없어요",
        ));
    }
    let snapshot = fetch::topic(cfg, topic_arn, account, region).await?;
    if snapshot
        .subscriptions
        .iter()
        .any(|s| s.protocol == *protocol && s.endpoint == *endpoint)
    {
        return Err(AppError::other(
            "이 주제에 같은 엔드포인트의 구독이 이미 있어요",
        ));
    }
    let mut b = Built::new(topic_arn);
    b.state
        .push(json!({"fifo": snapshot.fifo, "existing": false}));
    let local = is_local(endpoint, account, region);
    match protocol.as_str() {
        "sqs" if local => {
            let q = queue(cfg, endpoint, account, region).await?;
            if q.fifo && !snapshot.fifo { return Err(AppError::other("표준 주제에는 FIFO 큐를 구독시킬 수 없어요")); }
            queue_field_policy(&mut b, "queuePolicy", &q, topic_arn, endpoint, account)?;
        }
        "sqs" => b.warnings.push("다른 계정이나 리전의 큐예요. 이 앱은 그쪽 큐를 건드리지 않고 구독 요청만 보내요. 큐 소유자가 이 주제의 배달을 허용해야 메시지가 도착해요".into()),
        "lambda" if local => {
            let exists = aws_sdk_lambda::Client::new(cfg).get_function_configuration().function_name(endpoint).send().await;
            if let Err(e) = exists { return Err(from_sdk(e, "lambda:GetFunctionConfiguration")); }
            let before = lambda_policy(cfg, endpoint).await?;
            b.state.push(json!({"lambda": before}));
            let statement_id = sid(topic_arn);
            if !before.as_deref().is_some_and(|p| has_sid(p, &statement_id)) {
                let statement = json!({"Sid": statement_id, "Effect":"Allow", "Principal":{"Service":"sns.amazonaws.com"}, "Action":"lambda:InvokeFunction", "Resource":endpoint, "Condition":{"ArnLike":{"AWS:SourceArn":topic_arn}}});
                let after = policy::add_statement(before.as_deref(), endpoint, statement).map_err(AppError::other)?;
                b.fields.push(field("lambdaPolicy", before.as_deref(), Some(&after), true));
                b.calls.push(call("lambda:AddPermission", endpoint, json!({"StatementId":statement_id,"Action":"lambda:InvokeFunction","Principal":"sns.amazonaws.com","SourceArn":topic_arn})));
            }
        }
        "lambda" => b.warnings.push("다른 계정이나 리전의 함수예요. 이 앱은 그쪽 함수를 건드리지 않고 구독 요청만 보내요. 함수 소유자가 이 주제의 호출을 허용해야 메시지가 도착해요".into()),
        _ => {}
    }
    if let Some(dlq) = dlq {
        checked_arn(dlq, "sqs", account, region)?;
        if dlq == endpoint.as_str() {
            return Err(AppError::other("DLQ는 구독 엔드포인트와 다른 큐여야 해요"));
        }
        let q = queue(cfg, dlq, account, region).await?;
        if snapshot.fifo && !q.fifo {
            return Err(AppError::other("FIFO 주제의 DLQ는 FIFO 큐여야 해요"));
        }
        queue_field_policy(&mut b, "dlqPolicy", &q, topic_arn, dlq, account)?;
    }
    let attributes = subscribe_attributes(filter.as_deref(), scope, *raw_message_delivery, dlq);
    b.calls
        .push(subscribe_call(topic_arn, protocol, endpoint, &attributes));
    b.fields.push(SnsFieldChange { field: "subscription".into(), before: Value::Null, after: json!({"protocol": protocol, "endpoint": masked_endpoint(protocol, endpoint), "attributes": attributes}), diff: None });
    if let Some(n) = pending_notice(protocol) {
        b.warnings.push(n.into());
    }
    if protocol == "http" {
        b.warnings
            .push("http://는 암호화되지 않아요. 가능하면 https://를 쓰세요".into());
    }
    b.warnings
        .push("새 구독의 진단 결과는 만든 뒤 배달 진단에서 확인하세요".into());
    b.snapshot = Some(snapshot);
    Ok(b)
}

/// 구독 만들기 되돌리기가 구독에 할 일
pub enum SubscriptionUndo<'a> {
    /// 기록한 ARN의 구독이 아직 있다: 해지한다
    Unsubscribe(&'a SnsSubscription),
    /// 이 변경이 만든 구독이 아직 확인 대기 중이다(ARN이 목록에 없다). 확인된 뒤에 되돌린다
    Pending,
    /// 구독을 만들지 못했거나 이미 없다: 남은 정리만 한다
    Gone,
}

/// 해지할 구독은 기록한 ARN으로만 찾는다. 같은 프로토콜·엔드포인트의 다른 구독(해지된 뒤 새로 만든 것)은 이 변경이 만든 것이 아니라서 건드리지 않는다.
/// 엔드포인트 지문은 확인 대기 중인 구독을 알아보는 데만 쓴다
pub fn subscription_to_undo<'a>(
    record: &SnsChangeRecord,
    subscriptions: &'a [SnsSubscription],
) -> SubscriptionUndo<'a> {
    if !record.calls.iter().any(|c| c.api == "sns:Subscribe") {
        return SubscriptionUndo::Gone;
    }
    let recorded = record
        .after
        .get("subscriptionArn")
        .and_then(Value::as_str)
        .filter(|a| a.starts_with("arn:"));
    if let Some(sub) =
        recorded.and_then(|arn| subscriptions.iter().find(|s| s.arn.as_deref() == Some(arn)))
    {
        return SubscriptionUndo::Unsubscribe(sub);
    }
    let digest = record.after.get("endpointDigest").and_then(Value::as_str);
    if digest.is_some()
        && subscriptions.iter().any(|s| {
            s.arn.is_none() && Some(endpoint_digest(&s.protocol, &s.endpoint).as_str()) == digest
        })
    {
        return SubscriptionUndo::Pending;
    }
    SubscriptionUndo::Gone
}

/// 구독 만들기 되돌리기: 이 변경이 만든 구독 해지(기록한 ARN이 아직 있을 때만) + 성공한 호출이 더한 큐 정책 문장·Lambda 권한 빼기.
/// 구독이 안 만들어졌거나 이미 없어도 성공한 쓰기 호출의 정리는 따로 계산한다. 다른 구독이 쓰는 큐의 문장은 남긴다
async fn undo_subscribe(
    cfg: &SdkConfig,
    account: &str,
    region: &str,
    record: &SnsChangeRecord,
) -> Result<Built, AppError> {
    let SnsChangeRecord {
        request:
            SnsChangeRequest::Subscribe {
                topic_arn,
                endpoint,
                dlq_arn,
                ..
            },
        ..
    } = record
    else {
        unreachable!()
    };
    let snapshot = fetch::topic(cfg, topic_arn, account, region).await?;
    let sub = match subscription_to_undo(record, &snapshot.subscriptions) {
        SubscriptionUndo::Pending => {
            return Err(AppError::other(
                "확인 대기 중인 구독은 확인된 뒤에 되돌릴 수 있어요",
            ))
        }
        SubscriptionUndo::Unsubscribe(sub) => Some(sub.clone()),
        SubscriptionUndo::Gone => None,
    };
    let mut b = Built::new(topic_arn);
    match &sub {
        Some(sub) => {
            let arn = sub.arn.clone().unwrap_or_default();
            b.state
                .push(json!({"subscription": arn, "attributes": sub.attributes}));
            b.calls.push(call("sns:Unsubscribe", &arn, json!({})));
            b.fields.push(SnsFieldChange { field: "subscription".into(), before: json!({"protocol": sub.protocol, "endpoint": masked_endpoint(&sub.protocol, &sub.endpoint), "attributes": saved_attributes(&sub.attributes)}), after: Value::Null, diff: None });
        }
        None => {
            b.state.push(json!({"subscription": null}));
            if record.calls.iter().any(|c| c.api == "sns:Subscribe") {
                b.warnings.push(
                    "이 변경이 만든 구독이 이미 없어서 해지는 건너뛰고 남은 정리만 해요".into(),
                );
            }
        }
    }
    let skip = sub.as_ref().map(|s| s.key.as_str());
    let others = |queue: &str| {
        snapshot.subscriptions.iter().any(|s| {
            Some(s.key.as_str()) != skip
                && (s.dlq_arn.as_deref() == Some(queue) || s.endpoint == queue)
        })
    };
    let sid = sid(topic_arn);
    for (name, queue_arn) in [
        ("queuePolicy", Some(endpoint.as_str())),
        ("dlqPolicy", dlq_arn.as_deref()),
    ] {
        let Some(queue_arn) = queue_arn else { continue };
        if !record
            .calls
            .iter()
            .any(|c| c.api == "sqs:SetQueueAttributes")
            || !arn_is(queue_arn, "sqs")
            || !is_local(queue_arn, account, region)
        {
            continue;
        }
        let q = queue(cfg, queue_arn, account, region).await?;
        // 이 큐에 실제로 쓴 호출이 있을 때만 정리한다
        if !record
            .calls
            .iter()
            .any(|c| c.api == "sqs:SetQueueAttributes" && c.target == q.url)
        {
            continue;
        }
        if others(queue_arn) {
            b.warnings.push(format!(
                "다른 구독이 같은 큐({queue_arn})를 쓰고 있어서 큐 정책 문장은 그대로 둬요"
            ));
            continue;
        }
        b.state.push(json!({ (name): q.policy }));
        let Some(current) = q.policy.as_deref().filter(|p| has_sid(p, &sid)) else {
            continue;
        };
        let after = undo_statement(
            Some(current),
            queue_arn,
            &sid,
            record.before.get(name).and_then(Value::as_str),
        )?;
        b.fields
            .push(field(name, Some(current), after.as_deref(), true));
        b.calls.push(call(
            "sqs:SetQueueAttributes",
            &q.url,
            json!({"Policy": after.unwrap_or_default()}),
        ));
    }
    if record.calls.iter().any(|c| c.api == "lambda:AddPermission") {
        let before = lambda_policy(cfg, endpoint).await?;
        b.state.push(json!({"lambda": before}));
        if let Some(current) = before.as_deref().filter(|p| has_sid(p, &sid)) {
            let after = policy::remove_statement(current, &sid).map_err(AppError::other)?;
            b.fields
                .push(field("lambdaPolicy", Some(current), after.as_deref(), true));
            b.calls.push(call(
                "lambda:RemovePermission",
                endpoint,
                json!({"StatementId": sid}),
            ));
        }
    }
    b.snapshot = Some(snapshot);
    Ok(b)
}

async fn unsubscribe(
    cfg: &SdkConfig,
    account: &str,
    region: &str,
    subscription_arn: &str,
) -> Result<Built, AppError> {
    let (snapshot, sub) = load_sub(cfg, account, region, subscription_arn).await?;
    let mut b = Built::new(&snapshot.arn);
    b.name_rule = true;
    let saved = saved_attributes(&sub.attributes);
    let reconfirm = PENDING_PROTOCOLS.contains(&sub.protocol.as_str());
    b.state.push(json!({"attributes": sub.attributes}));
    b.calls
        .push(call("sns:Unsubscribe", subscription_arn, json!({})));
    b.fields.push(SnsFieldChange { field: "subscription".into(), before: json!({"protocol": sub.protocol, "endpoint": masked_endpoint(&sub.protocol, &sub.endpoint), "attributes": saved, "reconfirm": reconfirm}), after: Value::Null, diff: None });
    b.warnings
        .push("해지하면 이 엔드포인트는 이 주제의 메시지를 더 받지 않아요".into());
    match sub.protocol.as_str() {
        "email" | "email-json" => b.warnings.push("이메일 주소는 변경 기록에 남기지 않아서 이 해지는 자동으로 되돌릴 수 없어요. 다시 받으려면 구독을 새로 만들고 확인 메일을 눌러야 해요".into()),
        "http" | "https" => b.warnings.push("되돌려도 새 구독은 확인 대기 상태로 시작해서 엔드포인트가 다시 확인해야 해요".into()),
        _ => b.warnings.push("되돌리면 저장한 속성으로 다시 구독해요(구독 ARN은 새로 만들어져요)".into()),
    }
    b.snapshot = Some(snapshot);
    Ok(b)
}

/// 해지 기록에서 다시 구독할 값(프로토콜, 엔드포인트, 속성)을 꺼낸다. 이메일은 주소를 기록하지 않아서 못 한다
pub fn resubscribe_parts(
    before: &Value,
    topic_arn: &str,
) -> Result<(Parts, String, String, Vec<String>), AppError> {
    let missing = || AppError::other("저장한 구독 정보가 없어요");
    let saved = before.get("subscription").ok_or_else(missing)?;
    let protocol = saved
        .get("protocol")
        .and_then(Value::as_str)
        .ok_or_else(missing)?;
    let endpoint = saved
        .get("endpoint")
        .and_then(Value::as_str)
        .ok_or_else(missing)?;
    if matches!(protocol, "email" | "email-json") {
        return Err(AppError::other("이메일 주소는 변경 기록에 남기지 않아서 자동으로 되돌릴 수 없어요. 구독을 새로 만드세요"));
    }
    if !matches!(protocol, "sqs" | "lambda" | "http" | "https")
        || endpoint_problem(protocol, endpoint).is_some()
    {
        return Err(AppError::other("저장한 구독 정보가 올바르지 않아요"));
    }
    let attributes: BTreeMap<String, String> = saved
        .get("attributes")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| {
                    v.as_str()
                        .filter(|_| SAVED.contains(&k.as_str()))
                        .map(|v| (k.clone(), v.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default();
    let field = SnsFieldChange {
        field: "subscription".into(),
        before: Value::Null,
        after: json!({"protocol": protocol, "endpoint": endpoint, "attributes": attributes}),
        diff: None,
    };
    let warnings = pending_notice(protocol)
        .map(|n| vec![n.to_owned()])
        .unwrap_or_default();
    Ok((
        (
            vec![subscribe_call(topic_arn, protocol, endpoint, &attributes)],
            vec![field],
        ),
        protocol.to_owned(),
        endpoint.to_owned(),
        warnings,
    ))
}

/// 해지 되돌리기: 저장한 속성으로 다시 구독(SQS·Lambda). http(s)는 다시 확인이 필요하다
async fn undo_unsubscribe(
    cfg: &SdkConfig,
    account: &str,
    region: &str,
    record: &SnsChangeRecord,
) -> Result<Built, AppError> {
    let (parts, protocol, endpoint, warnings) =
        resubscribe_parts(&record.before, &record.topic_arn)?;
    let snapshot = fetch::topic(cfg, &record.topic_arn, account, region).await?;
    if snapshot
        .subscriptions
        .iter()
        .any(|s| s.protocol == protocol && s.endpoint == endpoint)
    {
        return Err(AppError::other("같은 엔드포인트의 구독이 이미 있어요"));
    }
    let mut b = Built::new(&record.topic_arn);
    b.state.push(json!({"exists": false}));
    b.push(parts);
    b.warnings.extend(warnings);
    b.snapshot = Some(snapshot);
    Ok(b)
}

/// 주제 정책 되돌리기: 저장한 문서가 지금도 그대로일 때만 이전 문서를 돌려준다
pub fn policy_undo_target(
    record: &SnsChangeRecord,
    current: Option<&str>,
) -> Result<String, AppError> {
    let saved = record.after.get("topicPolicy").and_then(Value::as_str);
    if !same_json(current, saved) {
        return Err(AppError::other(
            "저장한 뒤 주제 정책이 바뀌어서 되돌릴 수 없어요",
        ));
    }
    prior_opt(record, "topicPolicy")
        .flatten()
        .ok_or_else(|| AppError::other("이전 정책이 기록에 없어서 되돌릴 수 없어요"))
}

async fn filter_policy(
    cfg: &SdkConfig,
    account: &str,
    region: &str,
    subscription_arn: &str,
    requested: Option<&Option<String>>,
    requested_scope: Option<&str>,
) -> Result<Built, AppError> {
    let (snapshot, sub) = load_sub(cfg, account, region, subscription_arn).await?;
    let mut b = Built::new(&snapshot.arn);
    b.name_rule = true;
    let before_policy = sub
        .attributes
        .get("FilterPolicy")
        .map(String::as_str)
        .filter(|s| !s.is_empty());
    let before_scope = sub
        .attributes
        .get("FilterPolicyScope")
        .map(String::as_str)
        .unwrap_or("MessageAttributes");
    let after_policy = match requested {
        Some(p) => blank(p),
        None => before_policy,
    };
    let after_scope = requested_scope.unwrap_or(before_scope);
    b.state
        .push(json!({"policy": before_policy, "scope": before_scope}));
    b.push(
        filter_parts(
            subscription_arn,
            (before_policy, before_scope),
            (after_policy, after_scope),
        )
        .map_err(AppError::other)?,
    );
    b.snapshot = Some(snapshot);
    Ok(b)
}

pub async fn build(
    cfg: &SdkConfig,
    account: &str,
    region: &str,
    request: &SnsChangeRequest,
    undo: Option<&SnsChangeRecord>,
) -> Result<Built, AppError> {
    match (request, undo) {
        (SnsChangeRequest::Subscribe { .. }, None) => {
            subscribe(cfg, account, region, request).await
        }
        (SnsChangeRequest::Subscribe { .. }, Some(record)) => {
            undo_subscribe(cfg, account, region, record).await
        }
        (SnsChangeRequest::Unsubscribe { subscription_arn }, None) => {
            unsubscribe(cfg, account, region, subscription_arn).await
        }
        (SnsChangeRequest::Unsubscribe { .. }, Some(record)) => {
            undo_unsubscribe(cfg, account, region, record).await
        }
        (
            SnsChangeRequest::FilterPolicy {
                subscription_arn,
                filter_policy: wanted,
                scope,
            },
            None,
        ) => {
            filter_policy(
                cfg,
                account,
                region,
                subscription_arn,
                Some(wanted),
                Some(scope.as_str()),
            )
            .await
        }
        (
            SnsChangeRequest::FilterPolicy {
                subscription_arn, ..
            },
            Some(record),
        ) => {
            let policy = prior_opt(record, "filterPolicy");
            let scope = prior_opt(record, "filterPolicyScope").flatten();
            filter_policy(
                cfg,
                account,
                region,
                subscription_arn,
                policy.as_ref(),
                scope.as_deref(),
            )
            .await
        }
        (
            SnsChangeRequest::RawDelivery {
                subscription_arn,
                enabled,
            },
            undo,
        ) => {
            let (snapshot, sub) = load_sub(cfg, account, region, subscription_arn).await?;
            let current = sub
                .attributes
                .get("RawMessageDelivery")
                .is_some_and(|v| v == "true");
            let enabled = match undo {
                Some(record) => prior_opt(record, "rawMessageDelivery")
                    .flatten()
                    .map(|v| v == "true")
                    .unwrap_or(current),
                None => *enabled,
            };
            let mut b = Built::new(&snapshot.arn);
            b.state.push(json!({"raw": current}));
            b.push(
                raw_parts(subscription_arn, &sub.protocol, current, enabled)
                    .map_err(AppError::other)?,
            );
            if enabled && !undo.is_some() {
                b.warnings.push("raw 전달을 켜면 SNS 봉투(Subject·Timestamp 등) 없이 메시지 본문만 전달돼요. 메시지 속성은 큐 메시지 속성으로 가요. 받는 쪽이 봉투를 읽고 있으면 깨져요".into());
            }
            b.snapshot = Some(snapshot);
            Ok(b)
        }
        (
            SnsChangeRequest::SubscriptionDeliveryPolicy {
                subscription_arn,
                delivery_policy,
            },
            undo,
        ) => {
            let (snapshot, sub) = load_sub(cfg, account, region, subscription_arn).await?;
            if !matches!(sub.protocol.as_str(), "http" | "https") {
                return Err(AppError::other("배달 정책은 HTTP(S) 구독에만 있어요"));
            }
            let before = sub
                .attributes
                .get("DeliveryPolicy")
                .map(String::as_str)
                .filter(|s| !s.is_empty());
            let after = match undo {
                Some(record) => {
                    prior_opt(record, "deliveryPolicy").unwrap_or_else(|| before.map(str::to_owned))
                }
                None => blank(delivery_policy).map(str::to_owned),
            };
            let mut b = Built::new(&snapshot.arn);
            b.state.push(json!({"delivery": before}));
            b.push(
                delivery_parts(
                    "sns:SetSubscriptionAttributes",
                    subscription_arn,
                    before,
                    after.as_deref(),
                )
                .map_err(AppError::other)?,
            );
            b.snapshot = Some(snapshot);
            Ok(b)
        }
        (
            SnsChangeRequest::TopicDeliveryPolicy {
                topic_arn,
                delivery_policy,
            },
            undo,
        ) => {
            let attrs = topic_attributes(cfg, account, region, topic_arn).await?;
            let before = attrs
                .get("DeliveryPolicy")
                .map(String::as_str)
                .filter(|s| !s.is_empty());
            let after = match undo {
                Some(record) => {
                    prior_opt(record, "deliveryPolicy").unwrap_or_else(|| before.map(str::to_owned))
                }
                None => blank(delivery_policy).map(str::to_owned),
            };
            let mut b = Built::new(topic_arn);
            b.state.push(json!({"delivery": before}));
            b.push(
                delivery_parts(
                    "sns:SetTopicAttributes",
                    topic_arn,
                    before,
                    after.as_deref(),
                )
                .map_err(AppError::other)?,
            );
            Ok(b)
        }
        (
            SnsChangeRequest::TopicPolicy {
                topic_arn,
                policy: document,
            },
            undo,
        ) => {
            let attrs = topic_attributes(cfg, account, region, topic_arn).await?;
            let before = attrs
                .get("Policy")
                .map(String::as_str)
                .filter(|s| !s.is_empty());
            let target = match undo {
                Some(record) => policy_undo_target(record, before)?,
                None => document.clone(),
            };
            let mut b = Built::new(topic_arn);
            b.name_rule = true;
            b.state.push(json!({"policy": before}));
            let (parts, wide) =
                topic_policy_parts(topic_arn, before, &target, account).map_err(AppError::other)?;
            b.push(parts);
            if !wide.is_empty() {
                b.widen = true;
                b.warnings.push(format!(
                    "정책이 넓어져요(공개 또는 다른 계정 허용): {}",
                    wide.join(" / ")
                ));
            }
            Ok(b)
        }
        (
            SnsChangeRequest::DeliveryLogging {
                topic_arn,
                protocol,
                success_role_arn,
                failure_role_arn,
                sample_rate,
            },
            undo,
        ) => {
            let attrs = topic_attributes(cfg, account, region, topic_arn).await?;
            let mut b = Built::new(topic_arn);
            b.state.push(json!({"attributes": attrs.iter().filter(|(k, _)| LOG_PROTOCOLS.iter().any(|p| k.starts_with(p))).collect::<BTreeMap<_, _>>()}));
            if let Some(record) = undo {
                b.push(restore_topic_attributes(record, topic_arn, &attrs));
                return Ok(b);
            }
            let (success, failure) = (blank(success_role_arn), blank(failure_role_arn));
            for role in [success, failure].into_iter().flatten() {
                if let Some(problem) = roles::role_problem(role, account) {
                    return Err(AppError::other(problem));
                }
                match roles::trusted(cfg, role).await? {
                    Some(true) => {}
                    Some(false) => {
                        return Err(AppError::other(format!(
                            "이 역할은 sns.amazonaws.com을 신뢰하지 않아요: {role}"
                        )))
                    }
                    None => b.warnings.push(format!(
                        "역할의 신뢰 정책을 읽을 권한이 없어서 확인하지 못했어요: {role}"
                    )),
                }
            }
            let (parts, warnings) =
                logging_parts(topic_arn, protocol, &attrs, success, failure, *sample_rate)
                    .map_err(AppError::other)?;
            b.push(parts);
            b.warnings.extend(warnings);
            b.warnings.push("역할에는 CloudWatch Logs 쓰기 권한이 있어야 해요. 이 앱은 역할을 만들거나 고치지 않아요".into());
            Ok(b)
        }
        (SnsChangeRequest::Publish { .. }, Some(_)) => {
            Err(AppError::other("발행한 메시지는 되돌릴 수 없어요"))
        }
        (
            SnsChangeRequest::Publish {
                topic_arn,
                message,
                subject,
                message_structure_json,
                attributes,
                message_group_id,
                deduplication_id,
            },
            None,
        ) => {
            let attrs = topic_attributes(cfg, account, region, topic_arn).await?;
            let fifo = attrs.get("FifoTopic").is_some_and(|v| v == "true");
            let content_dedup = attrs
                .get("ContentBasedDeduplication")
                .is_some_and(|v| v == "true");
            let mut b = Built::new(topic_arn);
            b.state
                .push(json!({"fifo": fifo, "contentDedup": content_dedup}));
            let input = PublishInput {
                message,
                subject: subject.as_deref(),
                json_structure: *message_structure_json,
                attributes,
                group_id: message_group_id.as_deref(),
                dedup_id: deduplication_id.as_deref(),
            };
            b.push(publish_parts(topic_arn, fifo, content_dedup, &input).map_err(AppError::other)?);
            let confirmed = attrs
                .get("SubscriptionsConfirmed")
                .map(String::as_str)
                .unwrap_or("0");
            b.warnings.push(format!("확인된 구독 {confirmed}개에 실제로 배달돼요(구독의 필터 정책이 거를 수 있어요). 발행한 메시지는 되돌릴 수 없어요"));
            Ok(b)
        }
        _ => Err(AppError::other("이 변경은 여기서 만들지 않아요")),
    }
}

/// 변경 뒤의 모습을 진단 입력에 반영한다(필터 정책 바꾸기, 해지)
pub fn project(projected: &mut SnsTopic, request: &SnsChangeRequest, fields: &[SnsFieldChange]) {
    match request {
        SnsChangeRequest::FilterPolicy {
            subscription_arn, ..
        } => {
            for sub in &mut projected.subscriptions {
                if sub.arn.as_deref() != Some(subscription_arn.as_str()) {
                    continue;
                }
                for f in fields {
                    let name = match f.field.as_str() {
                        "filterPolicy" => "FilterPolicy",
                        "filterPolicyScope" => "FilterPolicyScope",
                        _ => continue,
                    };
                    match f.after.as_str() {
                        Some(v) => {
                            sub.attributes.insert(name.into(), v.into());
                        }
                        None => {
                            sub.attributes.remove(name);
                        }
                    }
                    if name == "FilterPolicy" && f.after.is_null() {
                        sub.filter = None;
                    }
                }
            }
        }
        SnsChangeRequest::Unsubscribe { subscription_arn } => projected
            .subscriptions
            .retain(|s| s.arn.as_deref() != Some(subscription_arn.as_str())),
        _ => {}
    }
}

// ───────────────────────── 기록

/// 이 요청의 기록은 되돌릴 값을 담으므로 개인 정보가 없을 때만 일반 가림(`redact`)을 거치지 않는다. 개인 정보가 있으면 `record`가 값을 가려서 저장하고 되돌리기를 막는다
pub fn keeps_values(request: &SnsChangeRequest) -> bool {
    !matches!(
        request,
        SnsChangeRequest::QueuePolicy { .. }
            | SnsChangeRequest::LambdaPermission { .. }
            | SnsChangeRequest::AddDlq { .. }
            | SnsChangeRequest::Undo { .. }
    ) && is_mine(request)
}

/// 기록에 개인 정보가 있어서 되돌릴 값을 저장하지 않았을 때 변경 기록과 되돌리기 계획이 보여 주는 이유
pub const UNDO_BLOCKED_PII: &str = "개인정보가 들어 있어 되돌릴 값을 저장하지 않았어요";

/// 되돌리려면 기록한 전후 값이 필요한가. 구독 만들기는 기록한 구독 ARN과 호출만, 발행과 되돌리기는 되돌릴 수 없다
fn undo_needs_values(request: &SnsChangeRequest) -> bool {
    !matches!(
        request,
        SnsChangeRequest::Subscribe { .. }
            | SnsChangeRequest::Publish { .. }
            | SnsChangeRequest::Undo { .. }
    )
}
fn is_mine(request: &SnsChangeRequest) -> bool {
    matches!(
        request,
        SnsChangeRequest::Subscribe { .. }
            | SnsChangeRequest::Unsubscribe { .. }
            | SnsChangeRequest::FilterPolicy { .. }
            | SnsChangeRequest::RawDelivery { .. }
            | SnsChangeRequest::SubscriptionDeliveryPolicy { .. }
            | SnsChangeRequest::TopicDeliveryPolicy { .. }
            | SnsChangeRequest::TopicPolicy { .. }
            | SnsChangeRequest::DeliveryLogging { .. }
            | SnsChangeRequest::Publish { .. }
    )
}

/// 주제 이름 입력을 요구하는가: 이 모듈의 변경은 이름에 prod가 있는 구독 해지·필터 변경·주제 정책 저장(`name_rule`)과 정책을 넓히는 변경(`widen`)만.
/// 그 밖의 요청(진단 고치기 등)은 이름에 prod가 있으면 늘 요구한다
pub fn needs_name(
    topic_name: &str,
    request: &SnsChangeRequest,
    name_rule: bool,
    widen: bool,
) -> bool {
    let prod = topic_name.to_ascii_lowercase().contains("prod");
    widen || (prod && (name_rule || !handles(request)))
}

pub fn handles(request: &SnsChangeRequest) -> bool {
    is_mine(request)
}

fn attribute_of(field: &str) -> String {
    if field == "topicPolicy" {
        return "Policy".into();
    }
    let mut chars = field.chars();
    chars
        .next()
        .map(|c| c.to_ascii_uppercase().to_string() + chars.as_str())
        .unwrap_or_default()
}

/// 이 필드의 호출이 실제로 실행됐는가(기록의 전후 값에 넣을지 정한다)
pub fn applied(field: &SnsFieldChange, ran: &[SnsCall]) -> bool {
    match field.field.as_str() {
        "subscription" => ran
            .iter()
            .any(|c| c.api == "sns:Subscribe" || c.api == "sns:Unsubscribe"),
        "publish" => ran.iter().any(|c| c.api == "sns:Publish"),
        "dlqPolicy" => {
            let want = field.after.as_str().unwrap_or("");
            ran.iter().any(|c| {
                c.api == "sqs:SetQueueAttributes"
                    && c.body.get("Policy").and_then(Value::as_str) == Some(want)
            })
        }
        other => {
            let attr = attribute_of(other);
            ran.iter().any(|c| {
                matches!(
                    c.api.as_str(),
                    "sns:SetSubscriptionAttributes" | "sns:SetTopicAttributes"
                ) && c.body.get(&attr).is_some()
            })
        }
    }
}

/// 호출 결과에서 기록에 더할 값: 만든 구독의 ARN과 엔드포인트 지문, 발행한 MessageId
pub fn record_extra(
    request: &SnsChangeRequest,
    ran: &[SnsCall],
    outputs: &[Value],
    after: &mut serde_json::Map<String, Value>,
) {
    match request {
        SnsChangeRequest::Subscribe {
            protocol, endpoint, ..
        } => {
            if let Some(arn) = ran
                .iter()
                .zip(outputs)
                .find(|(c, _)| c.api == "sns:Subscribe")
                .and_then(|(_, o)| o.get("subscriptionArn").and_then(Value::as_str))
            {
                after.insert("subscriptionArn".into(), json!(arn));
                after.insert(
                    "endpointDigest".into(),
                    json!(endpoint_digest(protocol, endpoint)),
                );
            }
        }
        SnsChangeRequest::Publish { .. } => {
            if let Some(id) = ran
                .iter()
                .zip(outputs)
                .find(|(c, _)| c.api == "sns:Publish")
                .and_then(|(_, o)| o.get("messageId").and_then(Value::as_str))
            {
                after.insert("messageId".into(), json!(id));
            }
        }
        _ => {}
    }
}

const MASKED: &str = "[가림]";

/// 기록에 남기기 전에 메시지 내용을 지운다: 발행 호출은 크기·속성 이름·SHA-256만, 요청의 본문·제목·속성 값은 가린다
pub fn sanitize(record: &mut SnsChangeRecord) {
    let SnsChangeRequest::Publish {
        message,
        subject,
        attributes,
        ..
    } = &mut record.request
    else {
        return;
    };
    for c in record.calls.iter_mut().filter(|c| c.api == "sns:Publish") {
        let text = c.body.get("Message").and_then(Value::as_str).unwrap_or("");
        let mut kept = serde_json::Map::new();
        kept.insert("MessageSize".into(), json!(text.len()));
        kept.insert(
            "MessageSha256".into(),
            json!(format!("{:x}", Sha256::digest(text.as_bytes()))),
        );
        kept.insert(
            "AttributeNames".into(),
            json!(c
                .body
                .get("MessageAttributes")
                .and_then(Value::as_object)
                .map(|m| m.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()),
        );
        for key in [
            "MessageStructure",
            "MessageGroupId",
            "MessageDeduplicationId",
        ] {
            if let Some(v) = c.body.get(key) {
                kept.insert(key.into(), v.clone());
            }
        }
        c.body = Value::Object(kept);
    }
    *message = MASKED.into();
    if subject.is_some() {
        *subject = Some(MASKED.into());
    }
    for a in attributes {
        a.value = MASKED.into();
    }
}

/// 적용 결과로 `sns-changes.jsonl`에 쓸 한 줄. 실행한 호출의 필드만 전후 값에 넣고, 메시지 내용과 개인 정보는 쓰기 전에 지운다.
/// 되돌릴 값(정책·속성)에 이메일·전화번호가 들어 있으면 그 값은 가려서 저장하고 `undoBlocked`로 되돌리기를 막는다. 개인 정보가 없는 값은 그대로 두어 되돌릴 수 있다.
pub fn record(
    id: &str,
    at: &str,
    profile: &str,
    region: &str,
    fresh: &SnsPlan,
    ran: &[SnsCall],
    outputs: &[Value],
) -> Result<Value, AppError> {
    let applied_field = |f: &&SnsFieldChange| match f.field.as_str() {
        "queuePolicy" => ran.iter().any(|c| c.api == "sqs:SetQueueAttributes"),
        "lambdaPolicy" => ran
            .iter()
            .any(|c| c.api == "lambda:AddPermission" || c.api == "lambda:RemovePermission"),
        "redrivePolicy" => ran.iter().any(|c| {
            c.api == "sns:SetSubscriptionAttributes" && c.body.get("RedrivePolicy").is_some()
        }),
        _ => applied(f, ran),
    };
    let before = fresh
        .fields
        .iter()
        .filter(applied_field)
        .map(|f| (f.field.clone(), f.before.clone()))
        .collect::<serde_json::Map<_, _>>();
    let mut after = fresh
        .fields
        .iter()
        .filter(applied_field)
        .map(|f| (f.field.clone(), f.after.clone()))
        .collect::<serde_json::Map<_, _>>();
    record_extra(&fresh.request, ran, outputs, &mut after);
    let (before, after): (Value, Value) = (before.into(), after.into());
    let pii = contains_pii(&before) || contains_pii(&after);
    let undo_blocked =
        (pii && undo_needs_values(&fresh.request)).then(|| UNDO_BLOCKED_PII.to_owned());
    let mut record = SnsChangeRecord {
        id: id.into(),
        at: at.into(),
        profile: profile.into(),
        region: region.into(),
        topic_arn: fresh.topic_arn.clone(),
        request: fresh.request.clone(),
        calls: ran.to_vec(),
        before,
        after,
        undo_of: fresh.undo_of.clone(),
        undone: false,
        undo_blocked,
    };
    sanitize(&mut record);
    let mut safe = serde_json::to_value(&record).map_err(|e| AppError::other(e.to_string()))?;
    for key in ["calls", "request"] {
        if let Some(value) = safe.get_mut(key) {
            redact(value);
        }
    }
    if pii || !keeps_values(&record.request) {
        for key in ["before", "after"] {
            if let Some(value) = safe.get_mut(key) {
                redact(value);
            }
        }
    }
    Ok(safe)
}

#[cfg(test)]
mod tests;
