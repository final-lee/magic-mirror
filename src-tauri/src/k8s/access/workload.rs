//! 워크로드 신원(순수): ServiceAccount의 IRSA 어노테이션, Pod Identity 연결, 그것을 쓰는 Pod, 그리고 역할 신뢰 정책 확인.
//! 신뢰 정책 해석은 IAM 모듈(`iam::policy`, `iam::trust`)을 다시 쓴다. 역할을 읽는 호출은 `read.rs`에 있고 이 파일은 읽은 글만 받는다.
use std::collections::{BTreeMap, HashMap};

use serde::Serialize;
use serde_json::Value;

use crate::iam::policy::{decode_document, glob, parse_document, statement_action_matches, Effect, PolicyDocument, Statement};
use crate::iam::trust::parse_trust;
use crate::iam::view::TrustKind;

pub const IRSA_ANNOTATION: &str = "eks.amazonaws.com/role-arn";
pub const AUDIENCE_ANNOTATION: &str = "eks.amazonaws.com/audience";
pub const DEFAULT_AUDIENCE: &str = "sts.amazonaws.com";
pub const PODS_SHOWN: usize = 20;
const WEB_IDENTITY: &str = "sts:AssumeRoleWithWebIdentity";
const POD_IDENTITY_SERVICE: &str = "pods.eks.amazonaws.com";

/// 역할 신뢰 정책을 확인한 결과
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Check {
    /// 신뢰 정책이 이 ServiceAccount가 역할을 맡도록 허용한다
    Works,
    /// 연결돼 있지만 동작하지 않는다
    Broken { reasons: Vec<String> },
    /// 확인하지 못했다(역할을 읽지 못함, 정책을 해석하지 못함)
    Unknown { message: String },
}

/// 신뢰 정책 글을 읽은 결과 또는 읽지 못한 이유
pub type TrustText = Result<String, String>;

#[derive(Debug, Clone, PartialEq)]
pub struct SaInfo {
    pub namespace: String,
    pub name: String,
    pub annotations: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PodInfo {
    pub namespace: String,
    pub name: String,
    pub service_account: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Association {
    pub id: String,
    pub namespace: String,
    pub service_account: String,
    pub role_arn: String,
    pub target_role_arn: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IrsaView {
    pub role_arn: String,
    pub audience: String,
    pub check: Check,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodIdentityView {
    pub association_id: String,
    pub role_arn: String,
    pub target_role_arn: Option<String>,
    pub check: Check,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadIdentity {
    pub namespace: String,
    pub service_account: String,
    /// Pod Identity 연결만 있고 ServiceAccount는 아직 없을 수 있다
    pub exists: bool,
    pub irsa: Option<IrsaView>,
    pub pod_identity: Option<PodIdentityView>,
    /// 이 ServiceAccount를 쓰는 Pod(최대 `PODS_SHOWN`개)
    pub pods: Vec<String>,
    pub pod_count: usize,
    pub notes: Vec<String>,
}

/// 역할 ARN의 이름(경로는 뺀다). `GetRole`은 이름만 받는다.
pub fn role_name(arn: &str) -> Option<&str> {
    let (_, resource) = arn.split_once(":role/")?;
    resource.rsplit('/').next().filter(|n| !n.is_empty())
}

fn issuer_host(issuer: &str) -> String {
    issuer.trim_start_matches("https://").trim_end_matches('/').to_string()
}

fn federated_provider(stmt: &Statement, provider: &str) -> bool {
    let doc = PolicyDocument { statements: vec![stmt.clone()] };
    parse_trust(&doc, "").iter().any(|e| e.kind == TrustKind::Federated && e.value == provider && e.actions.iter().any(|a| a == WEB_IDENTITY))
}

/// 조건 하나: 연산자와 값들
struct Condition {
    operator: String,
    values: Vec<String>,
}

fn conditions_for(raw: &Value, index: usize, key: &str) -> Vec<Condition> {
    let statements = match raw.get("Statement") {
        Some(Value::Array(items)) => items.get(index),
        Some(one) if index == 0 => Some(one),
        _ => None,
    };
    let Some(Value::Object(map)) = statements.and_then(|s| s.get("Condition")) else {
        return vec![];
    };
    let mut out = Vec::new();
    for (operator, keys) in map {
        let Some(keys) = keys.as_object() else {
            continue;
        };
        for (k, value) in keys {
            if k != key {
                continue;
            }
            let values = match value {
                Value::Array(items) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
                Value::String(one) => vec![one.clone()],
                _ => vec![],
            };
            out.push(Condition { operator: operator.clone(), values });
        }
    }
    out
}

enum Verdict {
    Match,
    Mismatch,
    /// `StringNotEquals` 같은, 이 확인이 풀 수 없는 연산자
    Unsupported,
}

fn verdict(condition: &Condition, actual: &str) -> Verdict {
    // `ForAnyValue:`·`ForAllValue:` 접두사와 `IfExists` 접미사는 값이 하나인 이 확인에서는 같은 뜻이다
    let operator = condition.operator.rsplit(':').next().unwrap_or(&condition.operator).trim_end_matches("IfExists");
    let hit = match operator {
        "StringEquals" => condition.values.iter().any(|v| v == actual),
        "StringEqualsIgnoreCase" => condition.values.iter().any(|v| v.eq_ignore_ascii_case(actual)),
        "StringLike" => condition.values.iter().any(|v| glob(v, actual, false)),
        _ => return Verdict::Unsupported,
    };
    if hit {
        Verdict::Match
    } else {
        Verdict::Mismatch
    }
}

/// 한 문장에서 `key` 조건이 `actual`을 허용하는지: 조건이 있고 모두 맞으면 Ok, 조건이 없거나 맞지 않거나 풀 수 없으면 이유들.
fn key_check(conditions: &[Condition], actual: &str, label: &str) -> Result<(), Vec<String>> {
    if conditions.is_empty() {
        return Err(vec![format!("{label} 조건이 없어요")]);
    }
    let mut reasons = Vec::new();
    for c in conditions {
        match verdict(c, actual) {
            Verdict::Match => {}
            Verdict::Mismatch => reasons.push(format!("{label} 조건이 {actual}와 맞지 않아요: {}", c.values.join(", "))),
            Verdict::Unsupported => reasons.push(format!("{label} 조건의 연산자 {}는 평가하지 못해요", c.operator)),
        }
    }
    if reasons.is_empty() {
        Ok(())
    } else {
        Err(reasons)
    }
}

const NO_PROVIDER: &str = "이 클러스터의 OIDC 공급자를 신뢰하지 않아요";

/// IRSA 확인: 신뢰 정책의 Allow 문장 하나가 (1) 이 클러스터의 OIDC 공급자를 `sts:AssumeRoleWithWebIdentity`로 허용하고
/// (2) `<공급자>:sub` 조건이 `system:serviceaccount:<ns>:<sa>`를 허용(와일드카드 포함)하고 (3) `<공급자>:aud` 조건이 `audience`를 허용해야 한다.
/// 조건이 없거나 맞지 않으면 `Broken`이다. 연산자를 풀 수 없고 다른 문장도 통과하지 못하면 `Unknown`이다.
pub fn check_irsa(trust: &str, issuer: &str, namespace: &str, service_account: &str, audience: &str) -> Check {
    let doc = match parse_document(trust) {
        Ok(doc) => doc,
        Err(e) => return Check::Unknown { message: e },
    };
    let raw: Value = serde_json::from_str(&decode_document(trust)).unwrap_or(Value::Null);
    let provider = issuer_host(issuer);
    let sub = format!("system:serviceaccount:{namespace}:{service_account}");
    let mut best: Option<Vec<String>> = None;
    let mut unsupported = false;
    for stmt in doc.statements.iter().filter(|s| s.effect == Effect::Allow && statement_action_matches(s, WEB_IDENTITY) && federated_provider(s, &provider)) {
        let mut reasons = Vec::new();
        for (key, actual, label) in [("sub", sub.as_str(), "sub"), ("aud", audience, "aud")] {
            let conditions = conditions_for(&raw, stmt.index, &format!("{provider}:{key}"));
            if let Err(why) = key_check(&conditions, actual, label) {
                unsupported |= why.iter().any(|r| r.contains("평가하지 못해요"));
                reasons.extend(why);
            }
        }
        if reasons.is_empty() {
            return Check::Works;
        }
        if best.as_ref().is_none_or(|b| reasons.len() < b.len()) {
            best = Some(reasons);
        }
    }
    match best {
        None => Check::Broken { reasons: vec![NO_PROVIDER.to_string()] },
        Some(reasons) if unsupported => Check::Unknown { message: reasons.join(" · ") },
        Some(reasons) => Check::Broken { reasons },
    }
}

/// Pod Identity 확인: 신뢰 정책이 `pods.eks.amazonaws.com` 서비스에 `sts:AssumeRole`과 `sts:TagSession`을 모두 허용해야 한다.
pub fn check_pod_identity(trust: &str) -> Check {
    let doc = match parse_document(trust) {
        Ok(doc) => doc,
        Err(e) => return Check::Unknown { message: e },
    };
    let entries: Vec<_> = parse_trust(&doc, "").into_iter().filter(|e| e.kind == TrustKind::Service && e.value == POD_IDENTITY_SERVICE).collect();
    let has = |action: &str| entries.iter().any(|e| e.actions.iter().any(|a| a == action));
    let mut reasons = Vec::new();
    if entries.is_empty() {
        reasons.push(format!("{POD_IDENTITY_SERVICE}를 신뢰하지 않아요"));
    } else {
        for action in ["sts:AssumeRole", "sts:TagSession"] {
            if !has(action) {
                reasons.push(format!("{action}를 허용하지 않아요"));
            }
        }
    }
    if reasons.is_empty() {
        Check::Works
    } else {
        Check::Broken { reasons }
    }
}

fn trust_check(trusts: &HashMap<String, TrustText>, arn: &str, check: impl Fn(&str) -> Check) -> Check {
    match trusts.get(arn) {
        Some(Ok(text)) => check(text),
        Some(Err(message)) => Check::Unknown { message: message.clone() },
        None => Check::Unknown { message: "역할을 읽지 않았어요".to_string() },
    }
}

fn slot<'a>(map: &'a mut BTreeMap<(String, String), WorkloadIdentity>, namespace: &str, name: &str, exists: bool) -> &'a mut WorkloadIdentity {
    map.entry((namespace.to_string(), name.to_string())).or_insert_with(|| WorkloadIdentity {
        namespace: namespace.to_string(),
        service_account: name.to_string(),
        exists,
        irsa: None,
        pod_identity: None,
        pods: vec![],
        pod_count: 0,
        notes: vec![],
    })
}

/// 모은 것을 ServiceAccount별로 맞춘다. IRSA 어노테이션이 있거나 Pod Identity 연결이 있는 ServiceAccount만 넣는다.
/// `trusts`는 역할 ARN별 신뢰 정책 글(또는 읽지 못한 이유)이고, `issuer`는 이 클러스터의 OIDC 발급자(없으면 IRSA를 확인하지 못한다).
pub fn assemble(sas: &[SaInfo], pods: &[PodInfo], associations: &[Association], trusts: &HashMap<String, TrustText>, issuer: Option<&str>) -> Vec<WorkloadIdentity> {
    let mut by_sa: BTreeMap<(String, String), WorkloadIdentity> = BTreeMap::new();
    for sa in sas {
        let Some(role) = sa.annotations.get(IRSA_ANNOTATION).filter(|r| !r.is_empty()) else {
            continue;
        };
        let audience = sa.annotations.get(AUDIENCE_ANNOTATION).filter(|a| !a.is_empty()).cloned().unwrap_or_else(|| DEFAULT_AUDIENCE.to_string());
        let check = match issuer {
            None => Check::Unknown { message: "이 클러스터의 OIDC 발급자를 알 수 없어요".to_string() },
            Some(issuer) => trust_check(trusts, role, |text| check_irsa(text, issuer, &sa.namespace, &sa.name, &audience)),
        };
        slot(&mut by_sa, &sa.namespace, &sa.name, true).irsa = Some(IrsaView { role_arn: role.clone(), audience, check });
    }
    for a in associations {
        let exists = sas.iter().any(|s| s.namespace == a.namespace && s.name == a.service_account);
        slot(&mut by_sa, &a.namespace, &a.service_account, exists).pod_identity = Some(PodIdentityView {
            association_id: a.id.clone(),
            role_arn: a.role_arn.clone(),
            target_role_arn: a.target_role_arn.clone(),
            check: trust_check(trusts, &a.role_arn, check_pod_identity),
        });
    }
    for item in by_sa.values_mut() {
        let mut names: Vec<&str> = pods.iter().filter(|p| p.namespace == item.namespace && p.service_account == item.service_account).map(|p| p.name.as_str()).collect();
        names.sort();
        item.pod_count = names.len();
        item.pods = names.into_iter().take(PODS_SHOWN).map(str::to_string).collect();
        if !item.exists {
            item.notes.push("이 이름의 ServiceAccount가 아직 없어요".to_string());
        }
        if item.irsa.is_some() && item.pod_identity.is_some() {
            item.notes.push("IRSA와 Pod Identity가 모두 있어요. 보통 IRSA가 먼저 쓰여요".to_string());
        }
    }
    by_sa.into_values().collect()
}

#[cfg(test)]
mod tests;
