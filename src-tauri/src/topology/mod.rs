//! VPC 구조도: 계약 타입과 순수 함수. AWS 호출은 `fetch`에 있다.

pub mod fetch;

use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpcTopology {
    pub vpc: VpcInfo,
    pub azs: Vec<String>,
    pub subnets: Vec<SubnetInfo>,
    pub route_tables: Vec<RouteTableInfo>,
    pub gateways: Vec<GatewayInfo>,
    pub peerings: Vec<PeeringInfo>,
    pub resources: Vec<NodeResource>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpcInfo {
    pub id: String,
    pub name: String,
    pub cidrs: Vec<String>,
    pub is_default: bool,
    pub state: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Public,
    Private,
    Isolated,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubnetInfo {
    pub id: String,
    pub name: String,
    pub az: String,
    pub cidr: String,
    pub tier: Tier,
    pub route_table_id: Option<String>,
    pub available_ips: Option<i32>,
    pub tags: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTableInfo {
    pub id: String,
    pub name: String,
    pub main: bool,
    pub subnet_ids: Vec<String>,
    pub routes: Vec<RouteInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Local,
    Igw,
    Nat,
    Tgw,
    Vgw,
    Pcx,
    Eigw,
    Vpce,
    Eni,
    Instance,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteInfo {
    pub destination: String,
    pub target: String,
    pub target_kind: TargetKind,
    pub state: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum GatewayKind {
    #[serde(rename = "igw")]
    Igw,
    #[serde(rename = "eigw")]
    Eigw,
    #[serde(rename = "vgw")]
    Vgw,
    #[serde(rename = "tgw")]
    Tgw,
    #[serde(rename = "vpce-gateway")]
    VpceGateway,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayInfo {
    pub id: String,
    pub name: String,
    pub kind: GatewayKind,
    pub label: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeeringInfo {
    pub id: String,
    pub peer_vpc_id: String,
    pub peer_cidr: Option<String>,
    pub peer_owner_id: Option<String>,
    pub peer_region: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    Ec2,
    Nat,
    Rds,
    Elb,
    Lambda,
    Vpce,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Field {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeResource {
    pub id: String,
    pub name: String,
    pub kind: ResourceKind,
    pub subnet_ids: Vec<String>,
    pub state: String,
    pub fields: Vec<Field>,
    pub console_url: Option<String>,
}

impl NodeResource {
    pub fn new(id: &str, name: &str, kind: ResourceKind, subnet_ids: Vec<String>, state: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            kind,
            subnet_ids,
            state: state.to_string(),
            fields: Vec::new(),
            console_url: None,
        }
    }

    pub fn field(mut self, label: &str, value: impl Into<String>) -> Self {
        self.fields.push(Field { label: label.to_string(), value: value.into() });
        self
    }

    pub fn console(mut self, url: impl Into<String>) -> Self {
        self.console_url = Some(url.into());
        self
    }
}

/// 라우트 대상 id의 접두어로 종류를 정한다.
pub fn target_kind(target: &str) -> TargetKind {
    if target == "local" {
        TargetKind::Local
    } else if target.starts_with("igw-") {
        TargetKind::Igw
    } else if target.starts_with("nat-") {
        TargetKind::Nat
    } else if target.starts_with("tgw-") {
        TargetKind::Tgw
    } else if target.starts_with("vgw-") {
        TargetKind::Vgw
    } else if target.starts_with("pcx-") {
        TargetKind::Pcx
    } else if target.starts_with("eigw-") {
        TargetKind::Eigw
    } else if target.starts_with("vpce-") {
        TargetKind::Vpce
    } else if target.starts_with("eni-") {
        TargetKind::Eni
    } else if target.starts_with("i-") {
        TargetKind::Instance
    } else {
        TargetKind::Other
    }
}

fn is_default_route(destination: &str) -> bool {
    destination == "0.0.0.0/0" || destination == "::/0"
}

/// 서브넷의 라우팅 테이블 경로로 public/private/isolated를 정한다. blackhole 경로는 무시한다.
pub fn classify_tier(routes: &[RouteInfo]) -> Tier {
    let mut tier = Tier::Isolated;
    for r in routes.iter().filter(|r| is_default_route(&r.destination) && r.state != "blackhole") {
        if r.target_kind == TargetKind::Igw {
            return Tier::Public;
        }
        tier = Tier::Private;
    }
    tier
}

/// 명시 연결된 라우팅 테이블, 없으면 main 테이블의 id.
pub fn resolve_route_table<'a>(subnet_id: &str, tables: &'a [RouteTableInfo]) -> Option<&'a RouteTableInfo> {
    tables
        .iter()
        .find(|t| t.subnet_ids.iter().any(|s| s == subnet_id))
        .or_else(|| tables.iter().find(|t| t.main))
}

/// RDS 인스턴스를 그릴 서브넷 선택. 인스턴스 AZ와 같은 서브넷 1개(없으면 그룹 첫 서브넷),
/// Multi-AZ면 secondary AZ 서브넷도 추가한다.
pub fn rds_subnet_ids(
    group: &[(String, String)],
    az: Option<&str>,
    secondary_az: Option<&str>,
    multi_az: bool,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let primary = az
        .and_then(|a| group.iter().find(|(_, saz)| saz == a))
        .or_else(|| group.first());
    if let Some((id, _)) = primary {
        out.push(id.clone());
    }
    if multi_az {
        if let Some((id, _)) = secondary_az.and_then(|a| group.iter().find(|(_, saz)| saz == a)) {
            if !out.contains(id) {
                out.push(id.clone());
            }
        }
    }
    out
}

/// 게이트웨이 엔드포인트 서비스 이름 → 표시 라벨.
pub fn endpoint_label(service_name: &str) -> String {
    let last = service_name.rsplit('.').next().unwrap_or(service_name);
    match last {
        "s3" => "S3".to_string(),
        "dynamodb" => "DynamoDB".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(dest: &str, target: &str, state: &str) -> RouteInfo {
        RouteInfo {
            destination: dest.into(),
            target: target.into(),
            target_kind: target_kind(target),
            state: state.into(),
        }
    }

    fn table(id: &str, main: bool, subnets: &[&str]) -> RouteTableInfo {
        RouteTableInfo {
            id: id.into(),
            name: id.into(),
            main,
            subnet_ids: subnets.iter().map(|s| s.to_string()).collect(),
            routes: vec![],
        }
    }

    #[test]
    fn tier_public_with_igw() {
        let r = [route("10.0.0.0/16", "local", "active"), route("0.0.0.0/0", "igw-1", "active")];
        assert_eq!(classify_tier(&r), Tier::Public);
    }

    #[test]
    fn tier_private_with_nat() {
        let r = [route("10.0.0.0/16", "local", "active"), route("0.0.0.0/0", "nat-1", "active")];
        assert_eq!(classify_tier(&r), Tier::Private);
    }

    #[test]
    fn tier_private_with_only_eigw_ipv6() {
        let r = [route("::/0", "eigw-1", "active")];
        assert_eq!(classify_tier(&r), Tier::Private);
    }

    #[test]
    fn tier_isolated_without_default_route() {
        let r = [route("10.0.0.0/16", "local", "active"), route("10.1.0.0/16", "pcx-1", "active")];
        assert_eq!(classify_tier(&r), Tier::Isolated);
    }

    #[test]
    fn tier_blackhole_igw_is_ignored() {
        let r = [route("0.0.0.0/0", "igw-1", "blackhole")];
        assert_eq!(classify_tier(&r), Tier::Isolated);
        let r = [route("0.0.0.0/0", "igw-1", "blackhole"), route("0.0.0.0/0", "nat-1", "active")];
        assert_eq!(classify_tier(&r), Tier::Private);
    }

    #[test]
    fn tier_igw_wins_over_other_default() {
        let r = [route("::/0", "eigw-1", "active"), route("0.0.0.0/0", "igw-1", "active")];
        assert_eq!(classify_tier(&r), Tier::Public);
    }

    #[test]
    fn subnet_uses_explicit_association_else_main() {
        let tables = [table("rtb-main", true, &[]), table("rtb-a", false, &["subnet-a"])];
        assert_eq!(resolve_route_table("subnet-a", &tables).unwrap().id, "rtb-a");
        assert_eq!(resolve_route_table("subnet-b", &tables).unwrap().id, "rtb-main");
        assert!(resolve_route_table("subnet-b", &[table("rtb-a", false, &["subnet-a"])]).is_none());
    }

    #[test]
    fn target_kind_by_prefix() {
        assert_eq!(target_kind("local"), TargetKind::Local);
        assert_eq!(target_kind("igw-1"), TargetKind::Igw);
        assert_eq!(target_kind("nat-1"), TargetKind::Nat);
        assert_eq!(target_kind("tgw-1"), TargetKind::Tgw);
        assert_eq!(target_kind("vgw-1"), TargetKind::Vgw);
        assert_eq!(target_kind("pcx-1"), TargetKind::Pcx);
        assert_eq!(target_kind("eigw-1"), TargetKind::Eigw);
        assert_eq!(target_kind("vpce-1"), TargetKind::Vpce);
        assert_eq!(target_kind("eni-1"), TargetKind::Eni);
        assert_eq!(target_kind("i-0abc"), TargetKind::Instance);
        assert_eq!(target_kind("cgw-1"), TargetKind::Other);
    }

    fn group() -> Vec<(String, String)> {
        vec![
            ("subnet-a".into(), "ap-northeast-2a".into()),
            ("subnet-c".into(), "ap-northeast-2c".into()),
        ]
    }

    #[test]
    fn rds_picks_subnet_in_instance_az() {
        assert_eq!(rds_subnet_ids(&group(), Some("ap-northeast-2c"), None, false), vec!["subnet-c"]);
    }

    #[test]
    fn rds_multi_az_adds_secondary() {
        assert_eq!(
            rds_subnet_ids(&group(), Some("ap-northeast-2a"), Some("ap-northeast-2c"), true),
            vec!["subnet-a", "subnet-c"]
        );
    }

    #[test]
    fn rds_falls_back_to_first_subnet() {
        assert_eq!(rds_subnet_ids(&group(), Some("ap-northeast-2d"), None, false), vec!["subnet-a"]);
        assert_eq!(rds_subnet_ids(&group(), None, None, false), vec!["subnet-a"]);
        assert!(rds_subnet_ids(&[], None, None, false).is_empty());
    }

    #[test]
    fn endpoint_labels() {
        assert_eq!(endpoint_label("com.amazonaws.ap-northeast-2.s3"), "S3");
        assert_eq!(endpoint_label("com.amazonaws.ap-northeast-2.dynamodb"), "DynamoDB");
        assert_eq!(endpoint_label("com.amazonaws.ap-northeast-2.kinesis-streams"), "kinesis-streams");
    }

    #[test]
    fn topology_serializes_to_contract_keys() {
        let t = VpcTopology {
            vpc: VpcInfo { id: "vpc-1".into(), name: "main".into(), cidrs: vec!["10.0.0.0/16".into()], is_default: false, state: "available".into() },
            azs: vec!["ap-northeast-2a".into()],
            subnets: vec![SubnetInfo {
                id: "subnet-1".into(),
                name: "pub".into(),
                az: "ap-northeast-2a".into(),
                cidr: "10.0.0.0/24".into(),
                tier: Tier::Public,
                route_table_id: Some("rtb-1".into()),
                available_ips: Some(250),
                tags: BTreeMap::from([("Name".to_string(), "pub".to_string())]),
            }],
            route_tables: vec![RouteTableInfo {
                id: "rtb-1".into(),
                name: "rtb-1".into(),
                main: true,
                subnet_ids: vec![],
                routes: vec![route("0.0.0.0/0", "igw-1", "active")],
            }],
            gateways: vec![GatewayInfo { id: "vpce-9".into(), name: "vpce-9".into(), kind: GatewayKind::VpceGateway, label: "S3".into(), state: "available".into() }],
            peerings: vec![PeeringInfo { id: "pcx-1".into(), peer_vpc_id: "vpc-2".into(), peer_cidr: None, peer_owner_id: Some("111".into()), peer_region: None, status: "active".into() }],
            resources: vec![NodeResource::new("i-1", "web", ResourceKind::Ec2, vec!["subnet-1".into()], "running")
                .field("Type", "t3.micro")],
            warnings: vec![],
        };
        let expected = serde_json::json!({
            "vpc": { "id": "vpc-1", "name": "main", "cidrs": ["10.0.0.0/16"], "isDefault": false, "state": "available" },
            "azs": ["ap-northeast-2a"],
            "subnets": [{
                "id": "subnet-1", "name": "pub", "az": "ap-northeast-2a", "cidr": "10.0.0.0/24",
                "tier": "public", "routeTableId": "rtb-1", "availableIps": 250, "tags": { "Name": "pub" }
            }],
            "routeTables": [{
                "id": "rtb-1", "name": "rtb-1", "main": true, "subnetIds": [],
                "routes": [{ "destination": "0.0.0.0/0", "target": "igw-1", "targetKind": "igw", "state": "active" }]
            }],
            "gateways": [{ "id": "vpce-9", "name": "vpce-9", "kind": "vpce-gateway", "label": "S3", "state": "available" }],
            "peerings": [{ "id": "pcx-1", "peerVpcId": "vpc-2", "peerCidr": null, "peerOwnerId": "111", "peerRegion": null, "status": "active" }],
            "resources": [{
                "id": "i-1", "name": "web", "kind": "ec2", "subnetIds": ["subnet-1"], "state": "running",
                "fields": [{ "label": "Type", "value": "t3.micro" }], "consoleUrl": null
            }],
            "warnings": []
        });
        assert_eq!(serde_json::to_value(&t).unwrap(), expected);
    }
}
