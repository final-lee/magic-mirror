//! 두 RBAC 시점 사이에서 누가 무엇을 얻고 잃는지(순수). 이후 단계(RBAC 변경 미리보기)가 쓴다.
//!
//! 방법: 주체마다 두 시점의 (범위, 규칙) 집합을 비교해 달라진 규칙만 고른다. 달라진 규칙에서 대표 요청(동사 × (API 그룹, 리소스) × 범위)을 만들고,
//! 양쪽 시점에서 `can`처럼 평가해 결과가 바뀐 것만 모은다. `*`가 들어 있는 칸은 두 시점의 모든 규칙에 나온 (그룹, 리소스)와 표준 동사 여덟 개,
//! 그리고 "그 밖의 것"을 뜻하는 대리값으로 펼치고, 대리값이 바뀌면 결과에 `*`로 적는다. 클러스터 전체 권한으로 이미 설명되는 네임스페이스 항목은 뺀다.
use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::{Deserialize, Serialize};

use super::engine::{Evaluation, Grant, Names, Query};
use super::rbac::Subject;

const STANDARD_VERBS: [&str; 8] = ["get", "list", "watch", "create", "update", "patch", "delete", "deletecollection"];
/// 목록에 없는 동사·그룹·리소스를 뜻하는 대리값. 결과에서는 `*`로 보인다.
const OTHER: &str = "<other>";

/// 한 범위·리소스에서 바뀐 동사들
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    /// None이면 클러스터 전체
    pub namespace: Option<String>,
    pub group: String,
    /// 하위 리소스가 있으면 `pods/exec`
    pub resource: String,
    pub verbs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlCapability {
    pub url: String,
    pub verbs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectDiff {
    pub subject: Subject,
    pub gained: Vec<Capability>,
    pub lost: Vec<Capability>,
    pub gained_urls: Vec<UrlCapability>,
    pub lost_urls: Vec<UrlCapability>,
}

type Pair = (String, String);

fn changed(a: &[Grant], b: &[Grant]) -> Vec<Grant> {
    a.iter().filter(|g| !b.iter().any(|h| h.namespace == g.namespace && h.rule == g.rule)).cloned().collect()
}

fn split(resource: &str) -> (String, Option<String>) {
    match resource.split_once('/') {
        Some((r, sub)) => (r.to_string(), Some(sub.to_string())),
        None => (resource.to_string(), None),
    }
}

fn vocabulary(evals: [&Evaluation; 2]) -> BTreeSet<Pair> {
    let mut out = BTreeSet::new();
    for eval in evals {
        for s in eval.subjects() {
            for g in &s.grants {
                for group in g.rule.api_groups.iter().filter(|x| *x != "*") {
                    for resource in g.rule.resources.iter().filter(|x| *x != "*" && !x.starts_with("*/")) {
                        out.insert((group.clone(), resource.clone()));
                    }
                }
            }
        }
    }
    out
}

fn pairs_of(grant: &Grant, vocab: &BTreeSet<Pair>) -> BTreeSet<Pair> {
    let mut out = BTreeSet::new();
    for group in &grant.rule.api_groups {
        for resource in &grant.rule.resources {
            let wild_group = group == "*";
            let wild_resource = resource == "*" || resource.starts_with("*/");
            if !wild_group && !wild_resource {
                out.insert((group.clone(), resource.clone()));
                continue;
            }
            let suffix = resource.strip_prefix("*/");
            for (g, r) in vocab.iter().filter(|(g, r)| (wild_group || g == group) && (wild_resource || r == resource)) {
                // `*/log`는 리소스 이름에 `/log`를 붙여 묻는다
                out.insert((g.clone(), suffix.map_or_else(|| r.clone(), |s| format!("{r}/{s}"))));
            }
            let g = if wild_group { OTHER.to_string() } else { group.clone() };
            out.insert((g, if wild_resource { suffix.map_or_else(|| OTHER.to_string(), |s| format!("{OTHER}/{s}")) } else { resource.clone() }));
        }
    }
    out
}

fn verbs_of(grant: &Grant) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for verb in &grant.rule.verbs {
        if verb == "*" {
            out.extend(STANDARD_VERBS.iter().map(|v| v.to_string()));
            out.insert(OTHER.to_string());
        } else {
            out.insert(verb.clone());
        }
    }
    out
}

fn shown(value: &str) -> String {
    if value == OTHER {
        "*".to_string()
    } else if let Some(sub) = value.strip_prefix(&format!("{OTHER}/")) {
        format!("*/{sub}")
    } else {
        value.to_string()
    }
}

type Key = (Option<String>, String, String);

/// 달라진 규칙에서 만든 대표 요청 중 결과가 바뀐 것: (범위, 그룹, 리소스) → 동사들
fn flips(before: &[Grant], after: &[Grant], candidates: &[Grant], vocab: &BTreeSet<Pair>) -> (BTreeMap<Key, BTreeSet<String>>, BTreeMap<Key, BTreeSet<String>>) {
    let mut gained: BTreeMap<Key, BTreeSet<String>> = BTreeMap::new();
    let mut lost: BTreeMap<Key, BTreeSet<String>> = BTreeMap::new();
    let mut seen: HashSet<Query> = HashSet::new();
    for grant in candidates {
        let verbs = verbs_of(grant);
        for (group, resource) in pairs_of(grant, vocab) {
            let (plural, sub) = split(&resource);
            for verb in &verbs {
                let mut q = Query::new(verb, &group, &plural);
                q.subresource = sub.clone();
                q.namespace = grant.namespace.clone();
                if !seen.insert(q.clone()) {
                    continue;
                }
                let was = before.iter().any(|g| g.matches(&q, Names::Strict));
                let is = after.iter().any(|g| g.matches(&q, Names::Strict));
                if was == is {
                    continue;
                }
                let key = (q.namespace.clone(), shown(&group), shown(&resource));
                let map = if is { &mut gained } else { &mut lost };
                map.entry(key).or_default().insert(shown(verb));
            }
        }
    }
    (gained, lost)
}

fn capabilities(map: BTreeMap<Key, BTreeSet<String>>) -> Vec<Capability> {
    let cluster: HashSet<(String, String, String)> = map.iter().filter(|((ns, _, _), _)| ns.is_none()).flat_map(|((_, g, r), verbs)| verbs.iter().map(move |v| (g.clone(), r.clone(), v.clone()))).collect();
    map.into_iter()
        .filter_map(|((namespace, group, resource), verbs)| {
            let verbs: Vec<String> = if namespace.is_some() { verbs.into_iter().filter(|v| !cluster.contains(&(group.clone(), resource.clone(), v.clone()))).collect() } else { verbs.into_iter().collect() };
            (!verbs.is_empty()).then_some(Capability { namespace, group, resource, verbs })
        })
        .collect()
}

fn url_flips(before: &[Grant], after: &[Grant], candidates: &[Grant]) -> (BTreeMap<String, BTreeSet<String>>, BTreeMap<String, BTreeSet<String>>) {
    let mut gained: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut lost: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for grant in candidates.iter().filter(|g| g.namespace.is_none()) {
        for url in &grant.rule.non_resource_urls {
            let probe = url.strip_suffix('*').unwrap_or(url);
            for verb in &grant.rule.verbs {
                let probe_verb = if verb == "*" { OTHER } else { verb };
                let was = before.iter().any(|g| g.matches_url(probe_verb, probe));
                let is = after.iter().any(|g| g.matches_url(probe_verb, probe));
                if was != is {
                    let map = if is { &mut gained } else { &mut lost };
                    map.entry(url.clone()).or_default().insert(shown(verb));
                }
            }
        }
    }
    (gained, lost)
}

fn url_capabilities(map: BTreeMap<String, BTreeSet<String>>) -> Vec<UrlCapability> {
    map.into_iter().map(|(url, verbs)| UrlCapability { url, verbs: verbs.into_iter().collect() }).collect()
}

/// 두 시점의 주체별 변화. 달라진 것이 없는 주체는 넣지 않는다. 주체 순서는 `Subject`의 정렬을 따른다.
pub fn diff(before: &Evaluation, after: &Evaluation) -> Vec<SubjectDiff> {
    let mut subjects: BTreeSet<Subject> = BTreeSet::new();
    subjects.extend(before.subjects().iter().map(|s| s.subject.clone()));
    subjects.extend(after.subjects().iter().map(|s| s.subject.clone()));
    let vocab = vocabulary([before, after]);
    let mut out = Vec::new();
    for subject in subjects {
        let b = before.rules_of(&subject);
        let a = after.rules_of(&subject);
        let added = changed(&a.grants, &b.grants);
        let removed = changed(&b.grants, &a.grants);
        if added.is_empty() && removed.is_empty() {
            continue;
        }
        let candidates: Vec<Grant> = added.into_iter().chain(removed).collect();
        let (gained, lost) = flips(&b.grants, &a.grants, &candidates, &vocab);
        let (gained_urls, lost_urls) = url_flips(&b.grants, &a.grants, &candidates);
        let (gained_urls, lost_urls) = (url_capabilities(gained_urls), url_capabilities(lost_urls));
        let (gained, lost) = (capabilities(gained), capabilities(lost));
        if gained.is_empty() && lost.is_empty() && gained_urls.is_empty() && lost_urls.is_empty() {
            continue;
        }
        out.push(SubjectDiff { subject, gained, lost, gained_urls, lost_urls });
    }
    out
}

#[cfg(test)]
mod tests;
