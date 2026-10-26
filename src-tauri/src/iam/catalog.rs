//! AWS 작업 카탈로그: 서비스 접두어별 작업과 접근 수준.
//! `catalog.json`은 `scripts/update-iam-catalog.mjs`가 AWS Service Reference에서 만든다.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::policy::glob;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessLevel {
    List,
    Read,
    Write,
    Permissions,
    Tagging,
}

/// 화면에 보이는 순서(목록·읽기·쓰기·권한 관리·태그).
pub const LEVELS: [AccessLevel; 5] = [
    AccessLevel::List,
    AccessLevel::Read,
    AccessLevel::Write,
    AccessLevel::Permissions,
    AccessLevel::Tagging,
];

/// `catalog.json`의 접근 수준 코드.
fn level_from_code(code: char) -> Option<AccessLevel> {
    match code {
        'l' => Some(AccessLevel::List),
        'r' => Some(AccessLevel::Read),
        'w' => Some(AccessLevel::Write),
        'p' => Some(AccessLevel::Permissions),
        't' => Some(AccessLevel::Tagging),
        _ => None,
    }
}

#[derive(Deserialize)]
struct RawCatalog {
    services: BTreeMap<String, RawService>,
}

#[derive(Deserialize)]
struct RawService {
    name: String,
    actions: BTreeMap<String, char>,
}

/// 서비스 하나. 작업은 대소문자를 무시한 이름순이라 할당 없이 이진 탐색으로 찾는다.
struct Service {
    prefix: String,
    name: String,
    actions: Vec<(String, AccessLevel)>,
    /// `AccessLevel as usize` 순서의 수준별 작업 수
    totals: [usize; LEVELS.len()],
}

pub struct Catalog {
    /// 접두어순
    services: Vec<Service>,
    total: usize,
}

/// 앱에 넣어 둔 카탈로그. 처음 부를 때 한 번만 읽는다.
pub fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| Catalog::parse(include_str!("catalog.json")).expect("catalog.json은 올바른 카탈로그여야 해요"))
}

/// ASCII 대소문자를 무시한 비교. 문자열을 새로 만들지 않는다.
fn cmp_ignore_case(a: &str, b: &str) -> Ordering {
    a.bytes().map(|c| c.to_ascii_lowercase()).cmp(b.bytes().map(|c| c.to_ascii_lowercase()))
}

fn has_wildcard(s: &str) -> bool {
    s.bytes().any(|b| b == b'*' || b == b'?')
}

/// `*`로만 된 패턴(`*`, `**`)은 전부에 맞는다.
fn is_match_all(pattern: &str) -> bool {
    !pattern.is_empty() && pattern.bytes().all(|b| b == b'*')
}

impl Service {
    /// 서비스 접두어 뒤쪽 패턴(`Get*`)에 맞는 작업마다 `f(접두어, 작업, 수준)`을 부른다.
    fn each_match(&self, pattern: &str, f: &mut impl FnMut(&str, &str, AccessLevel)) {
        if is_match_all(pattern) {
            for (name, level) in &self.actions {
                f(&self.prefix, name, *level);
            }
        } else if !has_wildcard(pattern) {
            if let Ok(i) = self.actions.binary_search_by(|(name, _)| cmp_ignore_case(name, pattern)) {
                let (name, level) = &self.actions[i];
                f(&self.prefix, name, *level);
            }
        } else {
            for (name, level) in &self.actions {
                if glob(pattern, name, true) {
                    f(&self.prefix, name, *level);
                }
            }
        }
    }
}

impl Catalog {
    /// `catalog.json`을 읽는다. 접근 수준 코드가 `l r w p t`가 아니면 오류.
    fn parse(json: &str) -> Result<Catalog, String> {
        let raw: RawCatalog = serde_json::from_str(json).map_err(|e| format!("카탈로그 JSON이 올바르지 않아요: {e}"))?;
        let mut services = Vec::with_capacity(raw.services.len());
        for (prefix, svc) in raw.services {
            let mut actions = Vec::with_capacity(svc.actions.len());
            for (name, code) in svc.actions {
                let level = level_from_code(code).ok_or_else(|| format!("{prefix}:{name}: 알 수 없는 접근 수준 코드 '{code}'"))?;
                actions.push((name, level));
            }
            // IAM 작업 이름은 대소문자를 구분하지 않는다. 대소문자 무시 이름순으로 두고, 겹치면 처음 것만 남긴다.
            actions.sort_by(|a, b| cmp_ignore_case(&a.0, &b.0).then_with(|| a.0.cmp(&b.0)));
            actions.dedup_by(|later, earlier| cmp_ignore_case(&later.0, &earlier.0).is_eq());
            let mut totals = [0; LEVELS.len()];
            for (_, level) in &actions {
                totals[*level as usize] += 1;
            }
            services.push(Service { prefix, name: svc.name, actions, totals });
        }
        services.sort_by(|a, b| cmp_ignore_case(&a.prefix, &b.prefix).then_with(|| a.prefix.cmp(&b.prefix)));
        services.dedup_by(|later, earlier| cmp_ignore_case(&later.prefix, &earlier.prefix).is_eq());
        let total = services.iter().map(|s| s.actions.len()).sum();
        Ok(Catalog { services, total })
    }

    fn service(&self, prefix: &str) -> Option<&Service> {
        let i = self.services.binary_search_by(|s| cmp_ignore_case(&s.prefix, prefix)).ok()?;
        Some(&self.services[i])
    }

    /// (접두어, 서비스 이름), 접두어순.
    pub fn services(&self) -> impl Iterator<Item = (&str, &str)> {
        self.services.iter().map(|s| (s.prefix.as_str(), s.name.as_str()))
    }

    pub fn service_name(&self, prefix: &str) -> Option<&str> {
        self.service(prefix).map(|s| s.name.as_str())
    }

    /// 작업의 접근 수준. 서비스 접두어와 작업 이름은 대소문자를 구분하지 않는다.
    pub fn level(&self, prefix: &str, action: &str) -> Option<AccessLevel> {
        let svc = self.service(prefix)?;
        let i = svc.actions.binary_search_by(|(name, _)| cmp_ignore_case(name, action)).ok()?;
        Some(svc.actions[i].1)
    }

    /// 서비스의 모든 작업(원래 대소문자, 이름순). 모르는 서비스는 빈 목록.
    pub fn actions(&self, prefix: &str) -> &[(String, AccessLevel)] {
        self.service(prefix).map_or(&[], |s| s.actions.as_slice())
    }

    /// 서비스에서 해당 접근 수준인 작업 수.
    pub fn total(&self, prefix: &str, level: AccessLevel) -> usize {
        self.service(prefix).map_or(0, |s| s.totals[level as usize])
    }

    /// 카탈로그 전체 작업 수.
    pub fn all_count(&self) -> usize {
        self.total
    }

    /// `s3:Get*` 같은 작업 패턴에 맞는 카탈로그 작업(접두어, 작업, 수준). 대소문자를 무시하는 glob이고
    /// `*`는 전부다. 서비스 접두어가 정해진 패턴은 그 서비스만 훑는다. 결과는 접두어순, 서비스 안에서는 이름순.
    pub fn expand(&self, pattern: &str) -> Vec<(String, String, AccessLevel)> {
        let mut out = Vec::with_capacity(if is_match_all(pattern) { self.total } else { 0 });
        self.each_match(pattern, |prefix, action, level| out.push((prefix.to_owned(), action.to_owned(), level)));
        out
    }

    fn each_match(&self, pattern: &str, mut f: impl FnMut(&str, &str, AccessLevel)) {
        if pattern.is_empty() {
            return;
        }
        if is_match_all(pattern) {
            for svc in &self.services {
                svc.each_match("*", &mut f);
            }
            return;
        }
        match pattern.split_once(':') {
            Some((svc_pattern, action_pattern)) if !has_wildcard(svc_pattern) => {
                if let Some(svc) = self.service(svc_pattern) {
                    svc.each_match(action_pattern, &mut f);
                }
            }
            Some((svc_pattern, action_pattern)) => {
                for svc in self.services.iter().filter(|s| glob(svc_pattern, &s.prefix, true)) {
                    svc.each_match(action_pattern, &mut f);
                }
            }
            None => {
                // 콜론이 없는 패턴(`ec2*`)은 "접두어:작업" 전체에 대한 glob이다. 버퍼 하나를 재사용한다.
                let mut full = String::new();
                for svc in &self.services {
                    for (name, level) in &svc.actions {
                        full.clear();
                        full.push_str(&svc.prefix);
                        full.push(':');
                        full.push_str(name);
                        if glob(pattern, &full, true) {
                            f(&svc.prefix, name, *level);
                        }
                    }
                }
            }
        }
    }

    /// "s3:GetObject" 형태의 전체 작업 이름, 정렬됨(자동 완성용).
    pub fn all_action_names(&self) -> Vec<String> {
        let mut names = Vec::with_capacity(self.total);
        for svc in &self.services {
            for (name, _) in &svc.actions {
                names.push(format!("{}:{}", svc.prefix, name));
            }
        }
        names.sort_unstable();
        names
    }
}

#[cfg(test)]
mod tests {
    use super::super::policy::glob;
    use super::*;

    #[test]
    fn levels_of_well_known_actions() {
        let c = catalog();
        assert_eq!(c.level("s3", "GetObject"), Some(AccessLevel::Read));
        assert_eq!(c.level("s3", "ListBucket"), Some(AccessLevel::List));
        assert_eq!(c.level("s3", "PutObject"), Some(AccessLevel::Write));
        assert_eq!(c.level("s3", "PutObjectTagging"), Some(AccessLevel::Tagging));
        assert_eq!(c.level("iam", "AttachUserPolicy"), Some(AccessLevel::Permissions));
        assert_eq!(c.level("s3", "NoSuchAction"), None);
        assert_eq!(c.level("nosuch", "GetObject"), None);
    }

    #[test]
    fn lookups_ignore_case() {
        let c = catalog();
        assert_eq!(c.level("s3", "getobject"), Some(AccessLevel::Read));
        assert_eq!(c.level("s3", "getobject"), c.level("s3", "GetObject"));
        assert_eq!(c.level("S3", "GETOBJECT"), Some(AccessLevel::Read));
        assert!(c.service_name("s3").is_some());
        assert_eq!(c.service_name("S3"), c.service_name("s3"));
        assert!(c.service_name("nosuch").is_none());
        assert!(!c.actions("s3").is_empty());
        assert_eq!(c.actions("S3"), c.actions("s3"));
        assert!(c.actions("nosuch").is_empty());
    }

    #[test]
    fn actions_use_canonical_case() {
        let names: Vec<&str> = catalog().actions("s3").iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"GetObject"));
        assert!(!names.contains(&"getobject"));
    }

    #[test]
    fn services_are_sorted_by_prefix() {
        let prefixes: Vec<&str> = catalog().services().map(|(p, _)| p).collect();
        assert!(prefixes.len() > 300, "{} services", prefixes.len());
        assert!(prefixes.windows(2).all(|w| w[0] < w[1]));
        assert!(prefixes.contains(&"s3") && prefixes.contains(&"iam"));
    }

    #[test]
    fn totals_add_up() {
        let c = catalog();
        let s3: usize = LEVELS.iter().map(|l| c.total("s3", *l)).sum();
        assert_eq!(s3, c.actions("s3").len());
        let writes = c.actions("s3").iter().filter(|(_, l)| *l == AccessLevel::Write).count();
        assert_eq!(c.total("s3", AccessLevel::Write), writes);
        assert!(c.total("s3", AccessLevel::Read) > 0);
        assert_eq!(c.total("nosuch", AccessLevel::Read), 0);
        let all: usize = c.services().map(|(p, _)| c.actions(p).len()).sum();
        assert_eq!(all, c.all_count());
        assert!(c.all_count() > 10_000, "{} actions", c.all_count());
    }

    #[test]
    fn expand_prefix_wildcard() {
        let hits = catalog().expand("s3:Get*");
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|(p, a, _)| p == "s3" && a.starts_with("Get")));
        assert!(hits.iter().any(|(_, a, l)| a == "GetObject" && *l == AccessLevel::Read));
    }

    #[test]
    fn expand_everything() {
        let c = catalog();
        assert_eq!(c.expand("*").len(), c.all_count());
        assert_eq!(c.expand("*:*").len(), c.all_count());
    }

    #[test]
    fn expand_without_matches_is_empty() {
        let c = catalog();
        assert!(c.expand("nosuch:*").is_empty());
        assert!(c.expand("s3:NoSuchAction").is_empty());
        assert!(c.expand("s3:NoSuch*").is_empty());
        assert!(c.expand("").is_empty());
    }

    #[test]
    fn expand_ignores_case_and_returns_canonical_names() {
        let hits = catalog().expand("S3:getobject");
        assert_eq!(hits, vec![("s3".to_string(), "GetObject".to_string(), AccessLevel::Read)]);
    }

    #[test]
    fn expand_wildcards_in_service_and_action() {
        let c = catalog();
        let single = c.expand("s3:?etObject");
        assert!(single.iter().any(|(_, a, _)| a == "GetObject"));
        assert!(single.iter().all(|(p, a, _)| p == "s3" && a.len() == "GetObject".len()));
        let any_service = c.expand("*:GetObject");
        assert!(any_service.iter().any(|(p, _, _)| p == "s3"));
        assert!(any_service.iter().all(|(_, a, _)| a == "GetObject"));
        let s3_family = c.expand("s3*:ListBucket");
        assert!(s3_family.iter().all(|(p, a, _)| p.starts_with("s3") && a == "ListBucket"));
    }

    #[test]
    fn expand_agrees_with_a_naive_glob_over_full_names() {
        let c = catalog();
        let patterns = [
            "*", "**", "*:*", "s3:*", "s3:Get*", "S3:get*", "s3:GetObject", "iam:*User*", "ec2:Describe?pc*", "*:Get*Policy", "s*:List*",
            "e?2:*Tags", "nosuch:*", "ec2*", "*Object", "s3?GetObject", "*:", ":*", "iam:Get*:x", "lambda:invoke*",
        ];
        for pattern in patterns {
            let fast: Vec<String> = c.expand(pattern).into_iter().map(|(p, a, _)| format!("{p}:{a}")).collect();
            let mut naive = Vec::new();
            for (prefix, _) in c.services() {
                for (action, _) in c.actions(prefix) {
                    let full = format!("{prefix}:{action}");
                    if glob(pattern, &full, true) {
                        naive.push(full);
                    }
                }
            }
            assert_eq!(fast, naive, "pattern {pattern}");
        }
    }

    #[test]
    fn all_action_names_are_sorted_full_names() {
        let c = catalog();
        let names = c.all_action_names();
        assert_eq!(names.len(), c.all_count());
        assert!(names.contains(&"s3:GetObject".to_string()));
        assert!(names.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn catalog_is_parsed_once() {
        assert!(std::ptr::eq(catalog(), catalog()));
    }

    const FIXTURE: &str = r#"{"generated":"2026-01-01","services":{
        "zed":{"name":"Zed","actions":{"Zap":"w"}},
        "Foo":{"name":"Foo Service","actions":{"getThing":"r","GetItem":"r","ListThings":"l","getthing":"w","SetPerm":"p","TagThing":"t"}}
    }}"#;

    #[test]
    fn parse_sorts_services_and_actions_and_drops_case_duplicates() {
        let c = Catalog::parse(FIXTURE).unwrap();
        assert_eq!(c.services().collect::<Vec<_>>(), vec![("Foo", "Foo Service"), ("zed", "Zed")]);
        assert_eq!(c.service_name("FOO"), Some("Foo Service"));
        let names: Vec<&str> = c.actions("foo").iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["GetItem", "getThing", "ListThings", "SetPerm", "TagThing"]);
        assert_eq!(c.level("foo", "GETTHING"), Some(AccessLevel::Read));
        assert_eq!(c.all_count(), 6);
        assert_eq!(c.total("foo", AccessLevel::Read), 2);
        assert_eq!(c.total("foo", AccessLevel::Write), 0);
        assert_eq!(c.total("foo", AccessLevel::List), 1);
        assert_eq!(c.total("foo", AccessLevel::Permissions), 1);
        assert_eq!(c.total("foo", AccessLevel::Tagging), 1);
        assert_eq!(c.expand("foo:get*"), vec![
            ("Foo".to_string(), "GetItem".to_string(), AccessLevel::Read),
            ("Foo".to_string(), "getThing".to_string(), AccessLevel::Read),
        ]);
    }

    #[test]
    fn parse_keeps_the_first_of_services_that_differ_only_in_case() {
        let c = Catalog::parse(r#"{"services":{"foo":{"name":"A","actions":{"Y":"w"}},"Foo":{"name":"B","actions":{"X":"r"}}}}"#).unwrap();
        // 'F'가 'f'보다 앞이라 "Foo"가 남는다
        assert_eq!(c.services().collect::<Vec<_>>(), vec![("Foo", "B")]);
        assert_eq!(c.all_count(), 1);
        assert_eq!(c.level("foo", "x"), Some(AccessLevel::Read));
        assert_eq!(c.level("foo", "y"), None);
    }

    #[test]
    fn parse_rejects_bad_input() {
        assert!(Catalog::parse("not json").is_err());
        assert!(Catalog::parse(r#"{"generated":"x"}"#).is_err());
        let err = Catalog::parse(r#"{"services":{"a":{"name":"A","actions":{"Do":"z"}}}}"#).err().expect("unknown level code must fail");
        assert!(err.contains("a:Do"), "{err}");
    }

    #[test]
    fn access_level_json_names() {
        assert_eq!(serde_json::to_string(&AccessLevel::Permissions).unwrap(), "\"permissions\"");
        assert_eq!(serde_json::from_str::<AccessLevel>("\"tagging\"").unwrap(), AccessLevel::Tagging);
        assert_eq!(LEVELS.len(), 5);
        assert!(LEVELS.windows(2).all(|w| w[0] < w[1]));
    }
}
