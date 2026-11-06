//! 배달 경로를 고치는 데 필요한 정책 문장.
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SnsFix {
    QueuePolicy {
        queue_arn: String,
        queue_url: String,
        statement: Value,
    },
    LambdaPermission {
        function_arn: String,
        statement_id: String,
        source_arn: String,
    },
    KmsStatement {
        key_arn: String,
        statement: Value,
    },
    AddDlq {
        subscription_arn: String,
    },
}

fn sid(topic_arn: &str) -> String {
    format!(
        "magic-mirror-sns-{}",
        topic_arn.rsplit(':').next().unwrap_or(topic_arn)
    )
}

pub fn queue_policy(topic_arn: &str, queue_arn: &str, queue_url: &str) -> SnsFix {
    SnsFix::QueuePolicy {
        queue_arn: queue_arn.into(),
        queue_url: queue_url.into(),
        statement: json!({
            "Sid": sid(topic_arn), "Effect": "Allow", "Principal": {"Service": "sns.amazonaws.com"},
            "Action": "sqs:SendMessage", "Resource": queue_arn,
            "Condition": {"ArnEquals": {"aws:SourceArn": topic_arn}}
        }),
    }
}

pub fn lambda_permission(topic_arn: &str, function_arn: &str) -> SnsFix {
    SnsFix::LambdaPermission {
        function_arn: function_arn.into(),
        statement_id: sid(topic_arn),
        source_arn: topic_arn.into(),
    }
}

pub fn kms_statement(topic_arn: &str, key_arn: &str, principal: &str) -> SnsFix {
    SnsFix::KmsStatement {
        key_arn: key_arn.into(),
        statement: json!({
            "Sid": sid(topic_arn), "Effect": "Allow", "Principal": {"Service": principal},
            "Action": ["kms:GenerateDataKey*", "kms:Decrypt"], "Resource": "*"
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn payloads_include_exact_source_and_target() {
        let topic = "arn:aws:sns:ap-northeast-2:123:orders.fifo";
        let fix = queue_policy(topic, "arn:aws:sqs:ap-northeast-2:123:q", "https://queue");
        let value = serde_json::to_value(fix).unwrap();
        assert_eq!(value["statement"]["Sid"], "magic-mirror-sns-orders.fifo");
        assert_eq!(
            value["statement"]["Condition"]["ArnEquals"]["aws:SourceArn"],
            topic
        );
        let value = serde_json::to_value(lambda_permission(topic, "function")).unwrap();
        assert_eq!(value["statementId"], "magic-mirror-sns-orders.fifo");
        assert_eq!(value["sourceArn"], topic);
    }
}
