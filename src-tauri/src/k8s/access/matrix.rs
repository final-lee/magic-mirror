//! 권한 표(주체 × 네임스페이스)의 칸 정의와 계산(순수). 칸은 엔진의 `Grant` 위에서 "대표 요청"(probe) 몇 개가 허용되는지로 정한다.
//!
//! 칸은 세 단계다: `Full`(대표 요청을 모두 이름 지정 없이 할 수 있다), `Partial`(일부만 되거나, `resourceNames`로 정해진 이름에만 된다), `None`.
//! 네임스페이스 열은 그 네임스페이스의 요청으로 계산하고(ClusterRoleBinding으로 받은 권한 포함), 네임스페이스가 없는 열("클러스터 전체")은 클러스터 범위 요청으로 계산한다(ClusterRoleBinding 권한만).
//!
//! | 칸 | 대표 요청 | Full | Partial |
//! |---|---|---|---|
//! | 읽기 | 워크로드·설정 10종(pods, services, configmaps, persistentvolumeclaims, deployments, statefulsets, daemonsets, jobs, cronjobs, ingresses) × get·list·watch | 30개 모두 | 하나라도(이름 한정 포함) |
//! | 쓰기 | 같은 10종 × create·update·patch | 30개 모두 | 하나라도 |
//! | 삭제 | 같은 10종 × delete·deletecollection | 20개 모두 | 하나라도 |
//! | exec·attach·port-forward | pods/exec, pods/attach, pods/portforward 의 create | 셋 모두 | 하나라도 |
//! | Secret 읽기 | secrets × get·list·watch | 셋 모두 | 하나라도 |
//! | RBAC 변경 | roles·rolebindings(클러스터 열은 clusterroles·clusterrolebindings도) × create·update·patch·delete | 모두 | 하나라도 |
//! | 권한 상승 가능 | 직접: roles·clusterroles의 escalate·bind, users·groups·serviceaccounts의 impersonate, serviceaccounts/token create, nodes/proxy get·create. 간접: pods·deployments·statefulsets·daemonsets·jobs·cronjobs create(Pod를 만들어 다른 SA 토큰을 쓴다), secrets get·list(토큰 읽기) | 직접 하나라도 | 간접 하나라도(직접은 이름 한정만) |
use serde::{Deserialize, Serialize};

use super::engine::{Evaluation, Grant, Names, Query};
use super::rbac::{Subject, SubjectKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cell {
    Read,
    Write,
    Delete,
    Exec,
    SecretRead,
    RbacWrite,
    Escalate,
}

/// 표의 칸 순서
pub const CELLS: [Cell; 7] = [Cell::Read, Cell::Write, Cell::Delete, Cell::Exec, Cell::SecretRead, Cell::RbacWrite, Cell::Escalate];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    None = 0,
    Partial = 1,
    Full = 2,
}

/// 대표 요청 하나. `cluster_scoped`면 네임스페이스 열에서도 클러스터 범위로 묻는다(Namespace·ClusterRole처럼 네임스페이스가 없는 리소스).
#[derive(Debug, Clone, Copy)]
struct Probe {
    verb: &'static str,
    group: &'static str,
    resource: &'static str,
    sub: Option<&'static str>,
    cluster_scoped: bool,
    /// 권한 상승 칸에서 직접 경로인지
    direct: bool,
}

const fn p(verb: &'static str, group: &'static str, resource: &'static str) -> Probe {
    Probe { verb, group, resource, sub: None, cluster_scoped: false, direct: true }
}

const WORKLOADS: [(&str, &str); 10] = [
    ("", "pods"),
    ("", "services"),
    ("", "configmaps"),
    ("", "persistentvolumeclaims"),
    ("apps", "deployments"),
    ("apps", "statefulsets"),
    ("apps", "daemonsets"),
    ("batch", "jobs"),
    ("batch", "cronjobs"),
    ("networking.k8s.io", "ingresses"),
];
const RBAC: &str = "rbac.authorization.k8s.io";

fn across(verbs: &[&'static str], resources: &[(&'static str, &'static str)]) -> Vec<Probe> {
    resources.iter().flat_map(|(group, resource)| verbs.iter().map(move |verb| p(verb, group, resource))).collect()
}

fn probes(cell: Cell, cluster_column: bool) -> Vec<Probe> {
    match cell {
        Cell::Read => across(&["get", "list", "watch"], &WORKLOADS),
        Cell::Write => across(&["create", "update", "patch"], &WORKLOADS),
        Cell::Delete => across(&["delete", "deletecollection"], &WORKLOADS),
        Cell::Exec => ["exec", "attach", "portforward"].into_iter().map(|sub| Probe { sub: Some(sub), ..p("create", "", "pods") }).collect(),
        Cell::SecretRead => across(&["get", "list", "watch"], &[("", "secrets")]),
        Cell::RbacWrite => {
            let verbs = ["create", "update", "patch", "delete"];
            let mut out = across(&verbs, &[(RBAC, "roles"), (RBAC, "rolebindings")]);
            if cluster_column {
                out.extend(across(&verbs, &[(RBAC, "clusterroles"), (RBAC, "clusterrolebindings")]).into_iter().map(|probe| Probe { cluster_scoped: true, ..probe }));
            }
            out
        }
        Cell::Escalate => {
            let mut out = vec![
                Probe { cluster_scoped: true, ..p("escalate", RBAC, "clusterroles") },
                Probe { cluster_scoped: true, ..p("bind", RBAC, "clusterroles") },
                p("escalate", RBAC, "roles"),
                p("bind", RBAC, "roles"),
                Probe { cluster_scoped: true, ..p("impersonate", "", "users") },
                Probe { cluster_scoped: true, ..p("impersonate", "", "groups") },
                p("impersonate", "", "serviceaccounts"),
                Probe { sub: Some("token"), ..p("create", "", "serviceaccounts") },
                Probe { sub: Some("proxy"), cluster_scoped: true, ..p("get", "", "nodes") },
                Probe { sub: Some("proxy"), cluster_scoped: true, ..p("create", "", "nodes") },
            ];
            let indirect: Vec<Probe> = across(&["create"], &[("", "pods"), ("apps", "deployments"), ("apps", "statefulsets"), ("apps", "daemonsets"), ("batch", "jobs"), ("batch", "cronjobs")])
                .into_iter()
                .chain(across(&["get", "list"], &[("", "secrets")]))
                .map(|probe| Probe { direct: false, ..probe })
                .collect();
            out.extend(indirect);
            out
        }
    }
}

fn query_of(probe: &Probe, namespace: Option<&str>) -> Query {
    let mut q = Query::new(probe.verb, probe.group, probe.resource);
    q.subresource = probe.sub.map(str::to_string);
    q.namespace = if probe.cluster_scoped { None } else { namespace.map(str::to_string) };
    q
}

fn any(grants: &[Grant], q: &Query, names: Names) -> bool {
    grants.iter().any(|g| g.matches(q, names))
}

/// 칸 하나의 단계. `namespace`가 None이면 클러스터 전체 열.
pub fn level(grants: &[Grant], cell: Cell, namespace: Option<&str>) -> Level {
    let list = probes(cell, namespace.is_none());
    if cell == Cell::Escalate {
        let direct_strict = list.iter().filter(|x| x.direct).any(|x| any(grants, &query_of(x, namespace), Names::Strict));
        if direct_strict {
            return Level::Full;
        }
        let partial = list.iter().any(|x| if x.direct { any(grants, &query_of(x, namespace), Names::Ignore) } else { any(grants, &query_of(x, namespace), Names::Strict) });
        return if partial { Level::Partial } else { Level::None };
    }
    let mut all = true;
    let mut some = false;
    for probe in &list {
        let q = query_of(probe, namespace);
        if any(grants, &q, Names::Strict) {
            some = true;
        } else {
            all = false;
            some = some || any(grants, &q, Names::Ignore);
        }
    }
    match (all, some) {
        (true, _) => Level::Full,
        (false, true) => Level::Partial,
        _ => Level::None,
    }
}

/// 한 주체의 한 열 일곱 칸(`CELLS` 순서)
pub fn levels(grants: &[Grant], namespace: Option<&str>) -> Vec<u8> {
    CELLS.iter().map(|c| level(grants, *c, namespace) as u8).collect()
}

/// 대표 요청 하나의 결과
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub query: Query,
    /// 이름 지정 없이 할 수 있다
    pub allowed: bool,
    /// 이름이 정해진 권한(`resourceNames`)만 있다
    pub names_only: bool,
    pub direct: bool,
    /// 이 요청에 맞는 권한과 경로(이름 한정 포함)
    pub grants: Vec<Grant>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellDetail {
    pub subject: Subject,
    pub namespace: Option<String>,
    pub cell: Cell,
    pub level: u8,
    pub probes: Vec<ProbeResult>,
}

pub fn cell_detail(eval: &Evaluation, subject: &Subject, cell: Cell, namespace: Option<&str>) -> CellDetail {
    let rules = eval.rules_of(subject);
    let results = probes(cell, namespace.is_none())
        .iter()
        .map(|probe| {
            let query = query_of(probe, namespace);
            let matching: Vec<Grant> = rules.grants.iter().filter(|g| g.matches(&query, Names::Ignore)).cloned().collect();
            let allowed = rules.grants.iter().any(|g| g.matches(&query, Names::Strict));
            ProbeResult { query, allowed, names_only: !allowed && !matching.is_empty(), direct: probe.direct, grants: matching }
        })
        .collect();
    CellDetail { subject: subject.clone(), namespace: namespace.map(str::to_string), cell, level: level(&rules.grants, cell, namespace) as u8, probes: results }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixQuery {
    /// 비면 모든 종류
    #[serde(default)]
    pub kinds: Vec<SubjectKind>,
    /// 이름·네임스페이스·라벨에 들어 있는 글(대소문자 무시)
    #[serde(default)]
    pub text: String,
    /// 열: None은 클러스터 전체
    pub namespaces: Vec<Option<String>>,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRow {
    pub subject: Subject,
    pub label: Option<String>,
    /// 열마다 일곱 칸(`CELLS` 순서, 0·1·2)
    pub levels: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixPage {
    /// 필터에 맞는 주체 수(쪽 나누기 전)
    pub total: usize,
    pub rows: Vec<MatrixRow>,
}

fn rank(kind: SubjectKind) -> u8 {
    match kind {
        SubjectKind::Iam => 0,
        SubjectKind::User => 1,
        SubjectKind::Group => 2,
        SubjectKind::ServiceAccount => 3,
    }
}

/// 표 한 쪽. 정렬: 내장(`system:`)이 아닌 것 먼저, IAM → 사용자 → 그룹 → ServiceAccount, 이름 순. 칸은 이 쪽의 행에 대해서만 계산한다.
pub fn matrix_page(eval: &Evaluation, q: &MatrixQuery) -> MatrixPage {
    let text = q.text.trim().to_lowercase();
    let mut picked: Vec<_> = eval
        .subjects()
        .iter()
        .filter(|s| q.kinds.is_empty() || q.kinds.contains(&s.subject.kind))
        .filter(|s| {
            text.is_empty()
                || s.subject.name.to_lowercase().contains(&text)
                || s.subject.namespace.as_deref().is_some_and(|n| n.to_lowercase().contains(&text))
                || s.label.as_deref().is_some_and(|l| l.to_lowercase().contains(&text))
        })
        .collect();
    picked.sort_by(|a, b| {
        let system = |s: &&super::engine::SubjectRules| s.subject.name.starts_with("system:");
        (system(a), rank(a.subject.kind), &a.subject.namespace, &a.subject.name).cmp(&(system(b), rank(b.subject.kind), &b.subject.namespace, &b.subject.name))
    });
    let total = picked.len();
    let rows = picked
        .into_iter()
        .skip(q.offset)
        .take(q.limit)
        .map(|s| MatrixRow {
            subject: s.subject.clone(),
            label: s.label.clone(),
            levels: q.namespaces.iter().map(|ns| levels(&s.grants, ns.as_deref())).collect(),
        })
        .collect();
    MatrixPage { total, rows }
}

#[cfg(test)]
mod tests;
