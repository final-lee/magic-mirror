//! SNS 배달 경로의 읽기 전용 판정.
use super::{
    evidence::{DeliveryFailure, Evidence, KeyEvidence, QueueEvidence},
    filter::{self, Scope},
    fix::{self, SnsFix},
    model::{SnsSubscription, SnsTarget, SnsTopic},
    policy::{self, Ctx, Verdict, Who},
    publishers::Publisher,
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsCheck {
    pub id: String,
    pub status: String,
    pub summary: String,
    pub detail: Option<String>,
    pub fix: Option<SnsFix>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsDiagnosis {
    pub subscription: String,
    pub checks: Vec<SnsCheck>,
    pub verdict: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsDiagnosisReport {
    pub topic_checks: Vec<SnsCheck>,
    pub subscriptions: Vec<SnsDiagnosis>,
    pub failures: Vec<DeliveryFailure>,
    pub metrics: TopicHourMetrics,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicHourMetrics {
    pub failed: Option<f64>,
    pub filtered_invalid_attributes: Option<f64>,
    pub filtered_invalid_body: Option<f64>,
    pub redriven_to_dlq: Option<f64>,
    pub delivered: Option<f64>,
    pub published: Option<f64>,
}
fn check(
    id: &str,
    status: &str,
    summary: &str,
    detail: Option<String>,
    fix: Option<SnsFix>,
) -> SnsCheck {
    SnsCheck {
        id: id.into(),
        status: status.into(),
        summary: summary.into(),
        detail,
        fix,
    }
}
fn context(topic: &SnsTopic) -> Ctx {
    Ctx {
        source_arn: Some(topic.arn.clone()),
        source_account: Some(topic.account.clone()),
        source_owner: None,
    }
}
fn endpoint_error(id: &str, error: &crate::error::AppError) -> SnsCheck {
    let detail = error.to_string();
    let missing = [
        "QueueDoesNotExist",
        "NonExistentQueue",
        "ResourceNotFoundException",
    ]
    .iter()
    .any(|code| detail.contains(code));
    if missing {
        check(id, "fail", "엔드포인트가 없어요", Some(detail), None)
    } else {
        check(id, "skip", "엔드포인트를 읽지 못했어요", Some(detail), None)
    }
}
fn policy_check(
    id: &str,
    raw: Option<&str>,
    principal: &str,
    action: &str,
    resource: &str,
    topic: &SnsTopic,
    fix: Option<SnsFix>,
) -> SnsCheck {
    let verdict = raw
        .map(|p| {
            policy::allows(
                p,
                &Who::Service(principal.into()),
                action,
                resource,
                &context(topic),
            )
        })
        .unwrap_or(Verdict::NoMatch);
    match verdict {
        Verdict::Allow { .. } => check(id, "ok", "정책이 배달을 허용해요", None, None),
        Verdict::Unknown { reason } => check(
            id,
            "warn",
            "정책 조건을 판단할 수 없어요",
            Some(reason),
            None,
        ),
        Verdict::Deny { .. } => check(
            id,
            "fail",
            "정책이 배달을 거부해요",
            Some("명시적 거부가 허용보다 우선해요".into()),
            None,
        ),
        Verdict::NoMatch => check(id, "fail", "정책에 배달 권한이 없어요", None, fix),
    }
}
fn kms_check(id: &str, key_id: Option<&str>, evidence: &Evidence, topic: &SnsTopic) -> SnsCheck {
    let Some(key_id) = key_id else {
        return check(id, "ok", "고객 관리 키를 사용하지 않아요", None, None);
    };
    if key_id.contains("alias/aws/sqs") {
        return check(
            id,
            "fail",
            "AWS 관리 SQS 키는 SNS 배달에 쓸 수 없어요",
            Some("AWS 관리 키의 정책은 바꿀 수 없어요".into()),
            None,
        );
    }
    let Some(key) = evidence.keys.get(key_id) else {
        return check(id, "skip", "키 정보를 읽지 못했어요", None, None);
    };
    if key.managed {
        return check(
            id,
            "fail",
            "AWS 관리 SQS 키는 SNS 배달에 쓸 수 없어요",
            Some("AWS 관리 키의 정책은 바꿀 수 없어요".into()),
            None,
        );
    }
    key_grants(id, key, "sns.amazonaws.com", topic)
}
fn key_grants(id: &str, key: &KeyEvidence, principal: &str, topic: &SnsTopic) -> SnsCheck {
    if let Some(e) = &key.error {
        return check(
            id,
            "skip",
            "키 정책을 읽지 못했어요",
            Some(e.to_string()),
            None,
        );
    }
    if key.state != "Enabled" {
        return check(
            id,
            "fail",
            "KMS 키를 사용할 수 없어요",
            Some(format!("키 상태: {}", key.state)),
            None,
        );
    }
    let fix = || Some(fix::kms_statement(&topic.arn, &key.arn, principal));
    for action in ["kms:GenerateDataKey", "kms:Decrypt"] {
        let c = policy_check(
            id,
            key.policy.as_deref(),
            principal,
            action,
            &key.arn,
            topic,
            fix(),
        );
        if c.status != "ok" {
            return c;
        }
    }
    check(id, "ok", "키 정책이 배달을 허용해요", None, None)
}
fn queue_checks(topic: &SnsTopic, evidence: &Evidence, id: &str, q: &QueueEvidence) -> SnsCheck {
    if let Some(e) = &q.error {
        return endpoint_error(id, e);
    }
    let p = policy_check(
        id,
        q.policy.as_deref(),
        "sns.amazonaws.com",
        "sqs:SendMessage",
        &q.arn,
        topic,
        Some(fix::queue_policy(&topic.arn, &q.arn, &q.url)),
    );
    if p.status != "ok" {
        return p;
    }
    let mut k = kms_check(id, q.kms_key.as_deref(), evidence, topic);
    if k.status == "ok" {
        k.summary = "DLQ 정책과 암호화가 배달을 허용해요".into();
    }
    k
}
fn subscription(topic: &SnsTopic, evidence: &Evidence, sub: &SnsSubscription) -> SnsDiagnosis {
    let mut checks = Vec::new();
    checks.push(match sub.state.as_str() {
        "confirmed" => check("confirmed", "ok", "구독이 확인됐어요", None, None),
        "pending" => check(
            "confirmed",
            "fail",
            "구독 확인을 기다리고 있어요",
            Some(
                if matches!(
                    sub.protocol.as_str(),
                    "email" | "email-json" | "http" | "https"
                ) {
                    "확인 메일 또는 요청이 필요해요. 확인하지 않으면 3일 뒤 자동 삭제돼요"
                } else {
                    "구독 확인이 필요해요"
                }
                .into(),
            ),
            None,
        ),
        _ => check(
            "confirmed",
            "skip",
            "구독 확인 상태를 알 수 없어요",
            sub.error.as_ref().map(ToString::to_string),
            None,
        ),
    });
    if matches!(sub.protocol.as_str(), "sqs" | "lambda") {
        match &sub.target {
            Some(SnsTarget::Sqs {
                arn,
                url,
                policy,
                kms_key,
                error,
                ..
            }) => {
                if let Some(e) = error {
                    checks.push(endpoint_error("endpoint", e));
                    checks.push(check(
                        "queuePolicy",
                        "skip",
                        "큐 정책을 읽지 못했어요",
                        Some(e.to_string()),
                        None,
                    ));
                    checks.push(check(
                        "queueKms",
                        "skip",
                        "큐 키를 읽지 못했어요",
                        Some(e.to_string()),
                        None,
                    ));
                } else {
                    checks.push(check("endpoint", "ok", "큐가 있어요", None, None));
                    checks.push(policy_check(
                        "queuePolicy",
                        policy.as_deref(),
                        "sns.amazonaws.com",
                        "sqs:SendMessage",
                        arn,
                        topic,
                        Some(fix::queue_policy(&topic.arn, arn, url)),
                    ));
                    checks.push(kms_check("queueKms", kms_key.as_deref(), evidence, topic));
                }
            }
            Some(SnsTarget::Lambda { arn, policy, error }) => {
                if let Some(e) = error {
                    checks.push(endpoint_error("endpoint", e));
                    checks.push(check(
                        "lambdaPolicy",
                        "skip",
                        "함수 정책을 읽지 못했어요",
                        Some(e.to_string()),
                        None,
                    ));
                } else {
                    checks.push(check("endpoint", "ok", "함수가 있어요", None, None));
                    checks.push(policy_check(
                        "lambdaPolicy",
                        policy.as_deref(),
                        "sns.amazonaws.com",
                        "lambda:InvokeFunction",
                        arn,
                        topic,
                        Some(fix::lambda_permission(&topic.arn, arn)),
                    ));
                }
            }
            None => checks.push(check(
                "endpoint",
                "skip",
                "엔드포인트를 읽지 못했어요",
                Some("현재 계정과 리전의 엔드포인트만 읽어요".into()),
                None,
            )),
        }
    }
    if matches!(sub.protocol.as_str(), "sqs" | "lambda" | "http" | "https") {
        checks.push(match &sub.dlq_arn {
            None if sub.error.is_some() => check(
                "dlq",
                "skip",
                "DLQ 설정을 읽지 못했어요",
                sub.error.as_ref().map(ToString::to_string),
                None,
            ),
            None => check(
                "dlq",
                "warn",
                "DLQ가 없어요",
                None,
                sub.arn.as_ref().map(|a| SnsFix::AddDlq {
                    subscription_arn: a.clone(),
                }),
            ),
            Some(arn) => match evidence.queues.get(arn) {
                Some(q) => queue_checks(topic, evidence, "dlq", q),
                None => check("dlq", "skip", "DLQ를 읽지 못했어요", None, None),
            },
        });
    }
    if sub.protocol == "http" {
        checks.push(check(
            "transport",
            "warn",
            "HTTP는 암호화되지 않아요",
            Some("HTTPS 엔드포인트를 사용하세요".into()),
            None,
        ));
    }
    if let Some(raw) = sub
        .attributes
        .get("FilterPolicy")
        .cloned()
        .or_else(|| sub.filter.as_ref().map(|f| f.policy.to_string()))
    {
        let parsed = filter::parse_policy(&raw);
        let scope = sub
            .attributes
            .get("FilterPolicyScope")
            .map(String::as_str)
            .or_else(|| sub.filter.as_ref().map(|f| f.scope.as_str()));
        let errors = match parsed {
            Err(e) => vec![e],
            Ok(p) => filter::validate(
                &p,
                if scope == Some("MessageBody") {
                    Scope::MessageBody
                } else {
                    Scope::MessageAttributes
                },
            ),
        };
        if !errors.is_empty() {
            checks.push(check(
                "filter",
                "fail",
                "필터 정책이 올바르지 않아요",
                Some(
                    errors
                        .into_iter()
                        .map(|e| e.message)
                        .collect::<Vec<_>>()
                        .join("\n"),
                ),
                None,
            ));
        } else if evidence.metric_error.is_some() {
            checks.push(check(
                "filter",
                "skip",
                "필터 오류 지표를 읽지 못했어요",
                evidence.metric_error.as_ref().map(ToString::to_string),
                None,
            ));
        } else if [
            "NumberOfNotificationsFilteredOut-InvalidAttributes",
            "NumberOfNotificationsFilteredOut-InvalidMessageBody",
        ]
        .iter()
        .any(|n| evidence.metrics.get(*n).copied().unwrap_or(0.0) > 0.0)
        {
            checks.push(check(
                "filter",
                "warn",
                "지난 1시간 동안 잘못된 메시지가 필터링됐어요",
                Some("이 지표는 주제 전체의 값이에요".into()),
                None,
            ));
        } else {
            checks.push(check(
                "filter",
                "ok",
                "필터 정책이 올바르고 최근 오류가 없어요",
                None,
                None,
            ));
        }
    }
    let failures: Vec<_> = evidence
        .failures
        .iter()
        .rev()
        .filter(|f| f.destination == sub.endpoint)
        .take(5)
        .map(|f| {
            format!(
                "{} {} · 시도 {}",
                f.status_code.as_deref().unwrap_or("상태 미상"),
                f.response.as_deref().unwrap_or("응답 없음"),
                f.attempts
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "미상".into())
            )
        })
        .collect();
    let failed = evidence
        .metrics
        .get("NumberOfNotificationsFailed")
        .copied()
        .unwrap_or(0.0);
    checks.push(if let Some(e) = &evidence.metric_error {
        check(
            "recentFailures",
            "skip",
            "최근 실패 지표를 읽지 못했어요",
            Some(e.to_string()),
            None,
        )
    } else if failed > 0.0 {
        let detail = if !failures.is_empty() {
            failures.join("\n")
        } else if evidence.logs_missing {
            "주제 전체 지표예요. 배달 실패 로그가 꺼져 있어요".into()
        } else if let Some(e) = &evidence.log_error {
            format!("배달 실패 로그를 읽지 못했어요: {e}")
        } else {
            "주제 전체 지표예요. 로그가 비어 있어 이 구독의 실패 여부는 알 수 없어요".into()
        };
        check(
            "recentFailures",
            "warn",
            "지난 1시간 동안 배달 실패가 있었어요",
            Some(detail),
            None,
        )
    } else {
        check(
            "recentFailures",
            "ok",
            "지난 1시간 동안 주제의 배달 실패가 없어요",
            None,
            None,
        )
    });
    let verdict = checks
        .iter()
        .find(|c| c.status == "fail")
        .or_else(|| checks.iter().find(|c| c.status == "warn"))
        .map(|c| c.summary.clone())
        .unwrap_or_else(|| {
            if checks.iter().any(|c| c.status == "skip") {
                "읽지 못한 항목이 있어 배달 경로를 모두 판단할 수 없어요".into()
            } else {
                "배달 경로에 막힌 곳이 없어요".into()
            }
        });
    SnsDiagnosis {
        subscription: sub.key.clone(),
        checks,
        verdict,
    }
}
pub fn diagnose(
    topic: &SnsTopic,
    evidence: &Evidence,
    publishers: &[Publisher],
) -> SnsDiagnosisReport {
    let mut topic_checks = Vec::new();
    if let Some(id) = &topic.overview.kms_key {
        let configured: Vec<_> = publishers.iter().filter(|p| p.configured).collect();
        match evidence.keys.get(id) {
            None => topic_checks.push(check(
                "topicKms",
                "skip",
                "주제 키를 읽지 못했어요",
                None,
                None,
            )),
            Some(key) if !key.state.is_empty() && key.state != "Enabled" => {
                topic_checks.push(check(
                    "topicKms",
                    "fail",
                    "주제 KMS 키를 사용할 수 없어요",
                    Some(format!("키 상태: {}", key.state)),
                    None,
                ))
            }
            Some(key) if key.managed && configured.iter().any(|p| p.principal.is_some()) => {
                topic_checks.push(check(
                    "topicKms",
                    "fail",
                    "AWS 관리 SNS 키는 서비스 발행자에게 권한을 줄 수 없어요",
                    None,
                    None,
                ))
            }
            Some(key) if key.error.is_some() => topic_checks.push(check(
                "topicKms",
                "skip",
                "주제 키를 읽지 못했어요",
                key.error.as_ref().map(ToString::to_string),
                None,
            )),
            Some(key) if key.managed && configured.iter().any(|p| p.principal.is_none()) => {
                topic_checks.push(check(
                    "topicKms",
                    "skip",
                    "역할로 발행하는 서비스의 키 권한은 판단할 수 없어요",
                    None,
                    None,
                ))
            }
            Some(key) if key.managed => topic_checks.push(check(
                "topicKms",
                "ok",
                "주제 KMS 키를 사용할 수 있어요",
                None,
                None,
            )),
            Some(key) => {
                let mut results = Vec::new();
                for publisher in configured {
                    if let Some(principal) = &publisher.principal {
                        results.push(key_grants("topicKms", key, principal, topic));
                    } else {
                        results.push(check(
                            "topicKms",
                            "skip",
                            "역할로 발행하는 서비스의 키 권한은 판단할 수 없어요",
                            Some(publisher.name.clone()),
                            None,
                        ));
                    }
                }
                if results.is_empty() {
                    results.push(check(
                        "topicKms",
                        "ok",
                        "주제 KMS 키를 사용할 수 있어요",
                        None,
                        None,
                    ));
                }
                topic_checks.extend(results);
            }
        }
    }
    if evidence.logs_missing
        && evidence
            .metrics
            .get("NumberOfNotificationsFailed")
            .copied()
            .unwrap_or(0.0)
            > 0.0
    {
        topic_checks.push(check(
            "deliveryLogging",
            "warn",
            "배달 실패가 있지만 실패 로그가 꺼져 있어요",
            None,
            None,
        ));
    }
    let metric = |name| {
        if evidence.metric_error.is_some() {
            None
        } else {
            evidence.metrics.get(name).copied()
        }
    };
    let metrics = TopicHourMetrics {
        failed: metric("NumberOfNotificationsFailed"),
        filtered_invalid_attributes: metric("NumberOfNotificationsFilteredOut-InvalidAttributes"),
        filtered_invalid_body: metric("NumberOfNotificationsFilteredOut-InvalidMessageBody"),
        redriven_to_dlq: metric("NumberOfNotificationsRedrivenToDlq"),
        delivered: metric("NumberOfNotificationsDelivered"),
        published: metric("NumberOfMessagesPublished"),
    };
    SnsDiagnosisReport {
        topic_checks,
        subscriptions: topic
            .subscriptions
            .iter()
            .map(|s| subscription(topic, evidence, s))
            .collect(),
        failures: evidence.failures.clone(),
        metrics,
    }
}

#[cfg(test)]
mod tests;
