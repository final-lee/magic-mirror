//! 변경 미리보기, 적용 직전 재확인, 기록과 되돌리기.
use std::path::Path;
use aws_config::SdkConfig;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::error::{AppError, from_sdk};
use super::{fix::{self, SnsFix}, policy::{self, Ctx, Verdict, Who}};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SnsChangeRequest {
    QueuePolicy { topic_arn: String, queue_url: String, queue_arn: String },
    LambdaPermission { topic_arn: String, function_arn: String },
    AddDlq { subscription_arn: String, dlq_arn: String },
    Undo { id: String },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsCall { pub api: String, pub target: String, pub body: Value }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsFieldChange { pub field: String, pub before: Value, pub after: Value, pub diff: Option<String> }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsImpact { pub subscription: String, pub check: String, pub before: String, pub after: String }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsPlan { pub request: SnsChangeRequest, pub topic_arn: String, pub calls: Vec<SnsCall>, pub fields: Vec<SnsFieldChange>, pub impact: Vec<SnsImpact>, pub warnings: Vec<String>, pub confirm: Option<String>, pub fingerprint: String, pub undo_of: Option<String> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsChangeRecord { pub id: String, pub at: String, pub profile: String, pub region: String, pub topic_arn: String, pub request: SnsChangeRequest, pub calls: Vec<SnsCall>, pub before: Value, pub after: Value, pub undo_of: Option<String>, pub undone: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsApplyResult { pub calls_run: Vec<SnsCall>, pub error: Option<String>, pub record_id: Option<String> }

fn sid(topic: &str) -> String { format!("magic-mirror-sns-{}", topic.rsplit(':').next().unwrap_or(topic)) }
fn checked_arn<'a>(arn: &'a str, service: &str, account: &str, region: &str) -> Result<&'a str, AppError> {
    let p: Vec<_> = arn.splitn(6, ':').collect();
    if p.len() != 6 || p[0] != "arn" || p[2] != service || p[3] != region || p[4] != account || p[5].is_empty() { return Err(AppError::other("현재 계정과 리전의 리소스만 변경할 수 있어요")); }
    Ok(p[5])
}
fn fingerprint(value: &Value) -> String { format!("{:x}", Sha256::digest(value.to_string().as_bytes())) }
fn field(name: &str, before: Option<&str>, after: Option<&str>, policy: bool) -> SnsFieldChange {
    let diff = policy.then(|| {
        let fmt = |s: Option<&str>| s.map(|s| serde_json::from_str::<Value>(s).map(|v| serde_json::to_string_pretty(&v).unwrap_or_default()).unwrap_or_else(|_| s.to_owned())).unwrap_or_default();
        similar::TextDiff::from_lines(&fmt(before), &fmt(after)).unified_diff().header("이전", "이후").to_string()
    });
    SnsFieldChange { field: name.into(), before: json!(before), after: json!(after), diff }
}
fn call(api: &str, target: &str, body: Value) -> SnsCall { SnsCall { api: api.into(), target: target.into(), body } }
fn queue_statement(topic: &str, arn: &str, url: &str) -> Value {
    match fix::queue_policy(topic, arn, url) { SnsFix::QueuePolicy { statement, .. } => statement, _ => unreachable!() }
}
fn allowed(raw: Option<&str>, topic: &str, queue: &str, account: &str) -> bool {
    raw.is_some_and(|p| matches!(policy::allows(p, &Who::Service("sns.amazonaws.com".into()), "sqs:SendMessage", queue, &Ctx { source_arn: Some(topic.into()), source_account: Some(account.into()), source_owner: None }), Verdict::Allow { .. }))
}
#[derive(Clone)]
struct Queue { url: String, policy: Option<String>, fifo: bool, kms_key: Option<String> }
async fn queue(cfg: &SdkConfig, arn: &str, account: &str, region: &str) -> Result<Queue, AppError> {
    let name = checked_arn(arn, "sqs", account, region)?;
    let client = aws_sdk_sqs::Client::new(cfg);
    let out = client.get_queue_url().queue_name(name).send().await.map_err(|e| from_sdk(e, "sqs:GetQueueUrl"))?;
    let url = out.queue_url().ok_or_else(|| AppError::other("큐 URL을 읽지 못했어요"))?.to_owned();
    let out = client.get_queue_attributes().queue_url(&url).attribute_names(aws_sdk_sqs::types::QueueAttributeName::All).send().await.map_err(|e| from_sdk(e, "sqs:GetQueueAttributes"))?;
    let attrs = out.attributes();
    let actual = attrs.and_then(|a| a.get(&aws_sdk_sqs::types::QueueAttributeName::QueueArn));
    if actual.map(String::as_str) != Some(arn) { return Err(AppError::other("큐 ARN이 일치하지 않아요")); }
    Ok(Queue { url, policy: attrs.and_then(|a| a.get(&aws_sdk_sqs::types::QueueAttributeName::Policy)).cloned().filter(|s| !s.is_empty()), fifo: attrs.and_then(|a| a.get(&aws_sdk_sqs::types::QueueAttributeName::FifoQueue)).is_some_and(|s| s == "true"), kms_key: attrs.and_then(|a| a.get(&aws_sdk_sqs::types::QueueAttributeName::KmsMasterKeyId)).cloned() })
}
async fn lambda_policy(cfg: &SdkConfig, arn: &str) -> Result<Option<String>, AppError> {
    match aws_sdk_lambda::Client::new(cfg).get_policy().function_name(arn).send().await {
        Ok(out) => Ok(out.policy().map(str::to_owned)),
        Err(e) if e.code() == Some("ResourceNotFoundException") => Ok(None),
        Err(e) => Err(from_sdk(e, "lambda:GetPolicy")),
    }
}
fn list(path: &Path) -> Vec<SnsChangeRecord> { crate::jsonl::read_all(path) }
pub fn changes(path: &Path, profile: &str) -> Vec<SnsChangeRecord> { list(path).into_iter().rev().filter(|r| r.profile == profile).collect() }
fn undo_record(path: &Path, profile: &str, region: &str, id: &str) -> Result<SnsChangeRecord, AppError> {
    list(path).into_iter().find(|r| r.id == id && r.profile == profile && r.region == region && !r.undone && r.undo_of.is_none() && !r.calls.is_empty()).ok_or_else(|| AppError::other("되돌릴 수 있는 변경 기록이 없어요"))
}
fn prior(record: &SnsChangeRecord, name: &str) -> Option<String> { record.before.get(name).and_then(Value::as_str).map(str::to_owned) }

fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if key.eq_ignore_ascii_case("message") || key.eq_ignore_ascii_case("messagebody") { *value = Value::String("[가림]".into()); }
                else { redact(value); }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact),
        Value::String(s) => {
            if let Ok(mut nested @ (Value::Object(_) | Value::Array(_))) = serde_json::from_str::<Value>(s) {
                redact(&mut nested);
                *s = nested.to_string();
            } else if !s.starts_with("arn:") && !s.chars().any(char::is_whitespace) && s.contains('@') {
                *s = super::mask::endpoint("email", s);
            } else if s.starts_with('+') && s[1..].chars().all(|c| c.is_ascii_digit()) {
                *s = super::mask::endpoint("sms", s);
            }
        }
        _ => {}
    }
}

fn is_current(preview: &SnsPlan, fresh: &SnsPlan) -> bool {
    preview.fingerprint == fresh.fingerprint && preview.calls == fresh.calls && preview.fields == fresh.fields && preview.topic_arn == fresh.topic_arn
}

fn projected_impact(topic: &super::model::SnsTopic, evidence: &super::evidence::Evidence, request: &SnsChangeRequest, fields: &[SnsFieldChange], queue: Option<&Queue>) -> Vec<SnsImpact> {
    use super::model::SnsTarget;
    let before = super::diagnose::diagnose(topic, evidence, &[]);
    let mut projected = topic.clone();
    let mut next_evidence = evidence.clone();
    let after = |name: &str| fields.iter().find(|f| f.field == name).and_then(|f| f.after.as_str()).map(str::to_owned);
    match request {
        SnsChangeRequest::QueuePolicy { queue_arn, .. } => {
            for sub in &mut projected.subscriptions {
                if let Some(SnsTarget::Sqs { arn, policy, .. }) = &mut sub.target {
                    if arn == queue_arn { *policy = after("queuePolicy"); }
                }
            }
            if let Some(q) = next_evidence.queues.get_mut(queue_arn) { q.policy = after("queuePolicy"); }
        }
        SnsChangeRequest::LambdaPermission { function_arn, .. } => {
            for sub in &mut projected.subscriptions {
                if let Some(SnsTarget::Lambda { arn, policy, .. }) = &mut sub.target {
                    if arn == function_arn { *policy = after("lambdaPolicy"); }
                }
            }
        }
        SnsChangeRequest::AddDlq { subscription_arn, dlq_arn } => {
            if let Some(q) = queue {
                next_evidence.queues.insert(dlq_arn.clone(), super::evidence::QueueEvidence { arn: dlq_arn.clone(), url: q.url.clone(), policy: if fields.iter().any(|f| f.field == "queuePolicy") { after("queuePolicy") } else { q.policy.clone() }, kms_key: q.kms_key.clone(), error: None });
            }
            if fields.iter().any(|f| f.field == "redrivePolicy") {
                let arn = after("redrivePolicy").and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v.get("deadLetterTargetArn").and_then(Value::as_str).map(str::to_owned));
                for sub in &mut projected.subscriptions { if sub.arn.as_ref() == Some(subscription_arn) { sub.dlq_arn = arn.clone(); } }
            }
        }
        SnsChangeRequest::Undo { .. } => {}
    }
    let after_report = super::diagnose::diagnose(&projected, &next_evidence, &[]);
    let mut result = Vec::new();
    for old in before.subscriptions {
        if let Some(new) = after_report.subscriptions.iter().find(|d| d.subscription == old.subscription) {
            for check in old.checks {
                if let Some(next) = new.checks.iter().find(|c| c.id == check.id) {
                    if check.status != next.status {
                        result.push(SnsImpact { subscription: old.subscription.clone(), check: check.id, before: check.status, after: next.status.clone() });
                    }
                }
            }
        }
    }
    result
}

pub async fn plan(cfg: &SdkConfig, path: &Path, profile: &str, region: &str, account: &str, request: SnsChangeRequest) -> Result<SnsPlan, AppError> {
    let undo = match &request { SnsChangeRequest::Undo { id } => Some(undo_record(path, profile, region, id)?), _ => None };
    let base = undo.as_ref().map(|r| &r.request).unwrap_or(&request);
    let mut calls = Vec::new(); let mut fields = Vec::new(); let mut state = Vec::<Value>::new(); let mut warnings = Vec::new();
    let mut projected_queue: Option<Queue> = None;
    let topic = match base {
        SnsChangeRequest::QueuePolicy { topic_arn, queue_url, queue_arn } => {
            checked_arn(topic_arn, "sns", account, region)?;
            let q = queue(cfg, queue_arn, account, region).await?;
            if &q.url != queue_url { return Err(AppError::other("큐 URL이 ARN과 일치하지 않아요")); }
            state.push(json!({"queue": q.policy}));
            let after = if undo.is_some() { q.policy.as_deref().map(|p| policy::remove_statement(p, &sid(topic_arn))).transpose().map_err(AppError::other)?.flatten() } else { Some(policy::add_statement(q.policy.as_deref(), queue_arn, queue_statement(topic_arn, queue_arn, &q.url)).map_err(AppError::other)?) };
            fields.push(field("queuePolicy", q.policy.as_deref(), after.as_deref(), true));
            calls.push(call("sqs:SetQueueAttributes", &q.url, json!({"Policy": after.unwrap_or_default()})));
            topic_arn.clone()
        }
        SnsChangeRequest::LambdaPermission { topic_arn, function_arn } => {
            checked_arn(topic_arn, "sns", account, region)?; checked_arn(function_arn, "lambda", account, region)?;
            let before = lambda_policy(cfg, function_arn).await?;
            state.push(json!({"lambda": before}));
            let statement_id = sid(topic_arn);
            if undo.is_none() && before.as_deref().and_then(|p| serde_json::from_str::<Value>(p).ok()).and_then(|p| p.get("Statement").cloned()).is_some_and(|s| s.as_array().is_some_and(|a| a.iter().any(|s| s.get("Sid").and_then(Value::as_str) == Some(&statement_id)))) { return Err(AppError::other("같은 Sid의 Lambda 권한이 이미 있어요")); }
            let statement = json!({"Sid": statement_id, "Effect":"Allow", "Principal":{"Service":"sns.amazonaws.com"}, "Action":"lambda:InvokeFunction", "Resource":function_arn, "Condition":{"ArnLike":{"AWS:SourceArn":topic_arn}}});
            let after = if undo.is_some() { before.as_deref().map(|p| policy::remove_statement(p, &statement_id)).transpose().map_err(AppError::other)?.flatten() } else { Some(policy::add_statement(before.as_deref(), function_arn, statement).map_err(AppError::other)?) };
            fields.push(field("lambdaPolicy", before.as_deref(), after.as_deref(), true));
            calls.push(if undo.is_some() { call("lambda:RemovePermission", function_arn, json!({"StatementId":statement_id})) } else { call("lambda:AddPermission", function_arn, json!({"StatementId":statement_id,"Action":"lambda:InvokeFunction","Principal":"sns.amazonaws.com","SourceArn":topic_arn})) });
            topic_arn.clone()
        }
        SnsChangeRequest::AddDlq { subscription_arn, dlq_arn } => {
            checked_arn(subscription_arn, "sns", account, region)?;
            let out = aws_sdk_sns::Client::new(cfg).get_subscription_attributes().subscription_arn(subscription_arn).send().await.map_err(|e| from_sdk(e, "sns:GetSubscriptionAttributes"))?;
            let attrs = out.attributes().ok_or_else(|| AppError::other("구독 속성을 읽지 못했어요"))?;
            let topic = attrs.get("TopicArn").ok_or_else(|| AppError::other("구독의 주제를 읽지 못했어요"))?.clone();
            checked_arn(&topic, "sns", account, region)?;
            let before = attrs.get("RedrivePolicy").cloned().filter(|s| !s.is_empty());
            let q = queue(cfg, dlq_arn, account, region).await?;
            if topic.ends_with(".fifo") && !q.fifo { return Err(AppError::other("FIFO 주제의 DLQ는 FIFO 큐여야 해요")); }
            projected_queue = Some(q.clone());
            state.push(json!({"topic":topic,"redrive":before,"queue":q.policy}));
            let was_queue_written = undo.as_ref().is_some_and(|r| r.calls.iter().any(|c| c.api == "sqs:SetQueueAttributes"));
            if (undo.is_none() && !allowed(q.policy.as_deref(), &topic, dlq_arn, account)) || was_queue_written {
                let after = if undo.is_some() { q.policy.as_deref().map(|p| policy::remove_statement(p, &sid(&topic))).transpose().map_err(AppError::other)?.flatten() } else { Some(policy::add_statement(q.policy.as_deref(), dlq_arn, queue_statement(&topic, dlq_arn, &q.url)).map_err(AppError::other)?) };
                fields.push(field("queuePolicy", q.policy.as_deref(), after.as_deref(), true));
                calls.push(call("sqs:SetQueueAttributes", &q.url, json!({"Policy":after.unwrap_or_default()})));
            }
            let did_redrive = undo.as_ref().map_or(true, |r| r.calls.iter().any(|c| c.api == "sns:SetSubscriptionAttributes"));
            if did_redrive {
                let after = if let Some(record) = &undo { prior(record, "redrivePolicy") } else { Some(json!({"deadLetterTargetArn":dlq_arn}).to_string()) };
                fields.push(field("redrivePolicy", before.as_deref(), after.as_deref(), false));
                calls.push(call("sns:SetSubscriptionAttributes", subscription_arn, json!({"RedrivePolicy":after.unwrap_or_default()})));
            }
            if undo.is_some() { calls.reverse(); }
            topic
        }
        SnsChangeRequest::Undo { .. } => return Err(AppError::other("이 변경은 되돌릴 수 없어요")),
    };
    let fingerprint = fingerprint(&json!({"profile":profile,"region":region,"account":account,"request":request,"state":state,"undo":undo.as_ref().map(|r| (&r.id,r.undone))}));
    if calls.is_empty() { warnings.push("적용할 호출이 없어요".into()); }
    let impact = match super::fetch::topic(cfg, &topic, account, region).await {
        Ok(snapshot) => {
            let evidence = super::evidence::fetch(cfg, &snapshot).await;
            projected_impact(&snapshot, &evidence, base, &fields, projected_queue.as_ref())
        }
        Err(_) => { warnings.push("진단 변화를 읽지 못했어요".into()); Vec::new() }
    };
    let name = topic.rsplit(':').next().unwrap_or(&topic);
    let confirm = name.to_ascii_lowercase().contains("prod").then(|| name.to_owned());
    Ok(SnsPlan { request, topic_arn: topic, calls, fields, impact, warnings, confirm, fingerprint, undo_of: undo.map(|r| r.id) })
}

pub async fn apply(cfg: &SdkConfig, path: &Path, profile: &str, region: &str, account: &str, preview: SnsPlan) -> Result<SnsApplyResult, AppError> {
    let fresh = plan(cfg, path, profile, region, account, preview.request.clone()).await?;
    if !is_current(&preview, &fresh) { return Err(AppError::StalePlan); }
    let mut ran = Vec::new(); let mut error = None;
    for call in &fresh.calls {
        match super::write::execute(cfg, call).await { Ok(()) => ran.push(call.clone()), Err(e) => { error = Some(e.to_string()); break; } }
    }
    let mut record_id = None;
    if !ran.is_empty() {
        let now = chrono::Utc::now(); let id = format!("{}-{}", now.timestamp_nanos_opt().unwrap_or_default(), std::process::id());
        let applied_field = |f: &&SnsFieldChange| match f.field.as_str() {
            "queuePolicy" => ran.iter().any(|c| c.api == "sqs:SetQueueAttributes"),
            "lambdaPolicy" => ran.iter().any(|c| c.api == "lambda:AddPermission" || c.api == "lambda:RemovePermission"),
            "redrivePolicy" => ran.iter().any(|c| c.api == "sns:SetSubscriptionAttributes"),
            _ => false,
        };
        let before = fresh.fields.iter().filter(applied_field).map(|f| (f.field.clone(), f.before.clone())).collect::<serde_json::Map<_,_>>();
        let after = fresh.fields.iter().filter(applied_field).map(|f| (f.field.clone(), f.after.clone())).collect::<serde_json::Map<_,_>>();
        let record = SnsChangeRecord { id: id.clone(), at: now.to_rfc3339(), profile: profile.into(), region: region.into(), topic_arn: fresh.topic_arn, request: fresh.request, calls: ran.clone(), before: before.into(), after: after.into(), undo_of: fresh.undo_of.clone(), undone: false };
        let mut safe = serde_json::to_value(&record).map_err(|e| AppError::other(e.to_string()))?;
        if let Some(value) = safe.get_mut("calls") { redact(value); }
        if let Some(value) = safe.get_mut("before") { redact(value); }
        if let Some(value) = safe.get_mut("after") { redact(value); }
        match crate::jsonl::append(path, &safe) { Ok(()) => { record_id = Some(id); }, Err(e) => { error = Some(format!("변경은 적용됐지만 기록을 저장하지 못했어요: {e}")); } }
        if error.is_none() { if let Some(id) = fresh.undo_of { if let Err(e) = crate::jsonl::update(path, |r: &SnsChangeRecord| r.id == id && r.profile == profile, |r| r.undone = true) { error = Some(format!("되돌렸지만 기록을 표시하지 못했어요: {e}")); } } }
    }
    Ok(SnsApplyResult { calls_run: ran, error, record_id })
}

#[cfg(test)]
mod tests;
