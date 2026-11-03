//! 테스트용 AWS 클라이언트(EKS·EC2). 네트워크 대신 SDK가 만든 요청(Query 프로토콜이면 `Action`과 인자, REST면 메서드와 경로)을 기록하고 정해 둔 응답을 돌려준다.
//! `k8s/network/mock_aws.rs`와 같은 방식이다. 실제 AWS에는 닿지 않는다.
use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use aws_smithy_runtime_api::client::http::{HttpClient, HttpConnector, HttpConnectorFuture, HttpConnectorSettings, SharedHttpClient, SharedHttpConnector};
use aws_smithy_runtime_api::client::orchestrator::{HttpRequest, HttpResponse};
use aws_smithy_runtime_api::client::runtime_components::RuntimeComponents;
use aws_smithy_runtime_api::http::StatusCode;
use aws_smithy_types::body::SdkBody;

use super::read::Aws;

const EC2_NS: &str = "http://ec2.amazonaws.com/doc/2016-11-15/";

/// 서버로 간 요청 하나. Query 프로토콜이면 `action`이 `Action` 값이고 `params`가 나머지 인자(`Version` 제외),
/// REST(EKS)면 `action`이 `REST /clusters/이름`이다.
#[derive(Clone, Debug, PartialEq)]
pub struct Sent {
    pub action: String,
    pub params: BTreeMap<String, String>,
}

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

fn parse_form(body: &str) -> Sent {
    let mut params: BTreeMap<String, String> =
        body.split('&').filter(|pair| !pair.is_empty()).map(|pair| pair.split_once('=').unwrap_or((pair, ""))).map(|(k, v)| (percent_decode(k), percent_decode(v))).collect();
    params.remove("Version");
    Sent { action: params.remove("Action").unwrap_or_default(), params }
}

impl Recorder {
    pub fn new(responder: impl Fn(&Sent) -> (u16, String) + Send + Sync + 'static) -> Recorder {
        Recorder { sent: Arc::default(), responder: Arc::new(responder) }
    }

    /// 지금까지 간 요청을 보낸 순서대로
    pub fn sent(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().clone()
    }

    /// 이 동작의 요청만
    pub fn sent_of(&self, action: &str) -> Vec<Sent> {
        self.sent().into_iter().filter(|s| s.action == action).collect()
    }

    fn http(&self) -> SharedHttpClient {
        SharedHttpClient::new(self.clone())
    }

    pub fn clients(&self) -> Aws {
        // 재시도가 켜져 있으면 일부러 실패시킨 요청이 여러 번 기록되고 테스트가 느려진다
        let creds = aws_sdk_ec2::config::Credentials::new("AKIDTEST", "secret", None, None, "test");
        let ec2 = aws_sdk_ec2::Config::builder()
            .behavior_version(aws_sdk_ec2::config::BehaviorVersion::latest())
            .region(aws_sdk_ec2::config::Region::new("ap-northeast-2"))
            .credentials_provider(creds.clone())
            .http_client(self.http())
            .retry_config(aws_sdk_ec2::config::retry::RetryConfig::disabled())
            .build();
        let eks = aws_sdk_eks::Config::builder()
            .behavior_version(aws_sdk_eks::config::BehaviorVersion::latest())
            .region(aws_sdk_eks::config::Region::new("ap-northeast-2"))
            .credentials_provider(creds)
            .http_client(self.http())
            .retry_config(aws_sdk_eks::config::retry::RetryConfig::disabled())
            .build();
        Aws { eks: aws_sdk_eks::Client::from_conf(eks), ec2: aws_sdk_ec2::Client::from_conf(ec2) }
    }
}

impl HttpConnector for Recorder {
    fn call(&self, request: HttpRequest) -> HttpConnectorFuture {
        let body = request.body().bytes().map(|bytes| String::from_utf8_lossy(bytes).into_owned()).unwrap_or_default();
        let mut sent = parse_form(&body);
        if sent.action.is_empty() {
            let uri = request.uri();
            let path = uri.split_once("://").and_then(|(_, rest)| rest.find('/').map(|i| &rest[i..])).unwrap_or(uri);
            // REST는 경로와 쿼리를 함께 남겨 쪽 넘기기 인자(nextToken)도 볼 수 있게 한다
            let (route, query) = path.split_once('?').unwrap_or((path, ""));
            sent.action = format!("REST {route}");
            sent.params = query.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').unwrap_or((p, ""))).map(|(k, v)| (percent_decode(k), percent_decode(v))).collect();
        }
        self.sent.lock().unwrap().push(sent.clone());
        let (status, text) = (self.responder)(&sent);
        let mut response = HttpResponse::new(StatusCode::try_from(status).unwrap(), SdkBody::from(text));
        if sent.action.starts_with("REST /") {
            response.headers_mut().insert("content-type", "application/json");
        }
        HttpConnectorFuture::ready(Ok(response))
    }
}

impl HttpClient for Recorder {
    fn http_connector(&self, _settings: &HttpConnectorSettings, _components: &RuntimeComponents) -> SharedHttpConnector {
        SharedHttpConnector::new(self.clone())
    }
}

// ── 응답 본문 만들기 ──

pub fn ec2_ok(action: &str, inner: &str) -> String {
    format!(r#"<{action}Response xmlns="{EC2_NS}"><requestId>req-1</requestId>{inner}</{action}Response>"#)
}

pub fn ec2_error(code: &str, message: &str) -> String {
    format!("<Response><Errors><Error><Code>{code}</Code><Message>{message}</Message></Error></Errors><RequestID>req-1</RequestID></Response>")
}

pub fn eks_error(code: &str, message: &str) -> String {
    serde_json::json!({ "message": message, "__type": code }).to_string()
}

/// 인스턴스 하나(IMDS hop limit 포함)
pub fn instance_xml(id: &str, hop: Option<i32>) -> String {
    let options = hop.map(|h| format!("<metadataOptions><state>applied</state><httpTokens>required</httpTokens><httpPutResponseHopLimit>{h}</httpPutResponseHopLimit></metadataOptions>")).unwrap_or_default();
    format!("<item><instanceId>{id}</instanceId><instanceState><code>16</code><name>running</name></instanceState>{options}</item>")
}

pub fn reservations(instances: &str) -> String {
    format!("<reservationSet><item><reservationId>r-1</reservationId><instancesSet>{instances}</instancesSet></item></reservationSet>")
}

/// 시작 템플릿 버전 하나(IMDS hop limit 포함)
pub fn lt_version_xml(id: &str, version: i64, hop: Option<i32>) -> String {
    let options = hop.map(|h| format!("<metadataOptions><httpPutResponseHopLimit>{h}</httpPutResponseHopLimit></metadataOptions>")).unwrap_or_default();
    format!("<item><launchTemplateId>{id}</launchTemplateId><versionNumber>{version}</versionNumber><launchTemplateData>{options}</launchTemplateData></item>")
}

pub fn lt_versions(items: &str) -> String {
    format!("<launchTemplateVersionSet>{items}</launchTemplateVersionSet>")
}
