//! SMS·모바일 푸시 읽기. 읽기만 한다(`sns:GetSMS*`, `sns:ListSMSSandboxPhoneNumbers`, `sns:ListOriginationNumbers`,
//! `sns:ListPlatformApplications`, `sns:ListEndpointsByPlatformApplication`, `cloudwatch:GetMetricData`).
//! 샌드박스 전화번호는 확인 대상자의 개인정보라 `sns::mask`로 가려서 돌려준다. 푸시 엔드포인트는 개수만 센다(토큰은 읽어도 쓰지 않는다).

use super::mask;
use crate::adapters::util::map_concurrent;
use crate::error::{from_sdk, AppError};
use crate::model::MAX_ITEMS;
use aws_config::SdkConfig;
use aws_sdk_cloudwatch::primitives::DateTime;
use aws_sdk_cloudwatch::types::{Metric, MetricDataQuery, MetricStat};
use serde::Serialize;
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// 엔드포인트 개수를 세는 상한(애플리케이션마다). 넘으면 "이상"으로 보여 준다.
pub const MAX_ENDPOINTS: usize = MAX_ITEMS;
const MAX_PAGES: usize = 10;

#[derive(Debug, Clone, Serialize)]
pub struct SandboxNumber {
    /// 가린 번호
    pub phone: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginationNumber {
    pub phone_number: String,
    pub status: String,
    pub country: Option<String>,
    pub route_type: Option<String>,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmsInfo {
    /// `None`이면 읽지 못했다
    pub sandbox: Option<bool>,
    pub sandbox_numbers: Vec<SandboxNumber>,
    pub origination_numbers: Vec<OriginationNumber>,
    pub attributes: BTreeMap<String, String>,
    /// 이번 달 지출(USD, 가장 최근 값)
    pub month_spent_usd: Option<f64>,
    /// 지난 24시간 성공률(%, 시간별 평균의 평균)
    pub success_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformApp {
    pub arn: String,
    pub name: String,
    pub platform: String,
    pub enabled: Option<bool>,
    /// 인증서 만료일(`AppleCertificateExpirationDate` 속성)
    pub cert_expiry: Option<String>,
    pub attributes: BTreeMap<String, String>,
    pub endpoints: u64,
    pub disabled_endpoints: u64,
    /// `endpoints`가 상한에서 멈춘 값이다
    pub endpoints_truncated: bool,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsMessaging {
    pub sms: SmsInfo,
    pub apps: Vec<PlatformApp>,
    pub errors: Vec<AppError>,
}

/// 화면에 보여도 되는 플랫폼 애플리케이션 속성. 자격 증명(`PlatformCredential`·`PlatformPrincipal`)은 모두 뺀다.
const SAFE_APP_ATTRIBUTES: &[&str] = &[
    "Enabled",
    "AppleCertificateExpirationDate",
    "EventEndpointCreated",
    "EventEndpointDeleted",
    "EventEndpointUpdated",
    "EventDeliveryFailure",
    "SuccessFeedbackRoleArn",
    "FailureFeedbackRoleArn",
    "SuccessFeedbackSampleRate",
];

/// `arn:aws:sns:<region>:<account>:app/<PLATFORM>/<name>`
pub fn split_app_arn(arn: &str) -> (String, String) {
    let resource = arn.rsplit(':').next().unwrap_or(arn);
    let mut parts = resource.splitn(3, '/');
    let (_, platform, name) = (parts.next(), parts.next(), parts.next());
    match (platform, name) {
        (Some(p), Some(n)) => (p.into(), n.into()),
        _ => (String::new(), resource.into()),
    }
}

pub fn app_view(arn: &str, attributes: &std::collections::HashMap<String, String>) -> PlatformApp {
    let (platform, name) = split_app_arn(arn);
    let visible: BTreeMap<String, String> = attributes
        .iter()
        .filter(|(k, _)| SAFE_APP_ATTRIBUTES.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    PlatformApp {
        arn: arn.into(),
        name,
        platform,
        enabled: attributes.get("Enabled").map(|v| v == "true"),
        cert_expiry: attributes
            .get("AppleCertificateExpirationDate")
            .filter(|v| !v.is_empty())
            .cloned(),
        attributes: visible,
        endpoints: 0,
        disabled_endpoints: 0,
        endpoints_truncated: false,
        error: None,
    }
}

/// 가장 최근 시각의 값
pub fn latest(timestamps: &[i64], values: &[f64]) -> Option<f64> {
    timestamps
        .iter()
        .zip(values)
        .max_by_key(|(t, _)| **t)
        .map(|(_, v)| *v)
}

pub fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

fn query(id: &str, name: &str, stat: &str) -> MetricDataQuery {
    let metric = Metric::builder()
        .namespace("AWS/SNS")
        .metric_name(name)
        .build();
    MetricDataQuery::builder()
        .id(id)
        .metric_stat(
            MetricStat::builder()
                .metric(metric)
                .period(3600)
                .stat(stat)
                .build(),
        )
        .return_data(true)
        .build()
}

/// (이번 달 지출, 지난 24시간 성공률). 지표는 SMS를 보낸 적이 있어야 생긴다.
async fn sms_metrics(cfg: &SdkConfig) -> Result<(Option<f64>, Option<f64>), AppError> {
    let end = now_secs();
    let reply = aws_sdk_cloudwatch::Client::new(cfg)
        .get_metric_data()
        .metric_data_queries(query("spent", "SMSMonthToDateSpentUSD", "Maximum"))
        .metric_data_queries(query("rate", "SMSSuccessRate", "Average"))
        .start_time(DateTime::from_secs(end - 24 * 3600))
        .end_time(DateTime::from_secs(end))
        .send()
        .await
        .map_err(|e| from_sdk(e, "cloudwatch:GetMetricData"))?;
    let (mut spent, mut rate) = (None, None);
    for r in reply.metric_data_results() {
        let times: Vec<i64> = r.timestamps().iter().map(|t| t.secs()).collect();
        match r.id() {
            Some("spent") => spent = latest(&times, r.values()),
            Some("rate") => rate = mean(r.values()),
            _ => {}
        }
    }
    Ok((spent, rate))
}

fn fatal(e: &AppError) -> bool {
    matches!(e, AppError::SsoExpired | AppError::Throttled)
}

/// 오류를 모은다. 다시 로그인하거나 잠시 뒤에 하면 되는 오류는 화면 전체의 오류로 올린다.
fn keep<T>(result: Result<T, AppError>, errors: &mut Vec<AppError>) -> Result<Option<T>, AppError> {
    match result {
        Ok(v) => Ok(Some(v)),
        Err(e) if fatal(&e) => Err(e),
        Err(e) => {
            if !errors.contains(&e) {
                errors.push(e);
            }
            Ok(None)
        }
    }
}

async fn sms(cfg: &SdkConfig, errors: &mut Vec<AppError>) -> Result<SmsInfo, AppError> {
    let client = aws_sdk_sns::Client::new(cfg);
    let sandbox = keep(
        client
            .get_sms_sandbox_account_status()
            .send()
            .await
            .map(|o| o.is_in_sandbox())
            .map_err(|e| from_sdk(e, "sns:GetSMSSandboxAccountStatus")),
        errors,
    )?;

    let mut sandbox_numbers = Vec::new();
    if sandbox != Some(false) {
        let mut pages = client
            .list_sms_sandbox_phone_numbers()
            .into_paginator()
            .send();
        for _ in 0..MAX_PAGES {
            let Some(page) = pages.next().await else {
                break;
            };
            let Some(page) = keep(
                page.map_err(|e| from_sdk(e, "sns:ListSMSSandboxPhoneNumbers")),
                errors,
            )?
            else {
                break;
            };
            sandbox_numbers.extend(page.phone_numbers().iter().map(|n| {
                SandboxNumber {
                    phone: mask::endpoint("sms", n.phone_number().unwrap_or_default()),
                    status: n
                        .status()
                        .map(|s| s.as_str().to_owned())
                        .unwrap_or_default(),
                }
            }));
        }
    }

    let mut origination_numbers = Vec::new();
    let mut pages = client.list_origination_numbers().into_paginator().send();
    for _ in 0..MAX_PAGES {
        let Some(page) = pages.next().await else {
            break;
        };
        let Some(page) = keep(
            page.map_err(|e| from_sdk(e, "sns:ListOriginationNumbers")),
            errors,
        )?
        else {
            break;
        };
        origination_numbers.extend(page.phone_numbers().iter().map(|n| {
            OriginationNumber {
                phone_number: n.phone_number().unwrap_or_default().into(),
                status: n.status().unwrap_or_default().into(),
                country: n.iso2_country_code().map(str::to_owned),
                route_type: n.route_type().map(|r| r.as_str().to_owned()),
                capabilities: n
                    .number_capabilities()
                    .iter()
                    .map(|c| c.as_str().to_owned())
                    .collect(),
            }
        }));
    }

    let attributes = keep(
        client
            .get_sms_attributes()
            .send()
            .await
            .map(|o| o.attributes().cloned().unwrap_or_default())
            .map_err(|e| from_sdk(e, "sns:GetSMSAttributes")),
        errors,
    )?
    .unwrap_or_default()
    .into_iter()
    .collect();
    let (month_spent_usd, success_rate) = keep(sms_metrics(cfg).await, errors)?.unwrap_or_default();
    Ok(SmsInfo {
        sandbox,
        sandbox_numbers,
        origination_numbers,
        attributes,
        month_spent_usd,
        success_rate,
    })
}

/// 엔드포인트 수와 비활성 수. 상한을 넘으면 거기서 멈춘다.
async fn count_endpoints(
    client: &aws_sdk_sns::Client,
    arn: &str,
) -> Result<(u64, u64, bool), AppError> {
    let mut pages = client
        .list_endpoints_by_platform_application()
        .platform_application_arn(arn)
        .into_paginator()
        .send();
    let (mut total, mut disabled) = (0u64, 0u64);
    while let Some(page) = pages.next().await {
        for e in page
            .map_err(|e| from_sdk(e, "sns:ListEndpointsByPlatformApplication"))?
            .endpoints()
        {
            if total as usize >= MAX_ENDPOINTS {
                return Ok((total, disabled, true));
            }
            total += 1;
            if e.attributes()
                .and_then(|a| a.get("Enabled"))
                .is_some_and(|v| v == "false")
            {
                disabled += 1;
            }
        }
    }
    Ok((total, disabled, false))
}

async fn push(cfg: &SdkConfig) -> Result<(Vec<PlatformApp>, Vec<AppError>), AppError> {
    let client = aws_sdk_sns::Client::new(cfg);
    let mut errors = Vec::new();
    let mut apps = Vec::new();
    let mut pages = client.list_platform_applications().into_paginator().send();
    while let Some(page) = pages.next().await {
        let Some(page) = keep(
            page.map_err(|e| from_sdk(e, "sns:ListPlatformApplications")),
            &mut errors,
        )?
        else {
            break;
        };
        apps.extend(page.platform_applications().iter().filter_map(|a| {
            a.platform_application_arn()
                .map(|arn| app_view(arn, a.attributes().unwrap_or(&Default::default())))
        }));
        if apps.len() >= MAX_ITEMS {
            break;
        }
    }
    let counted = map_concurrent(apps, |mut app| {
        let client = client.clone();
        async move {
            match count_endpoints(&client, &app.arn).await {
                Ok((total, disabled, truncated)) => {
                    app.endpoints = total;
                    app.disabled_endpoints = disabled;
                    app.endpoints_truncated = truncated;
                }
                Err(e) => app.error = Some(e),
            }
            app
        }
    })
    .await;
    if let Some(e) = counted
        .iter()
        .filter_map(|a| a.error.as_ref())
        .find(|e| fatal(e))
    {
        return Err(e.clone());
    }
    Ok((counted, errors))
}

pub async fn messaging(cfg: &SdkConfig) -> Result<SnsMessaging, AppError> {
    let mut errors = Vec::new();
    let sms = sms(cfg, &mut errors).await?;
    let (apps, push_errors) = push(cfg).await?;
    errors.extend(push_errors);
    Ok(SnsMessaging { sms, apps, errors })
}

#[cfg(test)]
mod tests;
