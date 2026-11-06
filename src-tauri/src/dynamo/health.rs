//! 테이블 건강 진단(순수). 입력이 없는 규칙은 건너뛴다. 결과는 실패 → 주의 → 정보 순이고, 같은 수준은 규칙 표 순서다.
//! 스트림·연결 규칙(D5)은 `HealthInput`에 연결 정보를 더해 이어 붙인다.

use super::{Billing, BillingMode, Capacity, Dimension, DynamoTable, Finding, FindingId, FindingLevel, Index, IndexKind, ScalingTarget, TableMetrics, UsageMetrics};

/// 최근 1시간 스로틀 합이 이 값 이상이면 실패, 0보다 크면 주의
pub const THROTTLE_FAIL: f64 = 100.0;
/// 프로비저닝 대비 소비 최댓값이 이 비율 이상이면 부족 주의
pub const UNDER_RATIO: f64 = 0.8;
/// 이 비율 미만이면 과다 정보
pub const OVER_RATIO: f64 = 0.2;

/// 진단에 필요한 것 모두. 읽지 못한 입력은 None이고 그 입력이 필요한 규칙은 건너뛴다
pub struct HealthInput<'a> {
    pub table: &'a DynamoTable,
    /// Application Auto Scaling 대상. None이면 읽지 못한 것이다
    pub scaling: Option<&'a [ScalingTarget]>,
    pub metrics: Option<&'a TableMetrics>,
}

fn finding(id: FindingId, level: FindingLevel, index: Option<&str>, summary: String, detail: Option<String>) -> Finding {
    Finding { id, level, summary, detail, index: index.map(str::to_string) }
}

/// 테이블 또는 GSI를 가리키는 말
fn subject(index: Option<&str>) -> String {
    match index {
        Some(name) => format!("인덱스 `{name}`"),
        None => "테이블".to_string(),
    }
}

fn count(n: f64) -> String {
    format!("{}", n.round() as i64)
}

fn percent(ratio: f64) -> String {
    format!("{}%", (ratio * 100.0).round() as i64)
}

fn per_sec(n: f64) -> String {
    if n >= 10.0 {
        format!("{}", n.round() as i64)
    } else {
        format!("{n:.1}")
    }
}

fn dimension_label(d: Dimension) -> &'static str {
    match d {
        Dimension::Read => "읽기",
        Dimension::Write => "쓰기",
    }
}

fn status_label(status: &str) -> &'static str {
    match status {
        "CREATING" => "만드는 중",
        "UPDATING" => "바꾸는 중",
        "DELETING" => "지우는 중",
        _ => "활성",
    }
}

fn is_production(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("prod") || lower.contains("prd")
}

/// 프로비저닝 용량을 가진 대상 하나(테이블 또는 GSI)
struct Resource<'a> {
    index: Option<&'a str>,
    read: i64,
    write: i64,
    metrics: Option<&'a UsageMetrics>,
}

fn provisioned_resources<'a>(table: &'a DynamoTable, metrics: Option<&'a TableMetrics>) -> Vec<Resource<'a>> {
    let Billing { mode: BillingMode::Provisioned, read, write } = &table.billing else {
        return vec![];
    };
    let mut out = vec![Resource { index: None, read: read.unwrap_or(0), write: write.unwrap_or(0), metrics: metrics.map(|m| &m.table) }];
    for i in table.indexes.iter().filter(|i| i.kind == IndexKind::Gsi) {
        if let (Some(read), Some(write)) = (i.read, i.write) {
            out.push(Resource { index: Some(&i.name), read, write, metrics: metrics.and_then(|m| m.indexes.get(&i.name)) });
        }
    }
    out
}

fn scaling_of<'a>(scaling: &'a [ScalingTarget], index: Option<&str>, dimension: Dimension) -> Option<&'a ScalingTarget> {
    scaling.iter().find(|s| s.index.as_deref() == index && s.dimension == dimension)
}

/// 방향별 (프로비저닝, 용량 지표)
fn directions(r: &Resource<'_>) -> [(Dimension, i64, Option<Capacity>); 2] {
    [(Dimension::Read, r.read, r.metrics.and_then(|m| m.read)), (Dimension::Write, r.write, r.metrics.and_then(|m| m.write))]
}

/// 같은 시각의 프로비저닝 대비 사용률. 시각이 맞는 점이 없으면 지금 프로비저닝 기준으로 본다
fn utilization(cap: &Capacity, provisioned: i64) -> f64 {
    cap.peak_utilization.unwrap_or(cap.peak_consumed / provisioned as f64)
}

fn index_state(i: &Index) -> Option<String> {
    let transitioning = matches!(i.status.as_str(), "CREATING" | "UPDATING" | "DELETING");
    match (transitioning, i.backfilling) {
        (true, true) => Some(format!("{}이고 기존 아이템을 채우는 중", status_label(&i.status))),
        (true, false) => Some(status_label(&i.status).to_string()),
        (false, true) => Some("기존 아이템을 채우는 중".to_string()),
        (false, false) => None,
    }
}

/// 테이블 하나의 진단
pub fn health(input: &HealthInput<'_>) -> Vec<Finding> {
    let table = input.table;
    if table.error.is_some() {
        return vec![];
    }
    let mut out = Vec::new();

    if let Some(m) = input.metrics {
        let subjects = std::iter::once((None, &m.table)).chain(table.indexes.iter().filter(|i| i.kind == IndexKind::Gsi).filter_map(|i| m.indexes.get(&i.name).map(|u| (Some(i.name.as_str()), u))));
        let subjects: Vec<_> = subjects.collect();

        // throttled
        for (index, u) in &subjects {
            let total = u.read_throttle + u.write_throttle;
            let level = if total >= THROTTLE_FAIL {
                FindingLevel::Fail
            } else if total > 0.0 {
                FindingLevel::Warn
            } else {
                continue;
            };
            out.push(finding(
                FindingId::Throttled,
                level,
                *index,
                format!("{} 최근 1시간 동안 {}건이 스로틀됐어요(읽기 {}, 쓰기 {})", subject(*index), count(total), count(u.read_throttle), count(u.write_throttle)),
                Some("요청이 용량을 넘어 거절된 횟수예요. 용량을 늘리거나 특정 키에 몰리는 접근을 나눠 주세요".into()),
            ));
        }

        // gsiBackpressure
        for (index, u) in &subjects {
            let Some(name) = index else { continue };
            if u.write_throttle > 0.0 {
                out.push(finding(
                    FindingId::GsiBackpressure,
                    FindingLevel::Fail,
                    *index,
                    format!("인덱스 `{name}`이 쓰기를 따라가지 못해요({}건 스로틀)", count(u.write_throttle)),
                    Some("GSI가 밀리면 원본 테이블의 쓰기도 함께 스로틀돼요. 이 인덱스의 쓰기 용량을 늘려 주세요".into()),
                ));
            }
        }
    }

    // indexNotActive
    for i in table.indexes.iter().filter(|i| i.kind == IndexKind::Gsi) {
        if let Some(state) = index_state(i) {
            out.push(finding(
                FindingId::IndexNotActive,
                FindingLevel::Info,
                Some(&i.name),
                format!("인덱스 `{}`이 {state}이에요", i.name),
                Some("끝나기 전에는 이 인덱스로 조회하거나 설정을 바꿀 수 없을 수 있어요".into()),
            ));
        }
    }

    let resources = provisioned_resources(table, input.metrics);

    // underProvisioned
    for r in &resources {
        let hot: Vec<(Dimension, f64)> = directions(r)
            .into_iter()
            .filter(|(_, provisioned, _)| *provisioned > 0)
            .filter_map(|(d, provisioned, cap)| cap.map(|c| (d, utilization(&c, provisioned))))
            .filter(|(_, u)| *u >= UNDER_RATIO)
            .collect();
        if hot.is_empty() {
            continue;
        }
        let labels: Vec<String> = hot.iter().map(|(d, u)| format!("{} {}", dimension_label(*d), percent(*u))).collect();
        out.push(finding(
            FindingId::UnderProvisioned,
            FindingLevel::Warn,
            r.index,
            format!("{} 최근 24시간 사용량이 프로비저닝의 {} 이상이에요({})", subject(r.index), percent(UNDER_RATIO), labels.join(", ")),
            Some("한도에 가까워 요청이 몰리면 스로틀될 수 있어요. 프로비저닝이나 오토스케일링 최댓값을 늘리는 것을 살펴보세요".into()),
        ));
    }

    // overProvisioned: 오토스케일링 최소값이 기준보다 크면 그 최소값 아래로는 내려갈 수 없으니 최소값 기준이다
    for r in &resources {
        let mut idle: Vec<String> = Vec::new();
        for (d, provisioned, cap) in directions(r) {
            let Some(cap) = cap else { continue };
            if provisioned <= 0 {
                continue;
            }
            let floor = input.scaling.and_then(|s| scaling_of(s, r.index, d)).map(|s| s.min as f64);
            let threshold = (provisioned as f64 * OVER_RATIO).max(floor.unwrap_or(0.0));
            if cap.peak_consumed < threshold {
                idle.push(format!("{} 최대 {}/초, 기준 {}/초", dimension_label(d), per_sec(cap.peak_consumed), per_sec(threshold)));
            }
        }
        if idle.is_empty() {
            continue;
        }
        out.push(finding(
            FindingId::OverProvisioned,
            FindingLevel::Info,
            r.index,
            format!("{} 최근 24시간 사용량이 프로비저닝의 {} 미만이에요({})", subject(r.index), percent(OVER_RATIO), idle.join(", ")),
            Some("프로비저닝을 줄이거나 오토스케일링 최소값을 낮추면 비용을 아낄 수 있어요. 오토스케일링 최소값이 더 크면 그 값이 기준이에요".into()),
        ));
    }

    // noAutoScaling
    if let Some(scaling) = input.scaling {
        for r in &resources {
            if scaling.iter().all(|s| s.index.as_deref() != r.index) {
                out.push(finding(
                    FindingId::NoAutoScaling,
                    FindingLevel::Warn,
                    r.index,
                    format!("프로비저닝 {}에 오토스케일링이 없어요", subject(r.index)),
                    Some("트래픽이 늘면 용량이 고정돼 스로틀될 수 있어요. Application Auto Scaling을 연결하거나 온디맨드 모드를 고려해 보세요".into()),
                ));
            }
        }
    }

    // pitrOff
    if table.pitr.as_ref().is_some_and(|p| p.status == "DISABLED") {
        out.push(finding(
            FindingId::PitrOff,
            FindingLevel::Warn,
            None,
            "특정 시점 복구(PITR)가 꺼져 있어요".to_string(),
            Some("실수로 지우거나 덮어쓴 데이터를 시점으로 되돌릴 수 없어요".into()),
        ));
    }

    // deletionProtectionOff
    if !table.deletion_protection {
        let prod = is_production(&table.name);
        out.push(finding(
            FindingId::DeletionProtectionOff,
            if prod { FindingLevel::Warn } else { FindingLevel::Info },
            None,
            "삭제 보호가 꺼져 있어요".to_string(),
            Some(if prod { "이름에 prod가 들어 있어 운영 테이블로 보여요. 실수로 테이블을 지우지 않도록 켜 두는 것을 권해요" } else { "실수로 테이블을 지우는 것을 막아 주는 설정이에요" }.into()),
        ));
    }

    // replicaUnhealthy
    for replica in table.replicas.iter().filter(|r| r.status != "ACTIVE") {
        out.push(finding(
            FindingId::ReplicaUnhealthy,
            FindingLevel::Fail,
            None,
            format!("글로벌 테이블 복제본 {}이 {} 상태예요", replica.region, replica.status),
            Some("활성이 아닌 복제본은 쓰기를 받아 가지 못할 수 있어요. 복제본 리전의 콘솔에서 원인을 확인해 주세요".into()),
        ));
    }

    // 실패 → 주의 → 정보. 같은 수준은 위에서 만든 규칙 순서를 지킨다
    out.sort_by_key(|f| match f.level {
        FindingLevel::Fail => 0,
        FindingLevel::Warn => 1,
        FindingLevel::Info => 2,
    });
    out
}

#[cfg(test)]
mod tests;
