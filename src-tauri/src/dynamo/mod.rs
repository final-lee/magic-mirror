//! DynamoDB 워크스페이스. 타입은 `src/dynamo/types.ts`와 같은 모양(serde camelCase)이고, 명령은 `dynamo_commands`가 이 모듈의 함수를 부른다.
//! 테이블 해석과 읽기는 `read`(리소스 목록 어댑터도 같은 해석 함수를 쓴다), CloudWatch 지표는 `metrics`, 건강 진단은 `health`(순수),
//! AttributeValue ↔ DynamoDB JSON은 `attr`(아이템을 다루는 단계가 쓴다).

// 아이템을 읽고 쓰는 단계(D2·D4)가 쓴다. 그 전까지는 시험만 부른다
#[allow(dead_code)]
pub mod attr;
pub mod change;
pub mod expr;
pub mod items;
pub mod health;
pub mod metrics;
pub mod ops;
pub mod read;
pub mod connections;
pub mod stream;
#[cfg(test)]
mod connection_tests;

use std::collections::BTreeMap;

use serde::Serialize;

/// 키 속성 하나: 이름과 타입(`S`·`N`·`B`)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyAttr {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Keys {
    pub pk: KeyAttr,
    pub sk: Option<KeyAttr>,
}

/// 인덱스 프로젝션: `ALL` · `KEYS_ONLY` · `INCLUDE`(포함 속성이 `attrs`)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    #[serde(rename = "type")]
    pub kind: String,
    pub attrs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexKind {
    Gsi,
    Lsi,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub name: String,
    pub kind: IndexKind,
    pub pk: KeyAttr,
    pub sk: Option<KeyAttr>,
    pub projection: Projection,
    /// `ACTIVE` · `CREATING` · `UPDATING` · `DELETING`. LSI는 항상 `ACTIVE`
    pub status: String,
    pub backfilling: bool,
    /// 프로비저닝 테이블의 GSI만
    pub read: Option<i64>,
    pub write: Option<i64>,
    pub item_count: i64,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BillingMode {
    OnDemand,
    Provisioned,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Billing {
    pub mode: BillingMode,
    pub read: Option<i64>,
    pub write: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Dimension {
    Read,
    Write,
}

/// Application Auto Scaling 대상 하나(테이블 또는 GSI의 읽기·쓰기 한쪽)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScalingTarget {
    /// GSI 이름. 테이블 자체면 None
    pub index: Option<String>,
    pub dimension: Dimension,
    pub min: i64,
    pub max: i64,
    /// 목표 추적 정책의 목표 사용률(%). 정책이 없으면 None
    pub target_utilization: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ttl {
    /// `ENABLED` · `DISABLED` · `ENABLING` · `DISABLING`
    pub status: String,
    pub attribute: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pitr {
    /// `ENABLED` · `DISABLED`
    pub status: String,
    pub days: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSpec {
    pub arn: String,
    pub view_type: String,
}

/// 암호화: `OWNED`는 DynamoDB 소유 키(기본), `KMS`는 KMS 키(`kms_key`가 ARN)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sse {
    #[serde(rename = "type")]
    pub kind: String,
    pub kms_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replica {
    pub region: String,
    pub status: String,
    pub class: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FindingLevel {
    Fail,
    Warn,
    Info,
}

/// 진단 규칙 id. 단계마다 늘어난다(스트림·연결 규칙은 D5)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingId {
    Throttled,
    GsiBackpressure,
    IndexNotActive,
    UnderProvisioned,
    OverProvisioned,
    NoAutoScaling,
    PitrOff,
    DeletionProtectionOff,
    ReplicaUnhealthy,
    ReplicationLag,
    StreamNoConsumer,
    EsmDisabled,
    IteratorAge,
    EsmNoOnFailure,
}

/// 건강 진단 한 줄. 문구는 백엔드가 만든다
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: FindingId,
    pub level: FindingLevel,
    pub summary: String,
    pub detail: Option<String>,
    /// 지적이 가리키는 GSI 이름. 테이블 전체면 None
    pub index: Option<String>,
}

/// 테이블 하나. `ttl`·`pitr`·`scaling`·`contributor_insights`·`resource_policy`가 None이면 그 부분을 읽지 못한 것이다(`gaps`)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamoTable {
    pub name: String,
    pub arn: String,
    /// `ACTIVE` · `CREATING` · `UPDATING` · `DELETING` · …
    pub status: String,
    pub keys: Keys,
    /// 정의된 속성(키·인덱스 키)의 이름 → 타입
    pub attribute_types: BTreeMap<String, String>,
    pub indexes: Vec<Index>,
    pub billing: Billing,
    pub scaling: Option<Vec<ScalingTarget>>,
    /// `STANDARD` · `STANDARD_INFREQUENT_ACCESS`
    pub class: String,
    pub ttl: Option<Ttl>,
    pub pitr: Option<Pitr>,
    pub deletion_protection: bool,
    pub stream: Option<StreamSpec>,
    pub sse: Sse,
    pub replicas: Vec<Replica>,
    /// `ENABLED` · `DISABLED` · `ENABLING` · `DISABLING` · `FAILED`
    pub contributor_insights: Option<String>,
    pub resource_policy: Option<bool>,
    pub item_count: i64,
    pub size_bytes: i64,
    /// Unix ms
    pub created_at: Option<i64>,
    pub findings: Vec<Finding>,
    /// 테이블 설명을 읽지 못했다(권한 없음 등). 그때 나머지 값은 비어 있다
    pub error: Option<String>,
}

/// 읽지 못한 부분(권한 없음 등). `section`은 `ttl` · `pitr` · `contributorInsights` · `resourcePolicy` · `autoscaling` · `metrics`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub section: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamoOverview {
    pub tables: Vec<DynamoTable>,
    pub truncated: bool,
    pub gaps: Vec<Gap>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TopKeyKind {
    Accessed,
    Throttled,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopKeyEntry {
    /// 파티션 키 값(정렬 키까지 보는 규칙이면 그 값이 이어서 온다)
    pub keys: Vec<String>,
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopKeyGroup {
    pub kind: TopKeyKind,
    /// 정렬 키까지 묶은 규칙인가
    pub with_sort_key: bool,
    pub entries: Vec<TopKeyEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopKeys {
    pub window_secs: i64,
    pub groups: Vec<TopKeyGroup>,
}

/// 건강 진단이 읽는 지표(`metrics`가 만든다). 값은 한 테이블 또는 GSI 하나의 것
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Capacity {
    /// 최근 24시간 소비 최댓값(분당 합 / 60, 초당 단위)
    pub peak_consumed: f64,
    /// 같은 시각의 프로비저닝 대비 소비 비율 중 최댓값. 프로비저닝 지표와 시각이 맞는 점이 없으면 None
    pub peak_utilization: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct UsageMetrics {
    /// 최근 1시간 합
    pub read_throttle: f64,
    pub write_throttle: f64,
    /// 프로비저닝 테이블/GSI만 읽는다(온디맨드는 None)
    pub read: Option<Capacity>,
    pub write: Option<Capacity>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct TableMetrics {
    pub table: UsageMetrics,
    /// GSI 이름 → 지표
    pub indexes: BTreeMap<String, UsageMetrics>,
}

#[cfg(test)]
impl DynamoTable {
    /// 시험용 기본 테이블: 온디맨드, 파티션 키 `id`(S), 인덱스 없음, PITR·삭제 보호 켬, 모든 부분을 읽었음
    pub fn fixture(name: &str) -> DynamoTable {
        DynamoTable {
            name: name.to_string(),
            arn: format!("arn:aws:dynamodb:ap-northeast-2:111111111111:table/{name}"),
            status: "ACTIVE".to_string(),
            keys: Keys { pk: KeyAttr { name: "id".into(), kind: "S".into() }, sk: None },
            attribute_types: BTreeMap::from([("id".to_string(), "S".to_string())]),
            indexes: vec![],
            billing: Billing { mode: BillingMode::OnDemand, read: None, write: None },
            scaling: Some(vec![]),
            class: "STANDARD".to_string(),
            ttl: Some(Ttl { status: "DISABLED".into(), attribute: None }),
            pitr: Some(Pitr { status: "ENABLED".into(), days: Some(35) }),
            deletion_protection: true,
            stream: None,
            sse: Sse { kind: "OWNED".into(), kms_key: None },
            replicas: vec![],
            contributor_insights: Some("DISABLED".into()),
            resource_policy: Some(false),
            item_count: 0,
            size_bytes: 0,
            created_at: None,
            findings: vec![],
            error: None,
        }
    }

    /// 프로비저닝으로 바꾼다
    pub fn provisioned(mut self, read: i64, write: i64) -> DynamoTable {
        self.billing = Billing { mode: BillingMode::Provisioned, read: Some(read), write: Some(write) };
        self
    }

    /// GSI를 하나 더한다(프로비저닝 테이블이면 `capacity`로 읽기·쓰기 용량을 준다)
    pub fn with_gsi(mut self, name: &str, capacity: Option<(i64, i64)>) -> DynamoTable {
        self.indexes.push(Index {
            name: name.to_string(),
            kind: IndexKind::Gsi,
            pk: KeyAttr { name: "gpk".into(), kind: "S".into() },
            sk: None,
            projection: Projection { kind: "ALL".into(), attrs: vec![] },
            status: "ACTIVE".into(),
            backfilling: false,
            read: capacity.map(|c| c.0),
            write: capacity.map(|c| c.1),
            item_count: 0,
            size_bytes: 0,
        });
        self
    }
}
