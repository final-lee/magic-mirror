//! 테스트용 IAM 클라이언트. 네트워크 대신 보낸 요청(`Action`과 인자)을 기록하고, 정해 둔 응답을 돌려준다.
//! SDK가 실제로 만든 요청을 보므로 "미리보기에 보인 호출이 그대로 나갔는지"를 확인할 수 있다.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use aws_sdk_iam::config::retry::RetryConfig;
use aws_sdk_iam::config::{BehaviorVersion, Credentials, Region};
use aws_smithy_runtime_api::client::http::{HttpClient, HttpConnector, HttpConnectorFuture, HttpConnectorSettings, SharedHttpClient, SharedHttpConnector};
use aws_smithy_runtime_api::client::orchestrator::{HttpRequest, HttpResponse};
use aws_smithy_runtime_api::client::runtime_components::RuntimeComponents;
use aws_smithy_runtime_api::http::StatusCode;
use aws_smithy_types::body::SdkBody;

const NAMESPACE: &str = "https://iam.amazonaws.com/doc/2010-05-08/";

/// 서버로 간 요청 하나: `Action`과 나머지 인자(`Version` 제외).
#[derive(Clone, Debug, PartialEq)]
pub struct Sent {
    pub action: String,
    pub params: BTreeMap<String, String>,
}

/// 요청에 대한 (HTTP 상태, 응답 본문 XML).
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

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit() => {
                out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap());
                i += 2;
            }
            other => out.push(other),
        }
        i += 1;
    }
    String::from_utf8(out).unwrap()
}

/// `Action=AttachUserPolicy&UserName=bob&Version=2010-05-08` 같은 AWS Query 요청 본문.
fn parse_form(body: &str) -> Sent {
    let mut params: BTreeMap<String, String> =
        body.split('&').filter(|pair| !pair.is_empty()).map(|pair| pair.split_once('=').unwrap_or((pair, ""))).map(|(k, v)| (percent_decode(k), percent_decode(v))).collect();
    params.remove("Version");
    Sent { action: params.remove("Action").unwrap_or_default(), params }
}

/// 값이 없는 성공 응답(`AttachUserPolicyResponse` …).
pub fn empty_ok(action: &str) -> String {
    format!(r#"<{action}Response xmlns="{NAMESPACE}"><ResponseMetadata><RequestId>req-1</RequestId></ResponseMetadata></{action}Response>"#)
}

/// IAM 오류 응답 본문.
pub fn error_xml(code: &str, message: &str) -> String {
    format!(r#"<ErrorResponse xmlns="{NAMESPACE}"><Error><Type>Sender</Type><Code>{code}</Code><Message>{message}</Message></Error><RequestId>req-1</RequestId></ErrorResponse>"#)
}

/// 결과 값이 있는 성공 응답(`<GetPolicyResult>…</GetPolicyResult>`).
pub fn ok_with(action: &str, result: &str) -> String {
    format!(
        r#"<{action}Response xmlns="{NAMESPACE}"><{action}Result>{result}</{action}Result><ResponseMetadata><RequestId>req-1</RequestId></ResponseMetadata></{action}Response>"#
    )
}

impl Recorder {
    pub fn new(responder: impl Fn(&Sent) -> (u16, String) + Send + Sync + 'static) -> Recorder {
        Recorder { sent: Arc::default(), responder: Arc::new(responder) }
    }

    /// 어떤 요청에도 값이 없는 성공으로 답한다(`CreatePolicyVersion`은 만든 버전을 돌려준다).
    pub fn ok() -> Recorder {
        Recorder::new(|sent| match sent.action.as_str() {
            "CreatePolicyVersion" => (200, ok_with("CreatePolicyVersion", "<PolicyVersion><VersionId>v9</VersionId><IsDefaultVersion>true</IsDefaultVersion></PolicyVersion>")),
            action => (200, empty_ok(action)),
        })
    }

    /// 이 요청에 정해 둔 응답이 무엇인지(기록하지 않는다). 일부 요청만 다르게 답하는 응답기를 만들 때 쓴다.
    pub fn respond(&self, sent: &Sent) -> (u16, String) {
        (self.responder)(sent)
    }

    /// 지금까지 간 요청을 보낸 순서대로.
    pub fn sent(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().clone()
    }

    pub fn client(&self) -> aws_sdk_iam::Client {
        let config = aws_sdk_iam::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::new("AKIDTEST", "secret", None, None, "test"))
            .http_client(SharedHttpClient::new(self.clone()))
            // 재시도가 켜져 있으면 일부러 실패시킨 요청이 여러 번 기록되고 테스트가 느려진다
            .retry_config(RetryConfig::disabled())
            .build();
        aws_sdk_iam::Client::from_conf(config)
    }
}

impl HttpConnector for Recorder {
    fn call(&self, request: HttpRequest) -> HttpConnectorFuture {
        let body = request.body().bytes().map(|bytes| String::from_utf8_lossy(bytes).into_owned()).unwrap_or_default();
        let sent = parse_form(&body);
        self.sent.lock().unwrap().push(sent.clone());
        let (status, xml) = (self.responder)(&sent);
        HttpConnectorFuture::ready(Ok(HttpResponse::new(StatusCode::try_from(status).unwrap(), SdkBody::from(xml))))
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
    fn form_bodies_are_decoded_into_an_action_and_parameters() {
        let sent = parse_form("Action=PutUserPolicy&PolicyDocument=%7B%22a%22%3A+1%7D&UserName=bob&Version=2010-05-08");
        assert_eq!(sent.action, "PutUserPolicy");
        assert_eq!(sent.params.get("PolicyDocument").map(String::as_str), Some("{\"a\": 1}"));
        assert_eq!(sent.params.get("UserName").map(String::as_str), Some("bob"));
        assert!(!sent.params.contains_key("Version") && !sent.params.contains_key("Action"));
    }

    #[tokio::test]
    async fn the_client_sends_through_the_recorder_and_gets_the_canned_answer() {
        let policy = "<Policy><PolicyName>X</PolicyName><Arn>arn:aws:iam::aws:policy/X</Arn><DefaultVersionId>v1</DefaultVersionId></Policy>";
        let recorder = Recorder::new(move |_| (200, ok_with("GetPolicy", policy)));
        let out = recorder.client().get_policy().policy_arn("arn:aws:iam::aws:policy/X").send().await.unwrap();
        assert_eq!(out.policy().and_then(|p| p.policy_name()), Some("X"));
        let sent = recorder.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].action, "GetPolicy");
        assert_eq!(sent[0].params["PolicyArn"], "arn:aws:iam::aws:policy/X");
    }

    #[tokio::test]
    async fn error_answers_come_back_as_sdk_errors_with_the_code() {
        let recorder = Recorder::new(|_| (403, error_xml("AccessDenied", "not allowed")));
        let err = recorder.client().get_policy().policy_arn("arn:aws:iam::aws:policy/X").send().await.unwrap_err();
        let app = crate::error::from_sdk(err, "iam:GetPolicy");
        assert_eq!(app, crate::error::AppError::AccessDenied { action: "iam:GetPolicy".into() });
    }
}
