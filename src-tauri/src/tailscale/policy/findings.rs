//! 정책의 지적. 입력은 JSON으로 읽은 정책과 기기들이 쓰는 태그뿐인 순수 함수다.
use std::collections::{BTreeSet, HashSet};
use std::net::IpAddr;

use serde::Serialize;
use serde_json::{Map, Value};

/// 위험한 순서: 높음 → 보통 → 낮음.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Finding {
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    /// 정책 JSON 안의 위치. `acls[2].src[0]`, `groups["group:ops"]`처럼 쓴다.
    pub path: String,
}

fn finding(severity: Severity, path: String, title: impl Into<String>, detail: impl Into<String>) -> Finding {
    Finding { severity, title: title.into(), detail: detail.into(), path }
}

fn array<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Vec<Value>> {
    keys.iter().find_map(|key| value.get(key).and_then(Value::as_array))
}

fn strings(list: Option<&Vec<Value>>) -> Vec<(usize, &str)> {
    list.into_iter().flatten().enumerate().filter_map(|(i, v)| v.as_str().map(|s| (i, s))).collect()
}

fn is_empty(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::Array(list)) => list.is_empty(),
        Some(Value::Object(map)) => map.is_empty(),
        Some(_) => false,
    }
}

fn key_path(base: &str, key: &str) -> String {
    format!("{base}[{}]", Value::String(key.to_owned()))
}

/// 목적지 `host:port`에서 (호스트가 `*`인가, 포트가 전부인가).
fn dst_wildcard(dst: &str) -> Option<bool> {
    let (host, port) = dst.rsplit_once(':').unwrap_or((dst, "*"));
    (host == "*").then_some(port == "*")
}

fn list_text(items: &[&str]) -> String {
    items.iter().map(|s| format!("`{s}`")).collect::<Vec<_>>().join(", ")
}

/// acls·grants의 `*` 출발지·목적지. 한 규칙에 둘 다 있으면 하나로 묶어 말한다.
fn wildcard_rules(policy: &Value, key: &str, src_keys: &[&str], dst_keys: &[&str], out: &mut Vec<Finding>) {
    let Some(rules) = policy.get(key).and_then(Value::as_array) else { return };
    for (i, rule) in rules.iter().enumerate() {
        let rule_path = format!("{key}[{i}]");
        let src_key = src_keys.iter().find(|k| rule.get(**k).is_some()).copied().unwrap_or(src_keys[0]);
        let dst_key = dst_keys.iter().find(|k| rule.get(**k).is_some()).copied().unwrap_or(dst_keys[0]);
        let src = strings(array(rule, src_keys)).into_iter().find(|(_, s)| *s == "*");
        let dst = strings(array(rule, dst_keys)).into_iter().find_map(|(at, s)| dst_wildcard(s).map(|all_ports| (at, s, all_ports)));
        match (src, dst) {
            (Some(_), Some((_, dst, true))) => out.push(finding(
                Severity::High,
                rule_path.clone(),
                "모든 출발지가 모든 목적지로 열려 있어요",
                format!("{rule_path} 규칙이 출발지 `*`와 목적지 `{dst}`를 함께 허용해요. 모든 사용자·기기가 모든 기기의 모든 포트에 닿을 수 있어요. 필요한 그룹·태그와 포트로 좁혀 주세요."),
            )),
            (src, dst) => {
                if let Some((at, _)) = src {
                    out.push(finding(
                        Severity::High,
                        format!("{rule_path}.{src_key}[{at}]"),
                        "출발지가 `*`예요",
                        format!("{rule_path} 규칙은 모든 사용자·기기에게 열려 있어요. 필요한 그룹·태그·사용자로 좁혀 주세요."),
                    ));
                }
                if let Some((at, dst, all_ports)) = dst {
                    let (severity, scope) = if all_ports { (Severity::High, "모든 포트") } else { (Severity::Medium, "그 포트") };
                    out.push(finding(
                        severity,
                        format!("{rule_path}.{dst_key}[{at}]"),
                        "목적지가 `*`예요",
                        format!("{rule_path} 규칙의 출발지가 모든 기기의 {scope}({dst})에 닿을 수 있어요. 필요한 태그·호스트로 좁혀 주세요."),
                    ));
                }
            }
        }
    }
}

/// `10.0.0.0/8` → (IPv6인가, 접두 길이)
fn cidr(text: &str) -> Option<(bool, u8)> {
    let (address, prefix) = text.split_once('/')?;
    let address: IpAddr = address.parse().ok()?;
    Some((address.is_ipv6(), prefix.parse().ok()?))
}

fn auto_approvers(policy: &Value, out: &mut Vec<Finding>) {
    let Some(approvers) = policy.get("autoApprovers") else { return };
    if let Some(routes) = approvers.get("routes").and_then(Value::as_object) {
        for (route, who) in routes {
            let who: Vec<&str> = strings(who.as_array()).into_iter().map(|(_, s)| s).collect();
            if who.is_empty() {
                continue;
            }
            let path = key_path("autoApprovers.routes", route);
            match cidr(route) {
                Some((_, 0)) => out.push(finding(
                    Severity::High,
                    path,
                    format!("`{route}` 경로를 자동 승인해요"),
                    format!("{}가 이 경로를 광고하면 사람이 보지 않아도 모든 트래픽이 그 기기로 가요. exit node처럼 동작하니 꼭 필요한 곳에만 허용하세요.", list_text(&who)),
                )),
                Some((v6, prefix)) if prefix < if v6 { 48 } else { 16 } => out.push(finding(
                    Severity::Medium,
                    path,
                    format!("넓은 경로 `{route}`를 자동 승인해요"),
                    format!("{}가 광고하는 `{route}`가 사람의 승인 없이 열려요. /{} 안쪽의 더 좁은 경로로 나누는 편이 안전해요.", list_text(&who), if v6 { 48 } else { 16 }),
                )),
                _ => {}
            }
        }
    }
    let exit: Vec<&str> = strings(approvers.get("exitNode").and_then(Value::as_array)).into_iter().map(|(_, s)| s).collect();
    if !exit.is_empty() {
        out.push(finding(
            Severity::Medium,
            "autoApprovers.exitNode".into(),
            "exit node를 자동 승인해요",
            format!("{}가 광고하는 exit node(`0.0.0.0/0`, `::/0`)가 사람의 승인 없이 열려요.", list_text(&exit)),
        ));
    }
}

/// 그룹이 풀리는 멤버 수. 다른 그룹을 품은 그룹은 그 그룹의 멤버를 센다.
fn member_count<'a>(name: &'a str, groups: &'a Map<String, Value>, visiting: &mut HashSet<&'a str>) -> usize {
    if !visiting.insert(name) {
        return 0;
    }
    let members = groups.get(name).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
    let count = members.map(|m| if groups.contains_key(m) { member_count(m, groups, visiting) } else { 1 }).sum();
    visiting.remove(name);
    count
}

fn empty_groups(policy: &Value, out: &mut Vec<Finding>) {
    let Some(groups) = policy.get("groups").and_then(Value::as_object) else { return };
    for name in groups.keys() {
        if member_count(name, groups, &mut HashSet::new()) == 0 {
            out.push(finding(
                Severity::Low,
                key_path("groups", name),
                format!("`{name}`에 멤버가 없어요"),
                "이 그룹을 쓰는 규칙은 아무에게도 적용되지 않아요. 멤버를 넣거나 그룹과 그 규칙을 지워 주세요.",
            ));
        }
    }
}

fn unused_tags(policy: &Value, device_tags: &BTreeSet<String>, out: &mut Vec<Finding>) {
    let Some(owners) = policy.get("tagOwners").and_then(Value::as_object) else { return };
    for tag in owners.keys().filter(|tag| !device_tags.contains(*tag)) {
        out.push(finding(
            Severity::Low,
            key_path("tagOwners", tag),
            format!("`{tag}`를 쓰는 기기가 없어요"),
            "이 태그를 단 기기가 하나도 없어요. 규칙에서 쓰지 않는다면 tagOwners에서 지워 주세요.",
        ));
    }
}

fn missing_tests(policy: &Value, out: &mut Vec<Finding>) {
    if is_empty(policy.get("tests")) {
        out.push(finding(
            Severity::Medium,
            "tests".into(),
            "정책 시험이 없어요",
            "tests가 있으면 저장할 때마다 접근 규칙이 의도대로인지 자동으로 확인해요. 꼭 되어야 하는 접속과 막혀야 하는 접속을 적어 두세요.",
        ));
    }
    if !is_empty(policy.get("ssh")) && is_empty(policy.get("sshTests")) {
        out.push(finding(
            Severity::Low,
            "sshTests".into(),
            "SSH 규칙의 시험이 없어요",
            "ssh 규칙이 있는데 sshTests가 없어요. 저장할 때 SSH 접근이 의도대로인지 확인하지 못해요.",
        ));
    }
}

fn root_ssh(policy: &Value, out: &mut Vec<Finding>) {
    let Some(rules) = policy.get("ssh").and_then(Value::as_array) else { return };
    for (i, rule) in rules.iter().enumerate() {
        let accepts = rule.get("action").and_then(Value::as_str) == Some("accept");
        let users = strings(rule.get("users").and_then(Value::as_array));
        if let Some((at, _)) = users.iter().find(|(_, user)| *user == "root").filter(|_| accepts) {
            out.push(finding(
                Severity::High,
                format!("ssh[{i}].users[{at}]"),
                "root로 SSH하는 것을 재인증 없이 허용해요",
                format!("ssh[{i}] 규칙은 action이 `accept`라서 root 로그인에 다시 인증하는 단계가 없어요. action을 `check`로 바꾸고 checkPeriod를 정하거나 root를 빼 주세요."),
            ));
        }
    }
}

/// 정책의 지적을 위험한 순서로. `device_tags`가 `None`이면(기기 목록을 읽지 못함) 쓰지 않는 태그는 말하지 않는다.
pub fn analyze(policy: &Value, device_tags: Option<&BTreeSet<String>>) -> Vec<Finding> {
    let mut found = Vec::new();
    wildcard_rules(policy, "grants", &["src"], &["dst"], &mut found);
    wildcard_rules(policy, "acls", &["src", "users"], &["dst", "ports"], &mut found);
    auto_approvers(policy, &mut found);
    root_ssh(policy, &mut found);
    empty_groups(policy, &mut found);
    if let Some(tags) = device_tags {
        unused_tags(policy, tags, &mut found);
    }
    missing_tests(policy, &mut found);
    found.sort_by_key(|f| f.severity);
    found
}
