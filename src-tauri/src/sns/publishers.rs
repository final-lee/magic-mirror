//! 주제에 발행하는 쪽 찾기(읽기만). 리소스 설정에 이 주제가 적힌 것(configured)과
//! 주제 정책이 발행을 허용한 주체(policy)를 모은다. SDK로 직접 발행하는 쪽은 CloudTrail 데이터 이벤트 없이는 알 수 없다.

use aws_config::SdkConfig;
use aws_sdk_cloudwatch::types::AlarmType;
use serde::{Deserialize, Serialize};

use crate::adapters::util::{map_concurrent, region};
use crate::error::{from_sdk, AppError};
use crate::iam::policy::action_matches;
use crate::sns::policy::{describe, Reach, StatementView};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Publisher {
    pub kind: String,
    pub name: String,
    pub arn: Option<String>,
    pub principal: Option<String>,
    pub configured: bool,
}

/// 더 찾기(S3 버킷·Lambda 함수 전수 조회)에서 살펴본 개수
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeepScan {
    pub buckets: usize,
    pub functions: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnsPublishers {
    pub publishers: Vec<Publisher>,
    pub scanned: Option<DeepScan>,
    pub errors: Vec<AppError>,
}

fn configured_one(
    kind: &str,
    name: String,
    arn: Option<String>,
    principal: Option<&str>,
) -> Publisher {
    Publisher {
        kind: kind.into(),
        name,
        arn,
        principal: principal.map(Into::into),
        configured: true,
    }
}

/// 리소스 설정에 이 주제가 적힌 발행자: CloudWatch 경보, EventBridge 규칙, RDS 이벤트 구독, ElastiCache 알림.
/// 읽지 못한 출처는 오류로 돌려주고 나머지는 그대로 낸다.
pub async fn configured(cfg: &SdkConfig, topic_arn: &str) -> (Vec<Publisher>, Vec<AppError>) {
    let (alarms, rules, rds, cache) = tokio::join!(
        alarms(cfg, topic_arn),
        rules(cfg, topic_arn),
        rds_subscriptions(cfg, topic_arn),
        cache_clusters(cfg, topic_arn)
    );
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for r in [alarms, rules, rds, cache] {
        match r {
            Ok(p) => out.extend(p),
            Err(e) => errors.push(e),
        }
    }
    (merge(out), errors)
}

async fn alarms(cfg: &SdkConfig, topic_arn: &str) -> Result<Vec<Publisher>, AppError> {
    let client = aws_sdk_cloudwatch::Client::new(cfg);
    let mut pages = client
        .describe_alarms()
        .action_prefix(topic_arn)
        .alarm_types(AlarmType::MetricAlarm)
        .alarm_types(AlarmType::CompositeAlarm)
        .into_paginator()
        .send();
    let mut out = Vec::new();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "cloudwatch:DescribeAlarms"))?;
        for a in page.metric_alarms() {
            let actions = [
                a.alarm_actions(),
                a.ok_actions(),
                a.insufficient_data_actions(),
            ];
            if actions
                .iter()
                .any(|list| list.iter().any(|x| x == topic_arn))
            {
                out.push(configured_one(
                    "alarm",
                    a.alarm_name().unwrap_or_default().into(),
                    a.alarm_arn().map(Into::into),
                    Some("cloudwatch.amazonaws.com"),
                ));
            }
        }
        for a in page.composite_alarms() {
            let actions = [
                a.alarm_actions(),
                a.ok_actions(),
                a.insufficient_data_actions(),
            ];
            if actions
                .iter()
                .any(|list| list.iter().any(|x| x == topic_arn))
            {
                out.push(configured_one(
                    "alarm",
                    a.alarm_name().unwrap_or_default().into(),
                    a.alarm_arn().map(Into::into),
                    Some("cloudwatch.amazonaws.com"),
                ));
            }
        }
    }
    Ok(out)
}

async fn rules(cfg: &SdkConfig, topic_arn: &str) -> Result<Vec<Publisher>, AppError> {
    let client = aws_sdk_eventbridge::Client::new(cfg);
    let mut buses = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let out = client
            .list_event_buses()
            .set_next_token(token.take())
            .send()
            .await
            .map_err(|e| from_sdk(e, "events:ListEventBuses"))?;
        buses.extend(
            out.event_buses()
                .iter()
                .filter_map(|b| b.name().map(String::from)),
        );
        match out.next_token() {
            Some(t) => token = Some(t.into()),
            None => break,
        }
    }
    let results = map_concurrent(buses, |bus| {
        let client = client.clone();
        async move {
            let mut names = Vec::new();
            let mut token: Option<String> = None;
            loop {
                let out = client
                    .list_rule_names_by_target()
                    .target_arn(topic_arn)
                    .event_bus_name(&bus)
                    .set_next_token(token.take())
                    .send()
                    .await
                    .map_err(|e| from_sdk(e, "events:ListRuleNamesByTarget"))?;
                names.extend(out.rule_names().iter().cloned());
                match out.next_token() {
                    Some(t) => token = Some(t.into()),
                    None => break,
                }
            }
            Ok::<_, AppError>(
                names
                    .into_iter()
                    .map(|n| rule_publisher(&bus, &n))
                    .collect::<Vec<_>>(),
            )
        }
    })
    .await;
    let mut out = Vec::new();
    for r in results {
        out.extend(r?);
    }
    Ok(out)
}

/// 기본 버스의 규칙은 이름만, 다른 버스는 `버스/규칙`으로 적는다
pub(crate) fn rule_publisher(bus: &str, rule: &str) -> Publisher {
    let name = if bus == "default" {
        rule.to_string()
    } else {
        format!("{bus}/{rule}")
    };
    configured_one("eventbridge", name, None, Some("events.amazonaws.com"))
}

async fn rds_subscriptions(cfg: &SdkConfig, topic_arn: &str) -> Result<Vec<Publisher>, AppError> {
    let client = aws_sdk_rds::Client::new(cfg);
    let mut pages = client
        .describe_event_subscriptions()
        .into_paginator()
        .send();
    let mut out = Vec::new();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "rds:DescribeEventSubscriptions"))?;
        for s in page.event_subscriptions_list() {
            if s.sns_topic_arn() == Some(topic_arn) {
                out.push(configured_one(
                    "rds",
                    s.cust_subscription_id().unwrap_or_default().into(),
                    s.event_subscription_arn().map(Into::into),
                    Some("events.rds.amazonaws.com"),
                ));
            }
        }
    }
    Ok(out)
}

async fn cache_clusters(cfg: &SdkConfig, topic_arn: &str) -> Result<Vec<Publisher>, AppError> {
    let client = aws_sdk_elasticache::Client::new(cfg);
    let mut pages = client.describe_cache_clusters().into_paginator().send();
    let mut out = Vec::new();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "elasticache:DescribeCacheClusters"))?;
        for c in page.cache_clusters() {
            if c.notification_configuration().and_then(|n| n.topic_arn()) == Some(topic_arn) {
                // 복제 그룹의 노드는 그룹 이름 하나로 묶는다(merge가 중복을 지운다)
                let name = c
                    .replication_group_id()
                    .or(c.cache_cluster_id())
                    .unwrap_or_default();
                let arn = if c.replication_group_id().is_some() {
                    None
                } else {
                    c.arn().map(Into::into)
                };
                out.push(configured_one(
                    "elasticache",
                    name.into(),
                    arn,
                    Some("elasticache.amazonaws.com"),
                ));
            }
        }
    }
    Ok(out)
}

/// 더 찾기: 이 리전 S3 버킷의 이벤트 알림과 Lambda 함수의 비동기 호출 대상.
/// 리소스 수만큼 API를 부르므로 화면의 버튼으로만 돌린다.
pub async fn deep(cfg: &SdkConfig, topic_arn: &str) -> (Vec<Publisher>, DeepScan, Vec<AppError>) {
    let (buckets, functions) = tokio::join!(
        bucket_notifications(cfg, topic_arn),
        function_destinations(cfg, topic_arn)
    );
    let mut out = Vec::new();
    let mut errors = Vec::new();
    let mut scan = DeepScan::default();
    match buckets {
        Ok((p, n, e)) => {
            out.extend(p);
            scan.buckets = n;
            errors.extend(e);
        }
        Err(e) => errors.push(e),
    }
    match functions {
        Ok((p, n, e)) => {
            out.extend(p);
            scan.functions = n;
            errors.extend(e);
        }
        Err(e) => errors.push(e),
    }
    (merge(out), scan, errors)
}

type Scanned = (Vec<Publisher>, usize, Vec<AppError>);

async fn bucket_notifications(cfg: &SdkConfig, topic_arn: &str) -> Result<Scanned, AppError> {
    let client = aws_sdk_s3::Client::new(cfg);
    let mut names = Vec::new();
    let mut pages = client
        .list_buckets()
        .bucket_region(region(cfg))
        .into_paginator()
        .send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "s3:ListAllMyBuckets"))?;
        names.extend(
            page.buckets()
                .iter()
                .filter_map(|b| b.name().map(String::from)),
        );
    }
    let count = names.len();
    let results = map_concurrent(names, |bucket| {
        let client = client.clone();
        async move {
            let out = client
                .get_bucket_notification_configuration()
                .bucket(&bucket)
                .send()
                .await
                .map_err(|e| from_sdk(e, "s3:GetBucketNotification"))?;
            let hit = out
                .topic_configurations()
                .iter()
                .any(|t| t.topic_arn() == topic_arn);
            Ok::<_, AppError>(hit.then(|| {
                configured_one(
                    "s3",
                    bucket.clone(),
                    Some(format!("arn:aws:s3:::{bucket}")),
                    Some("s3.amazonaws.com"),
                )
            }))
        }
    })
    .await;
    Ok(split(results, count))
}

async fn function_destinations(cfg: &SdkConfig, topic_arn: &str) -> Result<Scanned, AppError> {
    let client = aws_sdk_lambda::Client::new(cfg);
    let mut functions = Vec::new();
    let mut pages = client.list_functions().into_paginator().send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "lambda:ListFunctions"))?;
        functions.extend(page.functions().iter().filter_map(|f| {
            Some((
                f.function_name()?.to_string(),
                f.function_arn().map(String::from),
            ))
        }));
    }
    let count = functions.len();
    let results = map_concurrent(functions, |(name, arn)| {
        let client = client.clone();
        async move {
            let mut pages = client
                .list_function_event_invoke_configs()
                .function_name(&name)
                .into_paginator()
                .send();
            let mut hit = false;
            while let Some(page) = pages.next().await {
                let page =
                    page.map_err(|e| from_sdk(e, "lambda:ListFunctionEventInvokeConfigs"))?;
                hit |= page.function_event_invoke_configs().iter().any(|c| {
                    let dest = c.destination_config();
                    let on_success = dest
                        .and_then(|d| d.on_success())
                        .and_then(|d| d.destination());
                    let on_failure = dest
                        .and_then(|d| d.on_failure())
                        .and_then(|d| d.destination());
                    destination_matches(on_success, topic_arn)
                        || destination_matches(on_failure, topic_arn)
                });
            }
            // 대상으로 발행하는 주체는 함수의 실행 역할이라 서비스 주체가 없다
            Ok::<_, AppError>(
                hit.then(|| configured_one("lambda", name.clone(), arn.clone(), None)),
            )
        }
    })
    .await;
    Ok(split(results, count))
}

/// 별칭·버전이 붙은 대상 ARN도 같은 주제로 본다(대상은 주제 ARN 그대로라 비교만 한다)
pub(crate) fn destination_matches(destination: Option<&str>, topic_arn: &str) -> bool {
    destination == Some(topic_arn)
}

fn split(results: Vec<Result<Option<Publisher>, AppError>>, count: usize) -> Scanned {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for r in results {
        match r {
            Ok(Some(p)) => out.push(p),
            Ok(None) => {}
            Err(e) => errors.push(e),
        }
    }
    // 같은 권한 오류가 리소스마다 나면 하나만 남긴다
    errors.dedup();
    (out, count, errors)
}

/// 주제 정책이 `sns:Publish`를 허용한 주체. 설정에서 찾은 것과 달리 실제로 발행하는지는 모른다.
pub fn policy_allowed(policy_json: &str, own_account: &str) -> Vec<Publisher> {
    match describe(policy_json, own_account) {
        Ok(views) => merge(views.iter().flat_map(statement_publishers).collect()),
        Err(_) => Vec::new(),
    }
}

/// 주제의 발행자 찾기. 현재 계정·리전의 주제가 아니면 AWS를 읽기 전에 거절한다.
pub async fn find(
    cfg: &SdkConfig,
    account: &str,
    region: &str,
    topic_arn: &str,
    deep_scan: bool,
) -> Result<SnsPublishers, AppError> {
    if !crate::sns::findings::is_own_topic(topic_arn, account, region) {
        return Err(AppError::other("현재 계정과 리전의 주제만 읽을 수 있어요"));
    }
    let attrs = aws_sdk_sns::Client::new(cfg)
        .get_topic_attributes()
        .topic_arn(topic_arn)
        .send()
        .await
        .map_err(|e| from_sdk(e, "sns:GetTopicAttributes"))?;
    let policy = attrs
        .attributes()
        .and_then(|a| a.get("Policy"))
        .cloned()
        .unwrap_or_default();
    let (mut list, mut errors) = configured(cfg, topic_arn).await;
    let scanned = if deep_scan {
        let (found, scan, deep_errors) = deep(cfg, topic_arn).await;
        list.extend(found);
        errors.extend(deep_errors);
        Some(scan)
    } else {
        None
    };
    list.extend(policy_allowed(&policy, account));
    Ok(SnsPublishers {
        publishers: merge(list),
        scanned,
        errors,
    })
}

pub(crate) fn statement_publishers(v: &StatementView) -> Vec<Publisher> {
    let publishes = !v.not_action && v.actions.iter().any(|a| action_matches(a, "sns:Publish"));
    if v.effect != "Allow" || !publishes {
        return Vec::new();
    }
    v.principals
        .iter()
        .map(|p| {
            let (name, principal) = match p.kind.as_str() {
                "service" => (p.value.clone(), Some(p.value.clone())),
                "anyone" if v.scope == Reach::SameAccount => {
                    ("이 계정 안의 주체".to_string(), None)
                }
                "anyone" => ("모든 주체(*)".to_string(), None),
                "account" => {
                    let id = p.account.clone().unwrap_or_else(|| p.value.clone());
                    (
                        if v.scope == Reach::SameAccount {
                            "이 계정 안의 주체".to_string()
                        } else {
                            format!("계정 {id}")
                        },
                        None,
                    )
                }
                _ => (p.value.clone(), None),
            };
            Publisher {
                kind: "policy".into(),
                name,
                arn: None,
                principal,
                configured: false,
            }
        })
        .collect()
}

/// 같은 종류·이름은 하나로. 설정에서 찾은 것을 앞에, 그 안에서는 종류·이름 순.
pub(crate) fn merge(mut list: Vec<Publisher>) -> Vec<Publisher> {
    list.sort_by(|a, b| (!a.configured, &a.kind, &a.name).cmp(&(!b.configured, &b.kind, &b.name)));
    list.dedup_by(|a, b| a.kind == b.kind && a.name == b.name);
    list
}

#[cfg(test)]
mod tests;
