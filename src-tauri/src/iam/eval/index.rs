//! 카탈로그 작업에 번호를 붙이고, 문장의 작업 패턴을 번호 목록으로 펼친다.
//! 작업마다 문자열을 만들지 않으므로 `*`나 NotAction처럼 2만 개가 넘는 작업을 가리키는 문장도 싸다.

use std::sync::OnceLock;

use crate::iam::catalog::{catalog, cmp_ignore_case, has_wildcard, is_match_all, AccessLevel};
use crate::iam::policy::{glob, Actions, Statement};

/// 카탈로그 작업의 번호. 서비스 접두어순(대소문자 무시)이고, 서비스 안에서는 카탈로그의 작업 순서다.
pub(super) type ActionId = u32;

type ServiceActions = &'static [(String, AccessLevel)];

pub(super) struct Index {
    prefixes: Vec<&'static str>,
    actions: Vec<ServiceActions>,
    /// 서비스마다 첫 작업의 번호. 맨 끝에 전체 작업 수가 한 칸 더 있다
    starts: Vec<u32>,
    /// 번호 → 서비스 순번 / 접근 수준
    service_of: Vec<u16>,
    levels: Vec<AccessLevel>,
}

/// 앱에 넣어 둔 카탈로그의 번호표. 처음 부를 때 한 번만 만든다.
pub(super) fn index() -> &'static Index {
    static INDEX: OnceLock<Index> = OnceLock::new();
    INDEX.get_or_init(Index::build)
}

impl Index {
    fn build() -> Index {
        let cat = catalog();
        let mut index = Index {
            prefixes: Vec::new(),
            actions: Vec::new(),
            starts: Vec::new(),
            service_of: Vec::with_capacity(cat.all_count()),
            levels: Vec::with_capacity(cat.all_count()),
        };
        for (prefix, _) in cat.services() {
            let actions = cat.actions(prefix);
            index.starts.push(index.levels.len() as u32);
            index.service_of.extend(std::iter::repeat_n(index.prefixes.len() as u16, actions.len()));
            index.levels.extend(actions.iter().map(|(_, level)| *level));
            index.prefixes.push(prefix);
            index.actions.push(actions);
        }
        index.starts.push(index.levels.len() as u32);
        index
    }

    pub(super) fn total(&self) -> usize {
        self.levels.len()
    }

    /// 작업이 속한 서비스의 순번. 같은 서비스의 작업 번호는 이어져 있다.
    pub(super) fn service_of(&self, id: ActionId) -> usize {
        self.service_of[id as usize] as usize
    }

    pub(super) fn prefix(&self, service: usize) -> &'static str {
        self.prefixes[service]
    }

    pub(super) fn level(&self, id: ActionId) -> AccessLevel {
        self.levels[id as usize]
    }

    /// (서비스 접두어, 작업 이름).
    pub(super) fn names(&self, id: ActionId) -> (&'static str, &'static str) {
        let service = self.service_of[id as usize] as usize;
        (self.prefixes[service], &self.actions[service][(id - self.starts[service]) as usize].0)
    }

    fn service(&self, prefix: &str) -> Option<usize> {
        self.prefixes.binary_search_by(|p| cmp_ignore_case(p, prefix)).ok()
    }

    /// 서비스 안에서 `Get*` 같은 작업 이름 패턴에 맞는 번호를 덧붙인다.
    fn push_in_service(&self, service: usize, pattern: &str, out: &mut Vec<ActionId>) {
        let actions = self.actions[service];
        let start = self.starts[service];
        if is_match_all(pattern) {
            out.extend(start..self.starts[service + 1]);
        } else if !has_wildcard(pattern) {
            if let Ok(i) = actions.binary_search_by(|(name, _)| cmp_ignore_case(name, pattern)) {
                out.push(start + i as u32);
            }
        } else {
            out.extend(actions.iter().enumerate().filter(|(_, (name, _))| glob(pattern, name, true)).map(|(i, _)| start + i as u32));
        }
    }

    /// `s3:Get*` 같은 패턴 하나에 맞는 번호를 오름차순으로 덧붙인다. `Catalog::expand`와 같은 규칙이다.
    fn push_pattern(&self, pattern: &str, out: &mut Vec<ActionId>) {
        if pattern.is_empty() {
            return;
        }
        if is_match_all(pattern) {
            out.extend(0..self.total() as u32);
            return;
        }
        match pattern.split_once(':') {
            Some((service, action)) if !has_wildcard(service) => {
                if let Some(service) = self.service(service) {
                    self.push_in_service(service, action, out);
                }
            }
            Some((service, action)) => {
                for i in (0..self.prefixes.len()).filter(|&i| glob(service, self.prefixes[i], true)) {
                    self.push_in_service(i, action, out);
                }
            }
            None => {
                // 콜론이 없는 패턴(`ec2*`)은 "접두어:작업" 전체에 대한 glob이다. 버퍼 하나를 재사용한다.
                let mut full = String::new();
                for (service, prefix) in self.prefixes.iter().enumerate() {
                    for (i, (name, _)) in self.actions[service].iter().enumerate() {
                        full.clear();
                        full.push_str(prefix);
                        full.push(':');
                        full.push_str(name);
                        if glob(pattern, &full, true) {
                            out.push(self.starts[service] + i as u32);
                        }
                    }
                }
            }
        }
    }

    /// 문장의 Action/NotAction이 가리키는 카탈로그 작업 번호(오름차순, 중복 없음)와, 카탈로그의 어떤 작업에도 맞지 않은
    /// `Action` 패턴. NotAction은 패턴에 맞는 작업을 뺀 나머지이고, 맞지 않은 패턴은 따로 알리지 않는다.
    pub(super) fn statement_ids<'s>(&self, stmt: &'s Statement) -> (Vec<ActionId>, Vec<&'s str>) {
        let (patterns, negated) = match &stmt.actions {
            Actions::Action(patterns) => (patterns, false),
            Actions::NotAction(patterns) => (patterns, true),
        };
        let mut found = Vec::new();
        let mut unmatched = Vec::new();
        for pattern in patterns {
            let before = found.len();
            self.push_pattern(pattern, &mut found);
            if found.len() == before && !negated {
                unmatched.push(pattern.as_str());
            }
        }
        found.sort_unstable();
        found.dedup();
        if !negated {
            return (found, unmatched);
        }
        let mut excluded = found.iter().copied().peekable();
        let rest = (0..self.total() as u32).filter(|id| excluded.next_if_eq(id).is_none()).collect();
        (rest, unmatched)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::json;

    use super::*;
    use crate::iam::fixtures::{doc, policy};

    fn full_names(ids: &[ActionId]) -> BTreeSet<String> {
        ids.iter()
            .map(|&id| {
                let (prefix, action) = index().names(id);
                format!("{prefix}:{action}")
            })
            .collect()
    }

    fn expanded(pattern: &str) -> Vec<ActionId> {
        let mut ids = Vec::new();
        index().push_pattern(pattern, &mut ids);
        ids
    }

    #[test]
    fn numbering_follows_the_catalog() {
        let (ix, cat) = (index(), catalog());
        assert_eq!(ix.total(), cat.all_count());
        let mut id = 0;
        for (service, (prefix, _)) in cat.services().enumerate() {
            assert_eq!(ix.prefix(service), prefix);
            for (name, level) in cat.actions(prefix) {
                assert_eq!(ix.names(id), (prefix, name.as_str()));
                assert_eq!((ix.level(id), ix.service_of(id)), (*level, service));
                id += 1;
            }
        }
        assert_eq!(id as usize, ix.total());
    }

    #[test]
    fn expansion_agrees_with_the_catalog() {
        let patterns = [
            "", "*", "**", "*:*", "s3:*", "S3:get*", "s3:GetObject", "s3:getobject", "iam:*User*", "ec2:Describe?pc*", "*:Get*Policy", "s*:List*", "e?2:*Tags",
            "nosuch:*", "nosuch:Thing", "ec2*", "*Object", "s3?GetObject", "s3-object-lambda:*", "s3:", ":*", ":", "lambda:INVOKE*", "?*", "*:?*", "s?:Get*",
            "e?2*", "iam:Attach*Policy", "sts:AssumeRole", "STS:ASSUMEROLE*",
        ];
        for pattern in patterns {
            let ids = expanded(pattern);
            assert!(ids.windows(2).all(|w| w[0] < w[1]), "{pattern}: 오름차순이고 중복이 없어야 해요");
            let expected: BTreeSet<String> = catalog().expand(pattern).into_iter().map(|(prefix, action, _)| format!("{prefix}:{action}")).collect();
            assert_eq!(full_names(&ids), expected, "{pattern}");
            assert_eq!(ids.len(), expected.len(), "{pattern}");
        }
        assert!(expanded("s3:*").len() > 10 && expanded("nosuch:*").is_empty());
    }

    #[test]
    fn a_statement_expands_to_unique_sorted_ids_and_reports_patterns_that_match_nothing() {
        let d = doc(policy(json!([{ "Effect": "Allow", "Action": ["s3:*", "S3:GETOBJECT", "foo:Bar", "iam:Nope*", "s3:Get*"], "Resource": "*" }])));
        let (ids, unmatched) = index().statement_ids(&d.statements[0]);
        assert_eq!(ids.len(), catalog().actions("s3").len());
        assert!(ids.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(unmatched, vec!["foo:Bar", "iam:Nope*"]);

        let none = doc(policy(json!([{ "Effect": "Allow", "Action": [], "Resource": "*" }])));
        assert_eq!(index().statement_ids(&none.statements[0]), (Vec::new(), Vec::new()));
    }

    #[test]
    fn not_action_is_the_rest_of_the_catalog() {
        let d = doc(policy(json!([{ "Effect": "Allow", "NotAction": ["iam:*", "S3:Get*", "foo:Bar"], "Resource": "*" }])));
        let (rest, unmatched) = index().statement_ids(&d.statements[0]);
        assert!(unmatched.is_empty(), "NotAction은 맞지 않은 패턴을 알리지 않아요");
        assert!(rest.windows(2).all(|w| w[0] < w[1]));
        let left_out: BTreeSet<String> = full_names(&expanded("iam:*")).union(&full_names(&expanded("s3:Get*"))).cloned().collect();
        assert!(left_out.len() > 100);
        assert_eq!(rest.len(), catalog().all_count() - left_out.len());
        assert!(full_names(&rest).is_disjoint(&left_out));
        assert!(full_names(&rest).contains("s3:PutObject"));

        let everything = doc(policy(json!([{ "Effect": "Allow", "NotAction": [], "Resource": "*" }])));
        assert_eq!(index().statement_ids(&everything.statements[0]).0.len(), catalog().all_count());
        let nothing = doc(policy(json!([{ "Effect": "Allow", "NotAction": "*", "Resource": "*" }])));
        assert!(index().statement_ids(&nothing.statements[0]).0.is_empty());
    }
}
