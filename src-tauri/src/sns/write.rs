//! SNS 워크스페이스의 변경 API는 이 모듈에만 둔다.
use super::change::SnsCall;
use crate::error::{from_sdk, AppError};
use aws_config::SdkConfig;
use serde_json::Value;

pub async fn execute(cfg: &SdkConfig, call: &SnsCall) -> Result<(), AppError> {
    let value = |key: &str| {
        call.body
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::other("변경 요청이 올바르지 않아요"))
    };
    match call.api.as_str() {
        "sqs:SetQueueAttributes" => {
            aws_sdk_sqs::Client::new(cfg)
                .set_queue_attributes()
                .queue_url(&call.target)
                .attributes(
                    aws_sdk_sqs::types::QueueAttributeName::Policy,
                    value("Policy")?,
                )
                .send()
                .await
                .map_err(|e| from_sdk(e, "sqs:SetQueueAttributes"))?;
        }
        "sns:SetSubscriptionAttributes" => {
            // 본문에는 속성 하나만 있다: 이름이 곧 본문의 키
            let (name, attr) = SUBSCRIPTION_ATTRIBUTES
                .iter()
                .find_map(|k| call.body.get(*k).and_then(Value::as_str).map(|v| (*k, v)))
                .ok_or_else(|| AppError::other("변경 요청이 올바르지 않아요"))?;
            aws_sdk_sns::Client::new(cfg)
                .set_subscription_attributes()
                .subscription_arn(&call.target)
                .attribute_name(name)
                .attribute_value(attr)
                .send()
                .await
                .map_err(|e| from_sdk(e, "sns:SetSubscriptionAttributes"))?;
        }
        "sns:SetTopicAttributes" => {
            let (name, attr) = call
                .body
                .as_object()
                .and_then(|m| {
                    m.iter().find_map(|(k, v)| {
                        if topic_attribute(k) {
                            v.as_str().map(|v| (k.as_str(), v))
                        } else {
                            None
                        }
                    })
                })
                .ok_or_else(|| AppError::other("변경 요청이 올바르지 않아요"))?;
            aws_sdk_sns::Client::new(cfg)
                .set_topic_attributes()
                .topic_arn(&call.target)
                .attribute_name(name)
                .attribute_value(attr)
                .send()
                .await
                .map_err(|e| from_sdk(e, "sns:SetTopicAttributes"))?;
        }
        "sns:Unsubscribe" => {
            aws_sdk_sns::Client::new(cfg)
                .unsubscribe()
                .subscription_arn(&call.target)
                .send()
                .await
                .map_err(|e| from_sdk(e, "sns:Unsubscribe"))?;
        }
        "lambda:AddPermission" => {
            aws_sdk_lambda::Client::new(cfg)
                .add_permission()
                .function_name(&call.target)
                .statement_id(value("StatementId")?)
                .action("lambda:InvokeFunction")
                .principal("sns.amazonaws.com")
                .source_arn(value("SourceArn")?)
                .send()
                .await
                .map_err(|e| from_sdk(e, "lambda:AddPermission"))?;
        }
        "lambda:RemovePermission" => {
            aws_sdk_lambda::Client::new(cfg)
                .remove_permission()
                .function_name(&call.target)
                .statement_id(value("StatementId")?)
                .send()
                .await
                .map_err(|e| from_sdk(e, "lambda:RemovePermission"))?;
        }
        _ => return Err(AppError::other("지원하지 않는 변경이에요")),
    }
    Ok(())
}

/// 구독 속성 호출의 본문 키로 쓸 수 있는 이름. 뒤 단계가 구독 속성을 더하면 여기에 더한다
const SUBSCRIPTION_ATTRIBUTES: [&str; 6] = [
    "RedrivePolicy",
    "FilterPolicy",
    "FilterPolicyScope",
    "RawMessageDelivery",
    "DeliveryPolicy",
    "ReplayPolicy",
];

/// 주제 속성 호출의 본문 키로 쓸 수 있는 이름: 정책, 배달 정책, 프로토콜별 배달 상태 로깅. 뒤 단계가 주제 속성을 더하면 여기에 더한다
pub fn topic_attribute(name: &str) -> bool {
    matches!(name, "Policy" | "DeliveryPolicy" | "ArchivePolicy")
        || ["Lambda", "SQS", "HTTP", "Application", "Firehose"]
            .iter()
            .any(|p| {
                name.strip_prefix(p).is_some_and(|rest| {
                    matches!(
                        rest,
                        "SuccessFeedbackRoleArn"
                            | "FailureFeedbackRoleArn"
                            | "SuccessFeedbackSampleRate"
                    )
                })
            })
}

/// 결과값이 필요한 호출(구독 ARN, 발행한 MessageId). 나머지는 `execute`와 같고 `Null`을 돌려준다
pub async fn run(cfg: &SdkConfig, call: &SnsCall) -> Result<Value, AppError> {
    let text = |key: &str| {
        call.body
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::other("변경 요청이 올바르지 않아요"))
    };
    match call.api.as_str() {
        "sns:Subscribe" => {
            let mut req = aws_sdk_sns::Client::new(cfg)
                .subscribe()
                .topic_arn(&call.target)
                .protocol(text("Protocol")?)
                .endpoint(text("Endpoint")?)
                .return_subscription_arn(true);
            if let Some(map) = call.body.get("Attributes").and_then(Value::as_object) {
                for (k, v) in map {
                    req = req.attributes(
                        k,
                        v.as_str()
                            .ok_or_else(|| AppError::other("변경 요청이 올바르지 않아요"))?,
                    );
                }
            }
            let out = req.send().await.map_err(|e| from_sdk(e, "sns:Subscribe"))?;
            Ok(serde_json::json!({"subscriptionArn": out.subscription_arn()}))
        }
        "sns:Publish" => {
            let mut req = aws_sdk_sns::Client::new(cfg)
                .publish()
                .topic_arn(&call.target)
                .message(text("Message")?);
            if let Some(v) = call.body.get("Subject").and_then(Value::as_str) {
                req = req.subject(v);
            }
            if let Some(v) = call.body.get("MessageStructure").and_then(Value::as_str) {
                req = req.message_structure(v);
            }
            if let Some(v) = call.body.get("MessageGroupId").and_then(Value::as_str) {
                req = req.message_group_id(v);
            }
            if let Some(v) = call
                .body
                .get("MessageDeduplicationId")
                .and_then(Value::as_str)
            {
                req = req.message_deduplication_id(v);
            }
            if let Some(map) = call
                .body
                .get("MessageAttributes")
                .and_then(Value::as_object)
            {
                for (name, a) in map {
                    let data_type = a
                        .get("DataType")
                        .and_then(Value::as_str)
                        .ok_or_else(|| AppError::other("변경 요청이 올바르지 않아요"))?;
                    let value = a
                        .get("StringValue")
                        .and_then(Value::as_str)
                        .ok_or_else(|| AppError::other("변경 요청이 올바르지 않아요"))?;
                    req = req.message_attributes(
                        name,
                        aws_sdk_sns::types::MessageAttributeValue::builder()
                            .data_type(data_type)
                            .string_value(value)
                            .build()
                            .map_err(|e| AppError::other(e.to_string()))?,
                    );
                }
            }
            let out = req.send().await.map_err(|e| from_sdk(e, "sns:Publish"))?;
            Ok(
                serde_json::json!({"messageId": out.message_id(), "sequenceNumber": out.sequence_number()}),
            )
        }
        _ => execute(cfg, call).await.map(|()| Value::Null),
    }
}

pub async fn receive(
    client: &aws_sdk_sqs::Client,
    url: &str,
    follow: bool,
    max: i32,
) -> Result<Vec<aws_sdk_sqs::types::Message>, AppError> {
    let out = client
        .receive_message()
        .queue_url(url)
        .max_number_of_messages(max)
        .visibility_timeout(30)
        .message_system_attribute_names(aws_sdk_sqs::types::MessageSystemAttributeName::All)
        .message_attribute_names("All")
        .wait_time_seconds(if follow { 20 } else { 0 })
        .send()
        .await
        .map_err(|e| from_sdk(e, "sqs:ReceiveMessage"))?;
    Ok(out.messages().to_vec())
}

pub async fn release(
    client: &aws_sdk_sqs::Client,
    url: &str,
    handles: &[String],
) -> Result<(), AppError> {
    let mut error = None;
    for chunk in handles.chunks(10) {
        let entries = chunk
            .iter()
            .enumerate()
            .map(|(i, handle)| {
                aws_sdk_sqs::types::ChangeMessageVisibilityBatchRequestEntry::builder()
                    .id(i.to_string())
                    .receipt_handle(handle)
                    .visibility_timeout(0)
                    .build()
                    .map_err(|e| AppError::other(e.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        match client
            .change_message_visibility_batch()
            .queue_url(url)
            .set_entries(Some(entries))
            .send()
            .await
        {
            Err(e) => {
                error = Some(from_sdk(e, "sqs:ChangeMessageVisibility"));
            }
            Ok(out) if !out.failed().is_empty() => {
                error = Some(AppError::other(format!(
                    "메시지를 돌려놓지 못했어요: {:?}",
                    out.failed()
                )));
            }
            Ok(_) => {}
        }
    }
    if let Some(error) = error {
        Err(error)
    } else {
        Ok(())
    }
}
