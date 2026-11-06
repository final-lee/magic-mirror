//! SNS 워크스페이스의 변경 API는 이 모듈에만 둔다.
use aws_config::SdkConfig;
use serde_json::Value;
use crate::error::{AppError, from_sdk};
use super::change::SnsCall;

pub async fn execute(cfg: &SdkConfig, call: &SnsCall) -> Result<(), AppError> {
    let value = |key: &str| call.body.get(key).and_then(Value::as_str).ok_or_else(|| AppError::other("변경 요청이 올바르지 않아요"));
    match call.api.as_str() {
        "sqs:SetQueueAttributes" => {
            aws_sdk_sqs::Client::new(cfg).set_queue_attributes().queue_url(&call.target)
                .attributes(aws_sdk_sqs::types::QueueAttributeName::Policy, value("Policy")?)
                .send().await.map_err(|e| from_sdk(e, "sqs:SetQueueAttributes"))?;
        }
        "sns:SetSubscriptionAttributes" => {
            aws_sdk_sns::Client::new(cfg).set_subscription_attributes().subscription_arn(&call.target)
                .attribute_name("RedrivePolicy").attribute_value(value("RedrivePolicy")?)
                .send().await.map_err(|e| from_sdk(e, "sns:SetSubscriptionAttributes"))?;
        }
        "lambda:AddPermission" => {
            aws_sdk_lambda::Client::new(cfg).add_permission().function_name(&call.target)
                .statement_id(value("StatementId")?).action("lambda:InvokeFunction")
                .principal("sns.amazonaws.com").source_arn(value("SourceArn")?)
                .send().await.map_err(|e| from_sdk(e, "lambda:AddPermission"))?;
        }
        "lambda:RemovePermission" => {
            aws_sdk_lambda::Client::new(cfg).remove_permission().function_name(&call.target)
                .statement_id(value("StatementId")?).send().await.map_err(|e| from_sdk(e, "lambda:RemovePermission"))?;
        }
        _ => return Err(AppError::other("지원하지 않는 변경이에요")),
    }
    Ok(())
}
