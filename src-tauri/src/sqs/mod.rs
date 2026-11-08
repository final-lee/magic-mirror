//! SQS 워크스페이스. 타입은 `src/sqs/types.ts`와 같은 모양(serde camelCase)이고, 명령은 `sqs_commands`가 이 모듈의 함수를 부른다.
//! 목록·속성 해석은 `read`, CloudWatch 활동은 `activity`, 진단은 `health`(순수), 큐 정책 풀이는 `policy`(순수),
//! 생산자·소비자 흐름은 `flow`, 엿보기 세션은 `peek`, 변경 미리 보기·적용은 `change`, 기록은 `log`.

pub mod activity;
pub mod change;
pub mod flow;
pub mod health;
pub mod log;
pub mod peek;
pub mod policy;
pub mod read;

#[cfg(test)]
mod live_tests;

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

pub use crate::iam::change::{WarnLevel, Warning};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FindingLevel {
    Fail,
    Warn,
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingId {
    DlqBacklog,
    NearExpiry,
    Stalled,
    PublicPolicy,
    DlqRetentionShort,
    MaxReceiveOne,
    NoDlq,
    ShortPolling,
    NoEncryption,
    VisibilityVsLambda,
    NoConsumer,
    SubscriptionDenied,
    KmsBlocksProducer,
}

/// 건강 진단 한 줄. 문구는 백엔드가 만든다
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsFinding {
    pub id: FindingId,
    pub level: FindingLevel,
    pub summary: String,
    pub detail: Option<String>,
}

/// 최근 15분 CloudWatch 값. 못 읽었으면 None
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsActivity {
    pub oldest_age_sec: Option<f64>,
    pub received15m: Option<f64>,
    pub empty_receives15m: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsRedrive {
    pub dlq_arn: String,
    pub max_receive_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsQueue {
    pub url: String,
    pub arn: String,
    pub name: String,
    pub fifo: bool,
    pub visible: i64,
    pub in_flight: i64,
    pub delayed: i64,
    /// 초
    pub visibility_timeout: i64,
    pub retention: i64,
    pub delay: i64,
    /// 바이트
    pub max_size: i64,
    pub wait_time: i64,
    pub redrive: Option<SqsRedrive>,
    /// RedriveAllowPolicy 원문(JSON)
    pub redrive_allow: Option<String>,
    pub sse_managed: bool,
    pub kms_key: Option<String>,
    pub content_dedup: Option<bool>,
    pub dedup_scope: Option<String>,
    pub throughput_limit: Option<String>,
    /// 큐 정책 원문(JSON)
    pub policy: Option<String>,
    /// Unix ms
    pub created_at: Option<i64>,
    pub modified_at: Option<i64>,
    /// 이 큐를 DLQ로 쓰는 큐의 ARN
    pub sources: Vec<String>,
    pub is_dlq: bool,
    pub activity: Option<SqsActivity>,
    /// `sqs_queue`만 채운다. 목록(`sqs_overview`)에서는 빈 객체
    pub tags: BTreeMap<String, String>,
    pub findings: Vec<SqsFinding>,
    /// 속성을 읽지 못한 큐(권한 없음 등). 그때 수치는 0이다
    pub error: Option<String>,
}

#[cfg(test)]
impl SqsQueue {
    /// 시험용 기본 큐: Standard, 보관 4일, 보이지 않는 시간 30초, SSE-SQS, DLQ 없음
    pub fn fixture(name: &str) -> SqsQueue {
        SqsQueue {
            url: format!("https://sqs.ap-northeast-2.amazonaws.com/111111111111/{name}"),
            arn: format!("arn:aws:sqs:ap-northeast-2:111111111111:{name}"),
            name: name.to_string(),
            fifo: name.ends_with(".fifo"),
            visible: 0,
            in_flight: 0,
            delayed: 0,
            visibility_timeout: 30,
            retention: 345_600,
            delay: 0,
            max_size: 262_144,
            wait_time: 0,
            redrive: None,
            redrive_allow: None,
            sse_managed: true,
            kms_key: None,
            content_dedup: None,
            dedup_scope: None,
            throughput_limit: None,
            policy: None,
            created_at: None,
            modified_at: Some(1_700_000_000_000),
            sources: vec![],
            is_dlq: false,
            activity: None,
            tags: BTreeMap::new(),
            findings: vec![],
            error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsOverview {
    pub queues: Vec<SqsQueue>,
    pub truncated: bool,
    /// CloudWatch 활동을 읽은 시각(Unix ms). 못 읽었으면 None
    pub activity_at: Option<i64>,
    pub activity_error: Option<String>,
}

/// 다른 화면으로 가는 길. queue는 같은 SQS 탭 안에서 고른다
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SqsJump {
    Queue { url: String },
    Resource { service: String, #[serde(rename = "type")] type_id: String, id: String },
    Eks { cluster: String },
    Iam { arn: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FlowNodeKind {
    Sns,
    Rule,
    Pipe,
    S3,
    Lambda,
    Principal,
    ServiceAccount,
    Queue,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FlowDetail {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowNode {
    pub kind: FlowNodeKind,
    /// ARN 또는 그 노드를 가리키는 고유 값
    pub id: String,
    pub label: String,
    /// Enabled/Disabled, ENABLED, RUNNING, PendingConfirmation … 원문
    pub state: Option<String>,
    /// 큐 정책이 이 출처의 SendMessage를 허용하는가. 판단할 수 없거나 해당 없으면 None
    pub allowed_by_policy: Option<bool>,
    pub cross_account: bool,
    pub detail: Vec<FlowDetail>,
    pub jump: Option<SqsJump>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Effect {
    Allow,
    Deny,
}

/// 큐 정책 문장 하나를 사람이 읽을 수 있게 푼 것
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyGrant {
    pub sid: Option<String>,
    pub effect: Effect,
    pub principals: Vec<String>,
    pub actions: Vec<String>,
    /// "aws:SourceArn ArnEquals arn:…" 같은 조건 한 줄씩
    pub conditions: Vec<String>,
    /// aws:SourceArn·aws:SourceAccount 값
    pub sources: Vec<String>,
    /// 조건 없는 Principal "*" Allow
    pub public: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SqsGap {
    pub section: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsFlow {
    pub producers: Vec<FlowNode>,
    pub consumers: Vec<FlowNode>,
    pub dlq: Option<FlowNode>,
    /// 이 큐를 DLQ로 쓰는 큐
    pub sources: Vec<FlowNode>,
    pub policy: Vec<PolicyGrant>,
    /// 흐름에서 나온 진단(visibilityVsLambda, noConsumer, subscriptionDenied, kmsBlocksProducer)
    pub findings: Vec<SqsFinding>,
    pub gaps: Vec<SqsGap>,
    /// IAM 주체를 계산했는가(withIam)
    pub iam: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FlowEdgeKind {
    Subscription,
    /// 계약의 값. 리전 흐름은 EventBridge 규칙을 읽지 않아서(큐마다 불러야 해서 비싸다) 만들지 않는다
    #[allow(dead_code)]
    Rule,
    Esm,
    Pipe,
    Dlq,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FlowEdge {
    pub from: String,
    pub to: String,
    pub kind: FlowEdgeKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsRegionFlow {
    pub nodes: Vec<FlowNode>,
    pub edges: Vec<FlowEdge>,
    pub gaps: Vec<SqsGap>,
}

/// 엿보기를 할 수 있는가. 안 되면 reason이 이유다
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsPeekable {
    pub allowed: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsMessageAttribute {
    pub name: String,
    pub data_type: String,
    /// 문자열 값, Binary면 base64
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsMessage {
    pub message_id: String,
    pub body: String,
    pub md5: String,
    /// 시스템 속성: SentTimestamp, ApproximateReceiveCount, ApproximateFirstReceiveTimestamp, MessageGroupId, MessageDeduplicationId, SequenceNumber, SenderId, AWSTraceHeader, DeadLetterQueueSourceArn
    pub attributes: HashMap<String, String>,
    pub message_attributes: Vec<SqsMessageAttribute>,
    /// 본문 바이트 수
    pub size: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StoppedReason {
    Max,
    Empty,
}

/// 엿보기 세션. 영수증은 백엔드만 들고 있다
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsPeek {
    pub peek_id: String,
    pub queue_url: String,
    /// 보류가 끝나는 시각(Unix ms)
    pub expires_at: i64,
    pub messages: Vec<SqsMessage>,
    pub stopped_reason: StoppedReason,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SqsChange {
    Receive { max: i64, hold_secs: i64 },
    MoveTask { destination_arn: Option<String>, max_per_second: Option<i64> },
    CancelMoveTask { task_handle: String },
    Resend { peek_id: String, message_ids: Vec<String>, destination_url: String, edits: HashMap<String, String> },
    DeleteMessages { peek_id: String, message_ids: Vec<String> },
    Purge,
}

impl SqsChange {
    /// 기록의 `kind`와 같은 이름
    pub fn kind(&self) -> &'static str {
        match self {
            SqsChange::Receive { .. } => "receive",
            SqsChange::MoveTask { .. } => "moveTask",
            SqsChange::CancelMoveTask { .. } => "cancelMoveTask",
            SqsChange::Resend { .. } => "resend",
            SqsChange::DeleteMessages { .. } => "deleteMessages",
            SqsChange::Purge => "purge",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SqsCall {
    pub api: String,
    pub params: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SqsDiff {
    pub label: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsPreview {
    pub title: String,
    pub calls: Vec<SqsCall>,
    /// 수정 후 재전송의 본문 차이 등
    pub diff: Vec<SqsDiff>,
    pub impact: Vec<String>,
    /// level "block"이면 적용할 수 없다
    pub warnings: Vec<Warning>,
    pub confirm_name: Option<String>,
    pub expected_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SqsItemResult {
    pub id: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsApplyResult {
    pub message: String,
    /// receive일 때만
    pub peek: Option<SqsPeek>,
    /// resend·deleteMessages의 메시지별 결과
    pub items: Vec<SqsItemResult>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsMoveTask {
    pub task_handle: Option<String>,
    /// RUNNING | COMPLETED | CANCELLING | CANCELLED | FAILED
    pub status: String,
    pub source_arn: String,
    pub destination_arn: Option<String>,
    pub max_per_second: Option<i64>,
    pub moved: i64,
    pub to_move: Option<i64>,
    pub failure_reason: Option<String>,
    /// Unix ms
    pub started_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqsChangeRecord {
    pub id: String,
    /// RFC 3339
    pub at: String,
    pub profile: String,
    pub region: String,
    pub queue_url: String,
    pub queue_name: String,
    pub kind: String,
    pub summary: String,
    pub calls: Vec<SqsCall>,
    pub ok: bool,
    pub error: Option<String>,
    /// 메시지 수가 있는 변경(receive·resend·deleteMessages·purge·moveTask)
    pub count: Option<i64>,
}
