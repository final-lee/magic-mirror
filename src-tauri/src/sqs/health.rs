//! 큐 건강 진단(순수). 입력이 없는 규칙은 건너뛴다. 결과는 실패 → 주의 → 정보 순이고, 같은 수준은 규칙 표 순서다.

use super::{FindingId, FindingLevel, SqsFinding, SqsQueue};

/// 가장 오래된 메시지가 보관 기간의 이 비율을 넘으면 실패 / 절반을 넘으면 주의
const EXPIRY_FAIL: f64 = 0.8;
const EXPIRY_WARN: f64 = 0.5;
/// 빈 수신이 이 횟수 이상이고 받은 메시지 수보다 많아야 "짧은 폴링"으로 본다
const SHORT_POLLING_EMPTY_MIN: f64 = 100.0;
/// AWS 권장: 소비 Lambda 제한 시간의 6배 이상으로 보이지 않는 시간을 잡는다
const LAMBDA_TIMEOUT_FACTOR: i64 = 6;

fn finding(id: FindingId, level: FindingLevel, summary: impl Into<String>, detail: Option<String>) -> SqsFinding {
    SqsFinding { id, level, summary: summary.into(), detail }
}

/// 큐 하나의 진단. `peers`는 같은 리전의 큐들(DLQ의 수치와 보관 기간을 본다). 읽지 못한 큐는 진단하지 않는다.
pub fn health(q: &SqsQueue, peers: &[SqsQueue]) -> Vec<SqsFinding> {
    if q.error.is_some() {
        return vec![];
    }
    let dlq_peer = q.redrive.as_ref().and_then(|r| peers.iter().find(|p| p.arn == r.dlq_arn));
    let mut out = Vec::new();

    // dlqBacklog: DLQ 자신에 쌓였으면 그것을, 아니면 원본 큐에 DLQ의 백로그를 단다
    if q.is_dlq && q.visible > 0 {
        out.push(finding(
            FindingId::DlqBacklog,
            FindingLevel::Fail,
            format!("DLQ에 {}개가 쌓여 있어요", q.visible),
            Some("소비자가 처리하지 못해 옮겨진 메시지예요. 메시지 탭에서 원인을 확인하고 다시 보내거나 지워 주세요".into()),
        ));
    } else if let Some(dlq) = dlq_peer.filter(|d| d.visible > 0) {
        out.push(finding(
            FindingId::DlqBacklog,
            FindingLevel::Fail,
            format!("DLQ `{}`에 {}개가 쌓여 있어요", dlq.name, dlq.visible),
            Some("이 큐에서 처리에 실패한 메시지가 DLQ로 옮겨졌어요".into()),
        ));
    }

    // nearExpiry
    if let (Some(age), true) = (q.activity.and_then(|a| a.oldest_age_sec), q.retention > 0) {
        let ratio = age / q.retention as f64;
        let level = if ratio >= EXPIRY_FAIL {
            Some(FindingLevel::Fail)
        } else if ratio >= EXPIRY_WARN {
            Some(FindingLevel::Warn)
        } else {
            None
        };
        if let Some(level) = level {
            out.push(finding(
                FindingId::NearExpiry,
                level,
                format!("가장 오래된 메시지가 보관 기간의 {}%예요", (ratio * 100.0).round() as i64),
                Some(format!("가장 오래된 메시지는 {}초 전에 들어왔고 보관 기간은 {}초예요. 보관 기간이 지나면 메시지가 사라져요", age.round() as i64, q.retention)),
            ));
        }
    }

    // stalled: DLQ는 원래 받아 가는 곳이 없으므로 dlqBacklog만 단다
    if !q.is_dlq && q.visible > 0 && q.activity.and_then(|a| a.received15m) == Some(0.0) {
        out.push(finding(
            FindingId::Stalled,
            FindingLevel::Warn,
            format!("보이는 메시지 {}개가 있는데 최근 15분 동안 받아 간 곳이 없어요", q.visible),
            Some("소비자가 멈췄거나 연결이 끊겼을 수 있어요".into()),
        ));
    }

    // publicPolicy
    if q.policy.as_deref().is_some_and(super::policy::is_public) {
        out.push(finding(
            FindingId::PublicPolicy,
            FindingLevel::Fail,
            "큐 정책이 누구에게나 열려 있어요",
            Some("조건 없이 Principal이 `*`인 Allow 문장이 있어서 누구든 이 큐를 쓸 수 있어요".into()),
        ));
    }

    // dlqRetentionShort: Standard 큐는 옮겨져도 처음 넣은 시각으로 만료된다
    if let (false, Some(dlq)) = (q.fifo, dlq_peer) {
        if dlq.retention <= q.retention {
            out.push(finding(
                FindingId::DlqRetentionShort,
                FindingLevel::Warn,
                "DLQ 보관 기간이 원본 큐보다 길지 않아요",
                Some(format!("DLQ `{}`의 보관 기간은 {}초, 이 큐는 {}초예요. Standard 큐에서는 DLQ로 옮겨져도 처음 넣은 시각 기준으로 만료돼서 DLQ에서 살아 있는 시간이 짧아져요", dlq.name, dlq.retention, q.retention)),
            ));
        }
    }

    // maxReceiveOne
    if q.redrive.as_ref().is_some_and(|r| r.max_receive_count == 1) {
        out.push(finding(
            FindingId::MaxReceiveOne,
            FindingLevel::Warn,
            "maxReceiveCount가 1이에요",
            Some("한 번만 실패해도 메시지가 바로 DLQ로 가요. 일시적인 오류에도 재시도 없이 옮겨져요".into()),
        ));
    }

    // noDlq
    if !q.is_dlq && q.redrive.is_none() {
        out.push(finding(FindingId::NoDlq, FindingLevel::Info, "DLQ가 없어요", Some("처리에 계속 실패하는 메시지가 보관 기간까지 큐에 남아요".into())));
    }

    // shortPolling
    if let Some(activity) = q.activity {
        if let (0, Some(empty), Some(received)) = (q.wait_time, activity.empty_receives15m, activity.received15m) {
            if empty > received && empty >= SHORT_POLLING_EMPTY_MIN {
                out.push(finding(
                    FindingId::ShortPolling,
                    FindingLevel::Info,
                    "짧은 폴링으로 빈 수신이 많아요",
                    Some(format!("최근 15분 동안 빈 수신이 {}번, 받은 메시지는 {}개예요. 수신 대기 시간을 늘리면(롱 폴링) 요청 수가 줄어요", empty as i64, received as i64)),
                ));
            }
        }
    }

    // noEncryption
    if !q.sse_managed && q.kms_key.is_none() {
        out.push(finding(FindingId::NoEncryption, FindingLevel::Info, "저장 시 암호화가 꺼져 있어요", Some("SSE-SQS나 KMS 키로 암호화할 수 있어요".into())));
    }

    sort(&mut out);
    out
}

/// 실패 → 주의 → 정보. 같은 수준은 들어온 순서를 지킨다
pub fn sort(findings: &mut [SqsFinding]) {
    findings.sort_by_key(|f| match f.level {
        FindingLevel::Fail => 0,
        FindingLevel::Warn => 1,
        FindingLevel::Info => 2,
    });
}

/// 이 큐를 소비하는 Lambda(이벤트 소스 매핑 하나)
#[derive(Debug, Clone, PartialEq)]
pub struct LambdaConsumer {
    pub name: String,
    /// 함수 제한 시간(초). 못 읽었으면 None
    pub timeout_secs: Option<i64>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProducerKind {
    Sns,
    Rule,
}

/// 큐로 보내는 연결(SNS 구독, EventBridge 규칙 대상)과 큐 정책의 판정
#[derive(Debug, Clone, PartialEq)]
pub struct ProducerLink {
    pub kind: ProducerKind,
    pub label: String,
    /// 큐 정책이 이 출처의 SendMessage를 허용하는가(None: 판단 불가)
    pub allowed: Option<bool>,
}

impl ProducerKind {
    fn name(self) -> &'static str {
        match self {
            ProducerKind::Sns => "SNS",
            ProducerKind::Rule => "EventBridge",
        }
    }
}

/// 암호화 키가 서비스 생산자에 열려 있는가
#[derive(Debug, Clone, PartialEq)]
pub enum KmsAccess {
    /// 고객 관리 키를 쓰지 않거나 확인할 필요가 없다
    NotApplicable,
    /// `alias/aws/sqs`
    AwsManaged,
    /// 고객 관리 키. 서비스(SNS·EventBridge)마다 키 정책의 판정
    Customer(Vec<(ProducerKind, Option<bool>)>),
    /// 키 정책을 읽지 못했다
    Unreadable(String),
}

/// 흐름 진단의 입력
pub struct FlowParts<'a> {
    pub lambdas: &'a [LambdaConsumer],
    pub pipe_running: bool,
    /// IAM으로 계산했다면 이 큐를 받을 수 있는 주체 수
    pub iam_receivers: Option<usize>,
    pub producers: &'a [ProducerLink],
    pub kms: &'a KmsAccess,
}

/// 흐름에서 나오는 진단: visibilityVsLambda, noConsumer, subscriptionDenied, kmsBlocksProducer
pub fn flow_findings(q: &SqsQueue, parts: &FlowParts) -> Vec<SqsFinding> {
    let mut out = Vec::new();

    // visibilityVsLambda: 제한 시간 × 6이 보이지 않는 시간을 넘는 함수
    let too_long: Vec<&LambdaConsumer> = parts
        .lambdas
        .iter()
        .filter(|l| l.enabled && l.timeout_secs.is_some_and(|t| t * LAMBDA_TIMEOUT_FACTOR > q.visibility_timeout))
        .collect();
    if !too_long.is_empty() {
        let names: Vec<String> = too_long.iter().map(|l| format!("`{}`(제한 시간 {}초)", l.name, l.timeout_secs.unwrap_or_default())).collect();
        out.push(finding(
            FindingId::VisibilityVsLambda,
            FindingLevel::Warn,
            format!("소비 Lambda의 제한 시간 × 6이 보이지 않는 시간({}초)보다 길어요", q.visibility_timeout),
            Some(format!("{}. 처리 중에 메시지가 다시 보여서 두 번 처리될 수 있어요. 보이지 않는 시간을 제한 시간의 6배 이상으로 잡는 것을 AWS가 권장해요", names.join(", "))),
        ));
    }

    // noConsumer: DLQ는 소비자 없이 쌓이는 것이 정상이다
    let esm_enabled = parts.lambdas.iter().any(|l| l.enabled);
    if !q.is_dlq && !esm_enabled && !parts.pipe_running && parts.iam_receivers.is_none_or(|n| n == 0) {
        let detail = if parts.iam_receivers.is_some() {
            "활성 Lambda 연결, 실행 중인 Pipe, 받을 수 있는 IAM 주체가 모두 없어요"
        } else {
            "활성 Lambda 연결과 실행 중인 Pipe가 없어요. IAM으로 계산하면 ECS·EC2 같은 다른 소비자도 찾아봐요"
        };
        out.push(finding(FindingId::NoConsumer, FindingLevel::Warn, "이 큐를 받아 가는 소비자가 보이지 않아요", Some(detail.into())));
    }

    // subscriptionDenied: 연결은 있는데 큐 정책이 그 출처를 허용하지 않는다
    let denied: Vec<&ProducerLink> = parts.producers.iter().filter(|p| p.allowed == Some(false)).collect();
    if !denied.is_empty() {
        let names: Vec<String> = denied.iter().map(|p| format!("{} `{}`", p.kind.name(), p.label)).collect();
        out.push(finding(
            FindingId::SubscriptionDenied,
            FindingLevel::Fail,
            format!("큐 정책이 연결된 출처 {}곳의 전송을 허용하지 않아요", denied.len()),
            Some(format!("{}. 이 출처가 보낸 메시지는 큐에 들어오지 못하고 버려져요. 큐 정책에 sqs:SendMessage 허용(aws:SourceArn 조건)을 더해야 해요", names.join(", "))),
        ));
    }

    // kmsBlocksProducer
    if !parts.producers.is_empty() {
        match parts.kms {
            KmsAccess::NotApplicable => {}
            KmsAccess::AwsManaged => out.push(finding(
                FindingId::KmsBlocksProducer,
                FindingLevel::Fail,
                "AWS 관리 키(alias/aws/sqs)로 암호화돼 SNS·EventBridge가 보낼 수 없어요",
                Some("서비스는 AWS 관리 키를 쓸 수 없어요. 고객 관리 키를 쓰고 키 정책에 서비스 주체를 허용하거나 SSE-SQS로 바꿔 주세요".into()),
            )),
            KmsAccess::Customer(verdicts) => {
                let blocked: Vec<&str> = verdicts.iter().filter(|(_, v)| *v == Some(false)).map(|(k, _)| k.name()).collect();
                let unknown: Vec<&str> = verdicts.iter().filter(|(_, v)| v.is_none()).map(|(k, _)| k.name()).collect();
                if !blocked.is_empty() {
                    out.push(finding(
                        FindingId::KmsBlocksProducer,
                        FindingLevel::Fail,
                        format!("키 정책이 {}에 kms:GenerateDataKey*·kms:Decrypt를 주지 않아요", blocked.join("·")),
                        Some("그 서비스가 보낸 메시지는 암호화하지 못해 큐에 들어오지 못해요".into()),
                    ));
                } else if !unknown.is_empty() {
                    out.push(finding(
                        FindingId::KmsBlocksProducer,
                        FindingLevel::Warn,
                        format!("키 정책이 {}에 열려 있는지 알 수 없어요", unknown.join("·")),
                        Some("키 정책에 조건이 있어 이 앱이 판단하지 못했어요".into()),
                    ));
                }
            }
            KmsAccess::Unreadable(reason) => out.push(finding(
                FindingId::KmsBlocksProducer,
                FindingLevel::Warn,
                "키 정책을 읽지 못해 알 수 없어요",
                Some(format!("서비스 생산자가 있어서 키 정책이 필요해요: {reason}")),
            )),
        }
    }

    sort(&mut out);
    out
}

#[cfg(test)]
mod tests;
