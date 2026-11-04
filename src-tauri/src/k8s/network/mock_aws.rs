//! 테스트용 AWS 클라이언트(ELBv2·EC2·EKS). 네트워크 대신 SDK가 만든 요청(`Action`과 인자, REST면 메서드와 경로)을 기록하고 정해 둔 응답을 돌려준다.
//! `iam/mock_aws.rs`와 같은 방식이다. 실제 AWS에는 닿지 않는다.
use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use aws_smithy_runtime_api::client::http::{HttpClient, HttpConnector, HttpConnectorFuture, HttpConnectorSettings, SharedHttpClient, SharedHttpConnector};
use aws_smithy_runtime_api::client::orchestrator::{HttpRequest, HttpResponse};
use aws_smithy_runtime_api::client::runtime_components::RuntimeComponents;
use aws_smithy_runtime_api::http::StatusCode;
use aws_smithy_types::body::SdkBody;

use super::aws::Clients;

const ELB_NS: &str = "http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/";
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

    pub fn clients(&self) -> Clients {
        // 재시도가 켜져 있으면 일부러 실패시킨 요청이 여러 번 기록되고 테스트가 느려진다
        let creds = aws_sdk_ec2::config::Credentials::new("AKIDTEST", "secret", None, None, "test");
        let region = aws_sdk_ec2::config::Region::new("ap-northeast-2");
        let ec2 = aws_sdk_ec2::Config::builder()
            .behavior_version(aws_sdk_ec2::config::BehaviorVersion::latest())
            .region(region.clone())
            .credentials_provider(creds.clone())
            .http_client(self.http())
            .retry_config(aws_sdk_ec2::config::retry::RetryConfig::disabled())
            .build();
        let elb = aws_sdk_elasticloadbalancingv2::Config::builder()
            .behavior_version(aws_sdk_elasticloadbalancingv2::config::BehaviorVersion::latest())
            .region(aws_sdk_elasticloadbalancingv2::config::Region::new("ap-northeast-2"))
            .credentials_provider(creds.clone())
            .http_client(self.http())
            .retry_config(aws_sdk_elasticloadbalancingv2::config::retry::RetryConfig::disabled())
            .build();
        let eks = aws_sdk_eks::Config::builder()
            .behavior_version(aws_sdk_eks::config::BehaviorVersion::latest())
            .region(aws_sdk_eks::config::Region::new("ap-northeast-2"))
            .credentials_provider(creds)
            .http_client(self.http())
            .retry_config(aws_sdk_eks::config::retry::RetryConfig::disabled())
            .build();
        Clients {
            eks: aws_sdk_eks::Client::from_conf(eks),
            ec2: aws_sdk_ec2::Client::from_conf(ec2),
            elb: aws_sdk_elasticloadbalancingv2::Client::from_conf(elb),
        }
    }
}

impl HttpConnector for Recorder {
    fn call(&self, request: HttpRequest) -> HttpConnectorFuture {
        let body = request.body().bytes().map(|bytes| String::from_utf8_lossy(bytes).into_owned()).unwrap_or_default();
        let mut sent = parse_form(&body);
        if sent.action.is_empty() {
            let path = request.uri().split_once("://").and_then(|(_, rest)| rest.find('/').map(|i| &rest[i..])).unwrap_or(request.uri());
            sent.action = format!("REST {}", path.split('?').next().unwrap_or(path));
        }
        self.sent.lock().unwrap().push(sent.clone());
        let (status, text) = (self.responder)(&sent);
        let mut response = HttpResponse::new(StatusCode::try_from(status).unwrap(), SdkBody::from(text));
        if text_is_json(&sent) {
            response.headers_mut().insert("content-type", "application/json");
        }
        HttpConnectorFuture::ready(Ok(response))
    }
}

fn text_is_json(sent: &Sent) -> bool {
    sent.action.starts_with("REST /")
}

impl HttpClient for Recorder {
    fn http_connector(&self, _settings: &HttpConnectorSettings, _components: &RuntimeComponents) -> SharedHttpConnector {
        SharedHttpConnector::new(self.clone())
    }
}

// ── 응답 본문 만들기 ──

pub fn elb_ok(action: &str, result: &str) -> String {
    format!(r#"<{action}Response xmlns="{ELB_NS}"><{action}Result>{result}</{action}Result><ResponseMetadata><RequestId>req-1</RequestId></ResponseMetadata></{action}Response>"#)
}

pub fn elb_error(code: &str, message: &str) -> String {
    format!(r#"<ErrorResponse xmlns="{ELB_NS}"><Error><Type>Sender</Type><Code>{code}</Code><Message>{message}</Message></Error><RequestId>req-1</RequestId></ErrorResponse>"#)
}

pub fn ec2_ok(action: &str, inner: &str) -> String {
    format!(r#"<{action}Response xmlns="{EC2_NS}"><requestId>req-1</requestId>{inner}</{action}Response>"#)
}

pub fn ec2_error(code: &str, message: &str) -> String {
    format!("<Response><Errors><Error><Code>{code}</Code><Message>{message}</Message></Error></Errors><RequestID>req-1</RequestID></Response>")
}

pub fn eks_cluster(vpc_id: &str) -> String {
    serde_json::json!({ "cluster": { "name": "prod", "resourcesVpcConfig": { "vpcId": vpc_id } } }).to_string()
}

pub fn eks_error(code: &str, message: &str) -> String {
    serde_json::json!({ "message": message, "__type": code }).to_string()
}

pub fn lb_xml(arn: &str, name: &str, dns: &str, kind: &str, vpc: &str, zones: &[(&str, &str)]) -> String {
    let zones: String = zones.iter().map(|(z, s)| format!("<member><ZoneName>{z}</ZoneName><SubnetId>{s}</SubnetId></member>")).collect();
    format!(
        "<member><LoadBalancerArn>{arn}</LoadBalancerArn><LoadBalancerName>{name}</LoadBalancerName><DNSName>{dns}</DNSName><Type>{kind}</Type>\
         <Scheme>internet-facing</Scheme><VpcId>{vpc}</VpcId><State><Code>active</Code></State><AvailabilityZones>{zones}</AvailabilityZones>\
         <SecurityGroups><member>sg-1</member></SecurityGroups></member>"
    )
}

pub fn tags_xml(arn: &str, tags: &[(&str, &str)]) -> String {
    let tags: String = tags.iter().map(|(k, v)| format!("<member><Key>{k}</Key><Value>{v}</Value></member>")).collect();
    format!("<member><ResourceArn>{arn}</ResourceArn><Tags>{tags}</Tags></member>")
}

pub fn forward_xml(tg_arn: &str) -> String {
    format!("<member><Type>forward</Type><TargetGroupArn>{tg_arn}</TargetGroupArn></member>")
}

pub fn listener_xml(arn: &str, protocol: &str, port: i32, actions: &str) -> String {
    format!("<member><ListenerArn>{arn}</ListenerArn><Protocol>{protocol}</Protocol><Port>{port}</Port><DefaultActions>{actions}</DefaultActions></member>")
}

pub fn rule_xml(priority: &str, default: bool, conditions: &str, actions: &str) -> String {
    format!("<member><RuleArn>arn:rule/{priority}</RuleArn><Priority>{priority}</Priority><IsDefault>{default}</IsDefault><Conditions>{conditions}</Conditions><Actions>{actions}</Actions></member>")
}

pub fn tg_xml(arn: &str, name: &str, protocol: &str, port: i32, target_type: &str, path: &str) -> String {
    format!(
        "<member><TargetGroupArn>{arn}</TargetGroupArn><TargetGroupName>{name}</TargetGroupName><Protocol>{protocol}</Protocol><Port>{port}</Port>\
         <TargetType>{target_type}</TargetType><HealthCheckEnabled>true</HealthCheckEnabled><HealthCheckProtocol>{protocol}</HealthCheckProtocol>\
         <HealthCheckPort>traffic-port</HealthCheckPort><HealthCheckPath>{path}</HealthCheckPath></member>"
    )
}

pub fn health_xml(id: &str, port: i32, state: &str, reason: Option<&str>, description: Option<&str>) -> String {
    let reason = reason.map(|r| format!("<Reason>{r}</Reason>")).unwrap_or_default();
    let description = description.map(|d| format!("<Description>{d}</Description>")).unwrap_or_default();
    format!("<member><Target><Id>{id}</Id><Port>{port}</Port></Target><TargetHealth><State>{state}</State>{reason}{description}</TargetHealth></member>")
}

pub fn instance_xml(id: &str, state: &str, subnet: &str, vpc: &str, zone: &str) -> String {
    format!(
        "<item><instanceId>{id}</instanceId><instanceState><code>16</code><name>{state}</name></instanceState><subnetId>{subnet}</subnetId>\
         <vpcId>{vpc}</vpcId><placement><availabilityZone>{zone}</availabilityZone></placement></item>"
    )
}

pub fn reservations(instances: &str) -> String {
    format!("<reservationSet><item><reservationId>r-1</reservationId><instancesSet>{instances}</instancesSet></item></reservationSet>")
}

pub fn subnet_xml(id: &str, vpc: &str, zone: &str, cidr: &str, available: i32, name: Option<&str>) -> String {
    let tags = name.map(|n| format!("<tagSet><item><key>Name</key><value>{n}</value></item></tagSet>")).unwrap_or_default();
    format!(
        "<item><subnetId>{id}</subnetId><vpcId>{vpc}</vpcId><availabilityZone>{zone}</availabilityZone><cidrBlock>{cidr}</cidrBlock>\
         <availableIpAddressCount>{available}</availableIpAddressCount>{tags}</item>"
    )
}
