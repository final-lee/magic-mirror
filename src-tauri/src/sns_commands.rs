use tauri::State;
use crate::commands::AppState;
use crate::error::AppError;
use crate::sns::{fetch, model::{SnsSubscriptionRow, SnsTopic}};

#[tauri::command]
pub async fn sns_topic(app: State<'_, AppState>, profile: String, region: String, arn: String) -> Result<SnsTopic, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    fetch::topic(&cfg, &arn, &account, &region).await
}

/// 발행자 찾기. `deep`이면 이 리전의 S3 버킷과 Lambda 함수를 모두 훑는다(화면의 더 찾기 버튼).
#[tauri::command]
pub async fn sns_publishers(app: State<'_, AppState>, profile: String, region: String, arn: String, deep: bool) -> Result<crate::sns::publishers::SnsPublishers, AppError> {
    use crate::sns::publishers;
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    let attrs = aws_sdk_sns::Client::new(&cfg)
        .get_topic_attributes()
        .topic_arn(&arn)
        .send()
        .await
        .map_err(|e| crate::error::from_sdk(e, "sns:GetTopicAttributes"))?;
    let policy = attrs.attributes().and_then(|a| a.get("Policy")).cloned().unwrap_or_default();
    let (mut list, mut errors) = publishers::configured(&cfg, &arn).await;
    let scanned = if deep {
        let (found, scan, deep_errors) = publishers::deep(&cfg, &arn).await;
        list.extend(found);
        errors.extend(deep_errors);
        Some(scan)
    } else {
        None
    };
    list.extend(publishers::policy_allowed(&policy, &account));
    Ok(publishers::SnsPublishers { publishers: publishers::merge(list), scanned, errors })
}
#[tauri::command]
pub async fn sns_subscriptions_all(app: State<'_, AppState>, profile: String, region: String) -> Result<Vec<SnsSubscriptionRow>, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    fetch::subscriptions_all(&cfg).await
}
#[tauri::command]
pub async fn sns_subscribed_topics(app: State<'_, AppState>, profile: String, region: String, endpoint_arn: String) -> Result<Vec<String>, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let mut topics: Vec<_> = fetch::subscriptions_all(&cfg).await?.into_iter().filter(|s| s.endpoint == endpoint_arn).map(|s| s.topic_arn).collect();
    topics.sort(); topics.dedup();
    Ok(topics)
}

#[tauri::command]
pub async fn sns_diagnose(app: State<'_, AppState>, profile: String, region: String, arn: String) -> Result<crate::sns::diagnose::SnsDiagnosisReport, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    let topic = fetch::topic(&cfg, &arn, &account, &region).await?;
    let (evidence, (publishers, errors)) = tokio::join!(
        crate::sns::evidence::fetch(&cfg, &topic),
        crate::sns::publishers::configured(&cfg, &arn),
    );
    let mut report = crate::sns::diagnose::diagnose(&topic, &evidence, &publishers);
    if !errors.is_empty() && topic.overview.kms_key.is_some() {
        report.topic_checks.push(crate::sns::diagnose::SnsCheck {
            id: "publishers".into(), status: "skip".into(), summary: "일부 발행자를 읽지 못해 키 권한을 모두 판단할 수 없어요".into(),
            detail: Some(errors.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n")), fix: None,
        });
    }
    Ok(report)
}

#[tauri::command]
pub async fn sns_topic_policy(app: State<'_, AppState>, profile: String, region: String, arn: String) -> Result<crate::sns::access::SnsTopicPolicy, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::access::topic_policy(&cfg, &arn, &account, &region).await
}

/// 유료 점검(호출당 $0.002). 화면의 버튼을 눌렀을 때만 부른다.
#[tauri::command]
pub async fn sns_check_public_access(app: State<'_, AppState>, profile: String, region: String, arn: String) -> Result<crate::sns::access::PublicAccessReport, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::access::check_public_access(&cfg, &arn, &account, &region).await
}

#[tauri::command]
pub async fn sns_account_overview(app: State<'_, AppState>, profile: String, region: String) -> Result<crate::sns::account::SnsAccountOverview, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::account::overview(&cfg, &account, &region).await
}

#[tauri::command]
pub async fn sns_messaging(app: State<'_, AppState>, profile: String, region: String) -> Result<crate::sns::messaging::SnsMessaging, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    crate::sns::messaging::messaging(&cfg).await
}

#[tauri::command]
pub fn sns_filter_test(policies: Vec<crate::sns::filter_test::FilterInput>, sample: crate::sns::filter::Sample) -> Vec<crate::sns::filter_test::FilterResult> {
    crate::sns::filter_test::test(policies, sample)
}

fn sns_log_path(app: &AppState) -> std::path::PathBuf {
    app.settings_path.with_file_name("sns-changes.jsonl")
}

#[tauri::command]
pub async fn sns_plan(app: State<'_, AppState>, profile: String, region: String, request: crate::sns::change::SnsChangeRequest) -> Result<crate::sns::change::SnsPlan, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::change::plan(&cfg, &sns_log_path(&app), &profile, &region, &account, request).await
}

#[tauri::command]
pub async fn sns_apply(app: State<'_, AppState>, profile: String, region: String, plan: crate::sns::change::SnsPlan) -> Result<crate::sns::change::SnsApplyResult, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::change::apply(&cfg, &sns_log_path(&app), &profile, &region, &account, plan).await
}

#[tauri::command]
pub fn sns_changes(app: State<'_, AppState>, profile: String) -> Vec<crate::sns::change::SnsChangeRecord> {
    crate::sns::change::changes(&sns_log_path(&app), &profile)
}

#[tauri::command]
pub async fn sns_undo_plan(app: State<'_, AppState>, profile: String, region: String, id: String) -> Result<crate::sns::change::SnsPlan, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::change::plan(&cfg, &sns_log_path(&app), &profile, &region, &account, crate::sns::change::SnsChangeRequest::Undo { id }).await
}
