use crate::commands::AppState;
use crate::error::AppError;
use crate::sns::{
    fetch,
    model::{SnsSubscriptionRow, SnsTopic},
};
use tauri::State;

#[tauri::command]
pub async fn sns_topic(
    app: State<'_, AppState>,
    profile: String,
    region: String,
    arn: String,
) -> Result<SnsTopic, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    fetch::topic(&cfg, &arn, &account, &region).await
}

/// 발행자 찾기. `deep`이면 이 리전의 S3 버킷과 Lambda 함수를 모두 훑는다(화면의 더 찾기 버튼).
#[tauri::command]
pub async fn sns_publishers(
    app: State<'_, AppState>,
    profile: String,
    region: String,
    arn: String,
    deep: bool,
) -> Result<crate::sns::publishers::SnsPublishers, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::publishers::find(&cfg, &account, &region, &arn, deep).await
}
#[tauri::command]
pub async fn sns_subscriptions_all(
    app: State<'_, AppState>,
    profile: String,
    region: String,
) -> Result<Vec<SnsSubscriptionRow>, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    fetch::subscriptions_all(&cfg).await
}
#[tauri::command]
pub async fn sns_subscribed_topics(
    app: State<'_, AppState>,
    profile: String,
    region: String,
    endpoint_arn: String,
) -> Result<Vec<String>, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let mut topics: Vec<_> = fetch::subscriptions_all(&cfg)
        .await?
        .into_iter()
        .filter(|s| s.endpoint == endpoint_arn)
        .map(|s| s.topic_arn)
        .collect();
    topics.sort();
    topics.dedup();
    Ok(topics)
}

#[tauri::command]
pub async fn sns_diagnose(
    app: State<'_, AppState>,
    profile: String,
    region: String,
    arn: String,
) -> Result<crate::sns::diagnose::SnsDiagnosisReport, AppError> {
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
            id: "publishers".into(),
            status: "skip".into(),
            summary: "일부 발행자를 읽지 못해 키 권한을 모두 판단할 수 없어요".into(),
            detail: Some(
                errors
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            fix: None,
        });
    }
    Ok(report)
}

#[tauri::command]
pub async fn sns_topic_policy(
    app: State<'_, AppState>,
    profile: String,
    region: String,
    arn: String,
) -> Result<crate::sns::access::SnsTopicPolicy, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::access::topic_policy(&cfg, &arn, &account, &region).await
}

/// 유료 점검(호출당 $0.002). 화면의 버튼을 눌렀을 때만 부른다.
#[tauri::command]
pub async fn sns_check_public_access(
    app: State<'_, AppState>,
    profile: String,
    region: String,
    arn: String,
) -> Result<crate::sns::access::PublicAccessReport, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::access::check_public_access(&cfg, &arn, &account, &region).await
}

#[tauri::command]
pub async fn sns_account_overview(
    app: State<'_, AppState>,
    profile: String,
    region: String,
) -> Result<crate::sns::account::SnsAccountOverview, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::account::overview(&cfg, &account, &region).await
}

#[tauri::command]
pub async fn sns_messaging(
    app: State<'_, AppState>,
    profile: String,
    region: String,
) -> Result<crate::sns::messaging::SnsMessaging, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    crate::sns::messaging::messaging(&cfg).await
}

#[tauri::command]
pub fn sns_filter_test(
    policies: Vec<crate::sns::filter_test::FilterInput>,
    sample: crate::sns::filter::Sample,
) -> Vec<crate::sns::filter_test::FilterResult> {
    crate::sns::filter_test::test(policies, sample)
}

fn sns_log_path(app: &AppState) -> std::path::PathBuf {
    app.settings_path.with_file_name("sns-changes.jsonl")
}

#[tauri::command]
pub async fn sns_plan(
    app: State<'_, AppState>,
    profile: String,
    region: String,
    request: crate::sns::change::SnsChangeRequest,
) -> Result<crate::sns::change::SnsPlan, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::change::plan(
        &cfg,
        &sns_log_path(&app),
        &profile,
        &region,
        &account,
        request,
    )
    .await
}

#[tauri::command]
pub async fn sns_apply(
    app: State<'_, AppState>,
    profile: String,
    region: String,
    plan: crate::sns::change::SnsPlan,
) -> Result<crate::sns::change::SnsApplyResult, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::change::apply(&cfg, &sns_log_path(&app), &profile, &region, &account, plan).await
}

#[tauri::command]
pub fn sns_changes(
    app: State<'_, AppState>,
    profile: String,
) -> Vec<crate::sns::change::SnsChangeRecord> {
    crate::sns::change::changes(&sns_log_path(&app), &profile)
}

#[tauri::command]
pub async fn sns_undo_plan(
    app: State<'_, AppState>,
    profile: String,
    region: String,
    id: String,
) -> Result<crate::sns::change::SnsPlan, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::change::plan(
        &cfg,
        &sns_log_path(&app),
        &profile,
        &region,
        &account,
        crate::sns::change::SnsChangeRequest::Undo { id },
    )
    .await
}

#[tauri::command]
pub async fn sns_peek_eligibility(
    app: State<'_, AppState>,
    state: State<'_, crate::sns::peek::PeekState>,
    profile: String,
    region: String,
    topic_arn: String,
) -> Result<Vec<crate::sns::peek::PeekVerdict>, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::peek::verdicts(
        &cfg,
        &sns_log_path(&app),
        &state,
        &profile,
        &region,
        &account,
        &topic_arn,
    )
    .await
}

#[tauri::command]
pub async fn sns_peek_start(
    handle: tauri::AppHandle,
    app: State<'_, AppState>,
    state: State<'_, crate::sns::peek::PeekState>,
    profile: String,
    region: String,
    topic_arn: String,
    queue_arn: String,
    follow: bool,
    confirmed_name: Option<String>,
) -> Result<String, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    crate::sns::peek::start(
        handle,
        cfg,
        sns_log_path(&app),
        (*state).clone(),
        profile,
        region,
        account,
        topic_arn,
        queue_arn,
        follow,
        confirmed_name,
    )
    .await
}

#[tauri::command]
pub async fn sns_peek_stop(
    state: State<'_, crate::sns::peek::PeekState>,
    session: String,
) -> Result<(), AppError> {
    state.stop(&session).await;
    Ok(())
}

/// 정책 저장 미리보기: 저장하기 전 문서의 무료 `ValidatePolicy` 지적
#[tauri::command]
pub async fn sns_validate_policy(
    app: State<'_, AppState>,
    profile: String,
    region: String,
    document: String,
) -> Result<Vec<crate::sns::access::PolicyFindingView>, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    crate::sns::access::validate_document(&cfg, &document).await
}

/// 정책 저장 미리보기의 유료(호출당 $0.002) 공개 접근 검사. 버튼을 눌렀을 때만 부른다
#[tauri::command]
pub async fn sns_check_policy_document(
    app: State<'_, AppState>,
    profile: String,
    region: String,
    arn: String,
    document: String,
) -> Result<crate::sns::access::PublicAccessReport, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    let account = app.ctx.account_id(&profile).await?;
    if !crate::sns::findings::is_own_topic(&arn, &account, &region) {
        return Err(AppError::other(
            "현재 계정과 리전의 주제만 점검할 수 있어요",
        ));
    }
    crate::sns::access::check_document(&cfg, &arn, &document).await
}

/// 배달 상태 로깅에 고를 수 있는 기존 IAM 역할(SNS를 신뢰하는 역할)
#[tauri::command]
pub async fn sns_logging_roles(
    app: State<'_, AppState>,
    profile: String,
    region: String,
) -> Result<Vec<crate::sns::roles::SnsRole>, AppError> {
    let cfg = app.ctx.config(&profile, &region).await?;
    crate::sns::roles::list(&cfg).await
}
