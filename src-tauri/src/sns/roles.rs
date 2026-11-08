//! 배달 상태 로깅에 쓸 IAM 역할: SNS(`sns.amazonaws.com`)를 신뢰하는 기존 역할을 읽기만 한다(`iam:ListRoles`, `iam:GetRole`). 역할은 만들지 않는다.
use crate::error::{from_sdk, AppError};
use crate::iam::policy::decode_document;
use aws_config::SdkConfig;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsRole {
    pub name: String,
    pub arn: String,
}

/// 신뢰 정책이 SNS 서비스 주체에게 `sts:AssumeRole`을 허용하는가
pub fn trusts_sns(trust_document: &str) -> bool {
    let Ok(doc) = serde_json::from_str::<Value>(&decode_document(trust_document)) else {
        return false;
    };
    let statements = match doc.get("Statement") {
        Some(Value::Array(a)) => a.clone(),
        Some(one @ Value::Object(_)) => vec![one.clone()],
        _ => return false,
    };
    statements.iter().any(|s| {
        if s.get("Effect").and_then(Value::as_str) != Some("Allow") {
            return false;
        }
        let assume = match s.get("Action") {
            Some(Value::String(a)) => vec![a.as_str()],
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
            _ => vec![],
        };
        if !assume.iter().any(|a| {
            a.eq_ignore_ascii_case("sts:AssumeRole") || *a == "*" || a.eq_ignore_ascii_case("sts:*")
        }) {
            return false;
        }
        match s.get("Principal").and_then(|p| p.get("Service")) {
            Some(Value::String(v)) => v == "sns.amazonaws.com",
            Some(Value::Array(a)) => a.iter().any(|v| v.as_str() == Some("sns.amazonaws.com")),
            _ => false,
        }
    })
}

/// 같은 계정의 IAM 역할 ARN인가(그 밖의 계정·종류는 고를 수 없다). 문제가 있으면 이유
pub fn role_problem(arn: &str, account: &str) -> Option<&'static str> {
    let p: Vec<_> = arn.splitn(6, ':').collect();
    if p.len() != 6 || p[0] != "arn" || p[2] != "iam" {
        return Some("IAM 역할 ARN을 고르세요");
    }
    if p[4] != account {
        return Some("현재 계정의 역할만 쓸 수 있어요");
    }
    if !p[5].starts_with("role/") || p[5].len() <= 5 {
        return Some("IAM 역할 ARN을 고르세요");
    }
    None
}

fn role_name(arn: &str) -> &str {
    arn.rsplit('/').next().unwrap_or(arn)
}

/// SNS를 신뢰하는 기존 역할 목록(이름순)
pub async fn list(cfg: &SdkConfig) -> Result<Vec<SnsRole>, AppError> {
    let client = aws_sdk_iam::Client::new(cfg);
    let mut pages = client.list_roles().into_paginator().send();
    let mut roles = Vec::new();
    while let Some(page) = pages.next().await {
        for role in page.map_err(|e| from_sdk(e, "iam:ListRoles"))?.roles() {
            if role.assume_role_policy_document().is_some_and(trusts_sns) {
                roles.push(SnsRole {
                    name: role.role_name().into(),
                    arn: role.arn().into(),
                });
            }
        }
    }
    roles.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(roles)
}

/// 역할이 SNS를 신뢰하는지 읽는다. 읽을 권한이 없으면 `None`(호출한 쪽이 경고로 알린다)
pub async fn trusted(cfg: &SdkConfig, arn: &str) -> Result<Option<bool>, AppError> {
    match aws_sdk_iam::Client::new(cfg)
        .get_role()
        .role_name(role_name(arn))
        .send()
        .await
    {
        Ok(out) => Ok(Some(
            out.role()
                .and_then(|r| r.assume_role_policy_document())
                .is_some_and(trusts_sns),
        )),
        Err(e) => match from_sdk(e, "iam:GetRole") {
            AppError::AccessDenied { .. } => Ok(None),
            other => Err(other),
        },
    }
}

#[cfg(test)]
mod tests;
