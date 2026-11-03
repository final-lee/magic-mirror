//! 쿠버네티스 버전의 표준 지원 종료일. EKS `DescribeClusterVersions`의 값을 먼저 쓰고, 읽지 못했거나 그 버전이 없으면 아래 고정 표를 쓴다.
use super::VersionSupport;

/// 표준 지원 종료일 고정 표(`연, 월, 일`, UTC). 출처: AWS 문서 "Amazon EKS Kubernetes versions"의 표준 지원 종료일(문서 확인 시점 이후의 버전은 없다).
/// 새 버전이 나오면 API가 알려 주므로, 표는 API를 읽지 못했을 때의 대비일 뿐이다.
const STANDARD_SUPPORT_END: [(&str, (i64, i64, i64)); 11] = [
    ("1.23", (2023, 10, 11)),
    ("1.24", (2024, 1, 31)),
    ("1.25", (2024, 5, 1)),
    ("1.26", (2024, 6, 11)),
    ("1.27", (2024, 7, 24)),
    ("1.28", (2024, 11, 26)),
    ("1.29", (2025, 3, 23)),
    ("1.30", (2025, 7, 23)),
    ("1.31", (2025, 11, 26)),
    ("1.32", (2026, 3, 23)),
    ("1.33", (2026, 7, 29)),
];

pub const SECONDS_PER_DAY: i64 = 86_400;

/// 그레고리력 날짜의 UTC 0시(epoch 초). Howard Hinnant의 `days_from_civil`.
pub fn epoch_of(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe - 719_468) * SECONDS_PER_DAY
}

/// 종료일을 어디서 얻었는지
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Api,
    Table,
}

/// 이 버전의 표준 지원 종료일(epoch 초)과 출처. 둘 다 모르면 None.
pub fn standard_support_end(version: &str, api: &[VersionSupport]) -> Option<(i64, Source)> {
    if let Some(end) = api.iter().find(|v| v.version == version).and_then(|v| v.end_of_standard_support) {
        return Some((end, Source::Api));
    }
    STANDARD_SUPPORT_END.iter().find(|(v, _)| *v == version).map(|(_, (y, m, d))| (epoch_of(*y, *m, *d), Source::Table))
}

#[cfg(test)]
mod tests;
