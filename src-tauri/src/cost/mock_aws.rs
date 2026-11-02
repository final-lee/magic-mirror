//! 테스트용 Cost Explorer 클라이언트. 네트워크 대신 보낸 요청(`x-amz-target`과 JSON 본문)을 기록하고, 정해 둔 응답을 돌려준다.
//! `iam/mock_aws.rs`와 같은 방식이지만 AWS JSON 1.1 프로토콜이다. SDK가 실제로 만든 요청을 보므로
//! "필터·GroupBy·페이지 토큰이 그대로 나갔는지"를 확인할 수 있다.

use std::fmt;
use std::sync::{Arc, Mutex};

use aws_sdk_costexplorer::config::retry::RetryConfig;
use aws_sdk_costexplorer::config::{BehaviorVersion, Credentials, Region};
use aws_smithy_runtime_api::client::http::{HttpClient, HttpConnector, HttpConnectorFuture, HttpConnectorSettings, SharedHttpClient, SharedHttpConnector};
use aws_smithy_runtime_api::client::orchestrator::{HttpRequest, HttpResponse};
use aws_smithy_runtime_api::client::runtime_components::RuntimeComponents;
use aws_smithy_runtime_api::http::StatusCode;
use aws_smithy_types::body::SdkBody;

/// 서버로 간 요청 하나: `x-amz-target` 헤더(예: `AWSInsightsIndexService.GetCostAndUsage`)와 JSON 본문.
#[derive(Clone, Debug, PartialEq)]
pub struct Sent {
    pub target: String,
    pub body: serde_json::Value,
}

/// 요청에 대한 (HTTP 상태, 응답 본문 JSON).
type Responder = dyn Fn(&Sent) -> (u16, String) + Send + Sync;

#[derive(Clone)]
pub struct Recorder {
    sent: Arc<Mutex<Vec<Sent>>>,
    responder: Arc<Responder>,
}

impl fmt::Debug for Recorder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Recorder")
    }
}

/// AWS JSON 오류 응답 본문.
pub fn error_json(code: &str, message: &str) -> String {
    serde_json::json!({ "__type": code, "message": message }).to_string()
}

impl Recorder {
    pub fn new(responder: impl Fn(&Sent) -> (u16, String) + Send + Sync + 'static) -> Recorder {
        Recorder { sent: Arc::default(), responder: Arc::new(responder) }
    }

    /// 지금까지 간 요청을 보낸 순서대로.
    pub fn sent(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().clone()
    }

    pub fn client(&self) -> aws_sdk_costexplorer::Client {
        let config = aws_sdk_costexplorer::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::new("AKIDTEST", "secret", None, None, "test"))
            .http_client(SharedHttpClient::new(self.clone()))
            // 재시도가 켜져 있으면 일부러 실패시킨 요청이 여러 번 기록되고 테스트가 느려진다
            .retry_config(RetryConfig::disabled())
            .build();
        aws_sdk_costexplorer::Client::from_conf(config)
    }
}

impl HttpConnector for Recorder {
    fn call(&self, request: HttpRequest) -> HttpConnectorFuture {
        let target = request.headers().get("x-amz-target").unwrap_or_default().to_string();
        let body = request.body().bytes().and_then(|bytes| serde_json::from_slice(bytes).ok()).unwrap_or(serde_json::Value::Null);
        let sent = Sent { target, body };
        self.sent.lock().unwrap().push(sent.clone());
        let (status, json) = (self.responder)(&sent);
        let mut response = HttpResponse::new(StatusCode::try_from(status).unwrap(), SdkBody::from(json));
        response.headers_mut().insert("content-type", "application/x-amz-json-1.1");
        HttpConnectorFuture::ready(Ok(response))
    }
}

impl HttpClient for Recorder {
    fn http_connector(&self, _settings: &HttpConnectorSettings, _components: &RuntimeComponents) -> SharedHttpConnector {
        SharedHttpConnector::new(self.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_bodies_carry_the_type_and_message() {
        let v: serde_json::Value = serde_json::from_str(&error_json("LimitExceededException", "slow down")).unwrap();
        assert_eq!(v, serde_json::json!({ "__type": "LimitExceededException", "message": "slow down" }));
    }

    #[tokio::test]
    async fn the_client_sends_through_the_recorder_and_gets_the_canned_answer() {
        let recorder = Recorder::new(|_| (200, r#"{"CostAllocationTags":[{"TagKey":"team","Type":"UserDefined","Status":"Active"}]}"#.to_string()));
        let out = recorder.client().list_cost_allocation_tags().send().await.unwrap();
        assert_eq!(out.cost_allocation_tags().len(), 1);
        assert_eq!(out.cost_allocation_tags()[0].tag_key(), "team");
        let sent = recorder.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].target, "AWSInsightsIndexService.ListCostAllocationTags");
        assert!(sent[0].body.is_object());
    }

    #[tokio::test]
    async fn error_answers_come_back_as_sdk_errors_with_the_code() {
        let recorder = Recorder::new(|_| (400, error_json("AccessDeniedException", "not allowed")));
        let err = recorder.client().list_cost_allocation_tags().send().await.unwrap_err();
        let app = crate::error::from_sdk(err, "ce:ListCostAllocationTags");
        assert_eq!(app, crate::error::AppError::AccessDenied { action: "ce:ListCostAllocationTags".into() });
    }
}
