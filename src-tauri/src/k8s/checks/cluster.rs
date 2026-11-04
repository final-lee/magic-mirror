//! 클러스터 점검(순수): 엔드포인트, 컨트롤 플레인 로그, Secret 암호화, 버전 지원 기간, aws-auth, 생성자 관리자 권한.
//! 입력은 EKS API에서 읽어 온 값뿐이다(`ClusterFacts`, `VersionSupport`, `AwsAuthFacts`, `AdminEntry`).
use super::versions::{standard_support_end, Source, SECONDS_PER_DAY};
use super::{AdminEntry, AwsAuthFacts, CheckId, ClusterFacts, Finding, Severity, Target, VersionSupport};
use crate::error::AppError;
use crate::iam::clock::iso;
use crate::k8s::access::rbac::Subject;
use crate::k8s::rows::KindRef;

/// 컨트롤 플레인 로그 유형(EKS 이름)
pub const LOG_TYPES: [&str; 5] = ["api", "audit", "authenticator", "controllerManager", "scheduler"];
/// 표준 지원이 끝나기 이 일수 안이면 알린다
pub const SUPPORT_WARNING_DAYS: i64 = 90;
/// 생성자 관리자 후보: access entry가 클러스터를 만들기 이 초 전부터 이 초 뒤까지 만들어졌다(만드는 도중에 EKS가 같이 만든다)
const CREATOR_WINDOW_BEFORE: i64 = 60;
const CREATOR_WINDOW_AFTER: i64 = 300;
/// 증거에 늘어놓는 신원의 최대 수
const LISTED_MAX: usize = 10;

fn cluster_target(c: &ClusterFacts) -> Target {
    Target::Aws { resource: "cluster".into(), name: c.name.clone() }
}

fn open_cidr(cidr: &str) -> bool {
    matches!(cidr, "0.0.0.0/0" | "::/0")
}

fn on_off(on: bool) -> &'static str {
    if on {
        "켬"
    } else {
        "끔"
    }
}

fn public_endpoint(c: &ClusterFacts) -> Option<Finding> {
    if !c.endpoint_public || !(c.public_cidrs.is_empty() || c.public_cidrs.iter().any(|cidr| open_cidr(cidr))) {
        return None;
    }
    let cidrs = if c.public_cidrs.is_empty() { "허용 CIDR 목록이 비어 있어요(모든 IP로 봐요)".to_string() } else { format!("허용 CIDR: {}", c.public_cidrs.join(", ")) };
    Some(Finding::new(
        CheckId::ClusterPublicEndpoint,
        Severity::High,
        cluster_target(c),
        None,
        "API 서버의 퍼블릭 엔드포인트가 모든 IP(0.0.0.0/0)에 열려 있어요",
        vec![cidrs, format!("프라이빗 엔드포인트: {}", on_off(c.endpoint_private))],
    ))
}

fn logging_off(c: &ClusterFacts) -> Option<Finding> {
    let off: Vec<&str> = LOG_TYPES.iter().copied().filter(|t| !c.logging_enabled.iter().any(|e| e == t)).collect();
    if off.is_empty() {
        return None;
    }
    // 누가 무엇을 했는지 남기는 audit·authenticator가 꺼져 있으면 사고 뒤 추적이 안 된다
    let severity = if off.iter().any(|t| matches!(*t, "audit" | "authenticator")) { Severity::Medium } else { Severity::Low };
    Some(Finding::new(
        CheckId::ClusterLoggingOff,
        severity,
        cluster_target(c),
        None,
        format!("컨트롤 플레인 로그 {}가 꺼져 있어요", off.join(", ")),
        vec![format!("꺼진 유형: {}", off.join(", ")), format!("켜진 유형: {}", if c.logging_enabled.is_empty() { "없음".to_string() } else { c.logging_enabled.join(", ") })],
    ))
}

fn secrets_plain(c: &ClusterFacts) -> Option<Finding> {
    if c.secrets_encrypted {
        return None;
    }
    Some(Finding::new(
        CheckId::ClusterSecretsPlain,
        Severity::Medium,
        cluster_target(c),
        None,
        "Secret을 고객 관리 KMS 키로 봉투 암호화하지 않았어요",
        vec!["encryptionConfig에 secrets 리소스가 없어요".into()],
    ))
}

/// 표준 지원 종료까지 남은 일수(내림, 지났으면 음수)
fn days_left(end: i64, now: i64) -> i64 {
    (end - now).div_euclid(SECONDS_PER_DAY)
}

fn version_support(c: &ClusterFacts, versions: &Result<Vec<VersionSupport>, AppError>, now: i64) -> Option<Finding> {
    let api: &[VersionSupport] = versions.as_ref().map(Vec::as_slice).unwrap_or_default();
    let (end, source) = standard_support_end(&c.version, api)?;
    let days = days_left(end, now);
    if days > SUPPORT_WARNING_DAYS {
        return None;
    }
    let (severity, message) = if days < 0 {
        (Severity::High, format!("쿠버네티스 {}의 표준 지원이 {}일 전에 끝났어요(확장 지원은 추가 요금이 붙어요)", c.version, -days))
    } else {
        (Severity::Medium, format!("쿠버네티스 {}의 표준 지원이 {}일 뒤에 끝나요", c.version, days))
    };
    let origin = match source {
        Source::Api => "출처: EKS DescribeClusterVersions",
        Source::Table => "출처: 앱에 넣어 둔 표(AWS 문서의 표준 지원 종료일). EKS API로 읽지 못했거나 이 버전이 응답에 없었어요",
    };
    Some(Finding::new(
        CheckId::ClusterVersionSupport,
        severity,
        cluster_target(c),
        None,
        message,
        vec![format!("클러스터 버전: {}", c.version), format!("표준 지원 종료: {}", iso(end).chars().take(10).collect::<String>()), origin.into()],
    ))
}

/// 클러스터 설정 점검 넷과 버전 점검. `versions`를 읽지 못했으면 고정 표로 대신한다.
pub fn check_cluster(c: &ClusterFacts, versions: &Result<Vec<VersionSupport>, AppError>, now: i64) -> Vec<Finding> {
    [public_endpoint(c), logging_off(c), secrets_plain(c), version_support(c, versions, now)].into_iter().flatten().collect()
}

fn config_map() -> KindRef {
    KindRef { group: String::new(), version: "v1".into(), kind: "ConfigMap".into(), plural: "configmaps".into(), namespaced: true }
}

/// aws-auth ConfigMap으로 실제 쓰이는 신원 매핑이 있다
pub fn check_aws_auth(a: &AwsAuthFacts) -> Vec<Finding> {
    if a.entries.is_empty() {
        return vec![];
    }
    // 노드 역할(`system:nodes`)만이면 옛 노드그룹의 흔적이라 덜 급하다
    let only_nodes = a.entries.iter().all(|e| e.groups.iter().any(|g| g == "system:nodes"));
    let mut evidence = vec![format!("인증 모드: {}", a.mode.as_deref().unwrap_or("CONFIG_MAP"))];
    evidence.extend(a.entries.iter().take(LISTED_MAX).map(|e| format!("{} → {}", e.arn, if e.groups.is_empty() { "그룹 없음".to_string() } else { e.groups.join(", ") })));
    if a.entries.len() > LISTED_MAX {
        evidence.push(format!("…외 {}개", a.entries.len() - LISTED_MAX));
    }
    vec![Finding::new(
        CheckId::ClusterAwsAuth,
        if only_nodes { Severity::Low } else { Severity::Medium },
        Target::Object { kind: config_map(), namespace: Some("kube-system".into()), name: "aws-auth".into() },
        None,
        format!("aws-auth ConfigMap이 신원 {}개를 매핑하고 있어요(access entry로 옮기는 것이 안전해요)", a.entries.len()),
        evidence,
    )]
}

/// 클러스터를 만든 신원에게 준 관리자 권한(bootstrap access entry)이 남아 있어 보인다
pub fn check_creator_admin(c: &ClusterFacts, entries: &[AdminEntry]) -> Vec<Finding> {
    let Some(created) = c.created_at else { return vec![] };
    entries
        .iter()
        .filter_map(|e| {
            let at = e.created_at?;
            if at < created - CREATOR_WINDOW_BEFORE || at > created + CREATOR_WINDOW_AFTER {
                return None;
            }
            Some(Finding::new(
                CheckId::ClusterCreatorAdmin,
                Severity::Medium,
                Target::Subject { subject: Subject::iam(&e.principal_arn) },
                None,
                "클러스터를 만든 신원에게 준 관리자 권한(bootstrap)이 남아 있는 것으로 보여요",
                vec![
                    format!("access entry: {}", e.principal_arn),
                    "정책: AmazonEKSClusterAdminPolicy(클러스터 전체)".into(),
                    format!("access entry 생성: {}", iso(at)),
                    format!("클러스터 생성: {}", iso(created)),
                    "추정: 만든 시각이 클러스터와 같아요(EKS는 만든 신원을 따로 알려 주지 않아요)".into(),
                ],
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests;
