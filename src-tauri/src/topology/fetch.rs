//! VPC 구조도에 필요한 AWS 조회(읽기 전용)와 조립.

use std::collections::{BTreeMap, BTreeSet};

use aws_config::SdkConfig;
use aws_sdk_ec2::types::{Filter, Route, VpcEndpointType};

use super::{
    classify_tier, endpoint_label, rds_subnet_ids, resolve_route_table, target_kind, GatewayInfo, GatewayKind,
    NodeResource, PeeringInfo, ResourceKind, RouteInfo, RouteTableInfo, SubnetInfo, VpcInfo, VpcTopology,
};
use crate::adapters::ec2::tag_pairs;
use crate::adapters::util::{name_tag, s, url_encode};
use crate::error::{from_sdk, AppError};
use crate::model::MAX_ITEMS;

fn filter(name: &str, value: &str) -> Filter {
    Filter::builder().name(name).values(value).build()
}

fn full(service: &str, region: &str, path: &str) -> String {
    format!("https://{region}.console.aws.amazon.com/{service}/home?region={region}#{path}")
}

fn tags_map<'a>(pairs: impl Iterator<Item = (Option<&'a str>, Option<&'a str>)>) -> BTreeMap<String, String> {
    pairs
        .filter_map(|(k, v)| k.map(|k| (k.to_string(), v.unwrap_or_default().to_string())))
        .collect()
}

fn warn<T>(label: &str, r: Result<Vec<T>, AppError>, warnings: &mut Vec<String>) -> Vec<T> {
    match r {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("{label}을(를) 불러오지 못했어요: {e}"));
            Vec::new()
        }
    }
}

pub async fn fetch(cfg: &SdkConfig, region: &str, vpc_id: &str) -> Result<VpcTopology, AppError> {
    let ec2 = aws_sdk_ec2::Client::new(cfg);
    let rds = aws_sdk_rds::Client::new(cfg);
    let elb = aws_sdk_elasticloadbalancingv2::Client::new(cfg);
    let lambda = aws_sdk_lambda::Client::new(cfg);

    let (vpc, subnets_raw, tables) = {
        let (a, b, c) = tokio::join!(fetch_vpc(&ec2, vpc_id), fetch_subnets(&ec2, vpc_id), fetch_route_tables(&ec2, vpc_id));
        (a?, b?, c?)
    };

    let (igw, eigw, vgw, tgw, endpoints, peer_req, peer_acc, nat, instances, rds_r, elb_r, lambda_r) = tokio::join!(
        fetch_igw(&ec2, vpc_id),
        fetch_eigw(&ec2, vpc_id),
        fetch_vgw(&ec2, vpc_id),
        fetch_tgw(&ec2, vpc_id),
        fetch_endpoints(&ec2, vpc_id, region),
        fetch_peerings(&ec2, "requester-vpc-info.vpc-id", vpc_id),
        fetch_peerings(&ec2, "accepter-vpc-info.vpc-id", vpc_id),
        fetch_nat(&ec2, vpc_id, region),
        fetch_instances(&ec2, vpc_id, region),
        fetch_rds(&rds, vpc_id, region),
        fetch_elb(&elb, vpc_id, region),
        fetch_lambda(&lambda, vpc_id, region),
    );

    let mut warnings = Vec::new();
    let mut gateways: Vec<GatewayInfo> = Vec::new();
    gateways.extend(warn("인터넷 게이트웨이", igw, &mut warnings));
    gateways.extend(warn("Egress-only 인터넷 게이트웨이", eigw, &mut warnings));
    gateways.extend(warn("VPN 게이트웨이", vgw, &mut warnings));
    gateways.extend(warn("Transit Gateway 연결", tgw, &mut warnings));

    let mut resources: Vec<NodeResource> = Vec::new();
    let (ep_gw, ep_res) = match endpoints {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("VPC 엔드포인트을(를) 불러오지 못했어요: {e}"));
            (Vec::new(), Vec::new())
        }
    };
    gateways.extend(ep_gw);
    resources.extend(ep_res);

    let mut peerings = warn("피어링 연결", peer_req, &mut warnings);
    peerings.extend(warn("피어링 연결", peer_acc, &mut warnings));
    let mut seen = BTreeSet::new();
    peerings.retain(|p| seen.insert(p.id.clone()));
    peerings.sort_by(|a, b| a.id.cmp(&b.id));

    resources.extend(warn("NAT 게이트웨이", nat, &mut warnings));
    resources.extend(warn("EC2 인스턴스", instances, &mut warnings));
    resources.extend(warn("RDS 인스턴스", rds_r, &mut warnings));
    resources.extend(warn("로드 밸런서", elb_r, &mut warnings));
    resources.extend(warn("Lambda 함수", lambda_r, &mut warnings));
    warnings.dedup();

    let mut subnets: Vec<SubnetInfo> = subnets_raw
        .iter()
        .map(|sn| {
            let rt = resolve_route_table(&sn.id, &tables);
            SubnetInfo {
                tier: classify_tier(rt.map(|t| t.routes.as_slice()).unwrap_or(&[])),
                route_table_id: rt.map(|t| t.id.clone()),
                ..sn.clone()
            }
        })
        .collect();
    subnets.sort_by(|a, b| (&a.az, &a.cidr).cmp(&(&b.az, &b.cidr)));
    let azs: Vec<String> = subnets.iter().map(|s| s.az.clone()).collect::<BTreeSet<_>>().into_iter().collect();

    resources.sort_by(|a, b| (a.kind, &a.name).cmp(&(b.kind, &b.name)));
    gateways.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(VpcTopology { vpc, azs, subnets, route_tables: tables, gateways, peerings, resources, warnings })
}

async fn fetch_vpc(ec2: &aws_sdk_ec2::Client, vpc_id: &str) -> Result<VpcInfo, AppError> {
    let out = ec2
        .describe_vpcs()
        .vpc_ids(vpc_id)
        .send()
        .await
        .map_err(|e| from_sdk(e, "ec2:DescribeVpcs"))?;
    let v = out
        .vpcs()
        .first()
        .ok_or_else(|| AppError::other(format!("VPC를 찾을 수 없어요: {vpc_id}")))?;
    let mut cidrs: Vec<String> = v
        .cidr_block_association_set()
        .iter()
        .filter_map(|a| a.cidr_block().map(str::to_owned))
        .collect();
    if cidrs.is_empty() {
        cidrs.extend(v.cidr_block().map(str::to_owned));
    }
    let id = s(v.vpc_id());
    Ok(VpcInfo {
        name: name_tag(tag_pairs(v.tags())).unwrap_or_else(|| id.clone()),
        id,
        cidrs,
        is_default: v.is_default().unwrap_or(false),
        state: s(v.state().map(|st| st.as_str())),
    })
}

async fn fetch_subnets(ec2: &aws_sdk_ec2::Client, vpc_id: &str) -> Result<Vec<SubnetInfo>, AppError> {
    let mut out = Vec::new();
    let mut pages = ec2.describe_subnets().filters(filter("vpc-id", vpc_id)).into_paginator().send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "ec2:DescribeSubnets"))?;
        for sn in page.subnets() {
            if out.len() >= MAX_ITEMS {
                break 'pages;
            }
            let id = s(sn.subnet_id());
            out.push(SubnetInfo {
                name: name_tag(tag_pairs(sn.tags())).unwrap_or_else(|| id.clone()),
                id,
                az: s(sn.availability_zone()),
                cidr: s(sn.cidr_block()),
                tier: super::Tier::Isolated,
                route_table_id: None,
                available_ips: sn.available_ip_address_count(),
                tags: tags_map(tag_pairs(sn.tags())),
            });
        }
    }
    Ok(out)
}

fn route_info(r: &Route) -> RouteInfo {
    let destination = r
        .destination_cidr_block()
        .or(r.destination_ipv6_cidr_block())
        .or(r.destination_prefix_list_id())
        .unwrap_or_default()
        .to_string();
    let target = r
        .gateway_id()
        .or(r.nat_gateway_id())
        .or(r.transit_gateway_id())
        .or(r.vpc_peering_connection_id())
        .or(r.egress_only_internet_gateway_id())
        .or(r.network_interface_id())
        .or(r.instance_id())
        .unwrap_or_default()
        .to_string();
    RouteInfo {
        destination,
        target_kind: target_kind(&target),
        target,
        state: s(r.state().map(|st| st.as_str())),
    }
}

async fn fetch_route_tables(ec2: &aws_sdk_ec2::Client, vpc_id: &str) -> Result<Vec<RouteTableInfo>, AppError> {
    let mut out = Vec::new();
    let mut pages = ec2.describe_route_tables().filters(filter("vpc-id", vpc_id)).into_paginator().send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "ec2:DescribeRouteTables"))?;
        for t in page.route_tables() {
            if out.len() >= MAX_ITEMS {
                break 'pages;
            }
            let id = s(t.route_table_id());
            out.push(RouteTableInfo {
                name: name_tag(tag_pairs(t.tags())).unwrap_or_else(|| id.clone()),
                id,
                main: t.associations().iter().any(|a| a.main().unwrap_or(false)),
                subnet_ids: t.associations().iter().filter_map(|a| a.subnet_id().map(str::to_owned)).collect(),
                routes: t.routes().iter().map(route_info).collect(),
            });
        }
    }
    Ok(out)
}

async fn fetch_igw(ec2: &aws_sdk_ec2::Client, vpc_id: &str) -> Result<Vec<GatewayInfo>, AppError> {
    let mut out = Vec::new();
    let mut pages = ec2
        .describe_internet_gateways()
        .filters(filter("attachment.vpc-id", vpc_id))
        .into_paginator()
        .send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "ec2:DescribeInternetGateways"))?;
        for g in page.internet_gateways() {
            if out.len() >= MAX_ITEMS {
                break 'pages;
            }
            let id = s(g.internet_gateway_id());
            out.push(GatewayInfo {
                name: name_tag(tag_pairs(g.tags())).unwrap_or_else(|| id.clone()),
                label: id.clone(),
                state: s(g.attachments().iter().find(|a| a.vpc_id() == Some(vpc_id)).and_then(|a| a.state()).map(|st| st.as_str())),
                id,
                kind: GatewayKind::Igw,
            });
        }
    }
    Ok(out)
}

async fn fetch_eigw(ec2: &aws_sdk_ec2::Client, vpc_id: &str) -> Result<Vec<GatewayInfo>, AppError> {
    let mut out = Vec::new();
    let mut pages = ec2.describe_egress_only_internet_gateways().into_paginator().send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "ec2:DescribeEgressOnlyInternetGateways"))?;
        for g in page.egress_only_internet_gateways() {
            let Some(att) = g.attachments().iter().find(|a| a.vpc_id() == Some(vpc_id)) else {
                continue;
            };
            if out.len() >= MAX_ITEMS {
                break 'pages;
            }
            let id = s(g.egress_only_internet_gateway_id());
            out.push(GatewayInfo {
                name: name_tag(tag_pairs(g.tags())).unwrap_or_else(|| id.clone()),
                label: id.clone(),
                state: s(att.state().map(|st| st.as_str())),
                id,
                kind: GatewayKind::Eigw,
            });
        }
    }
    Ok(out)
}

async fn fetch_vgw(ec2: &aws_sdk_ec2::Client, vpc_id: &str) -> Result<Vec<GatewayInfo>, AppError> {
    // DescribeVpnGateways는 페이지네이션이 없다.
    let res = ec2
        .describe_vpn_gateways()
        .filters(filter("attachment.vpc-id", vpc_id))
        .send()
        .await
        .map_err(|e| from_sdk(e, "ec2:DescribeVpnGateways"))?;
    Ok(res
        .vpn_gateways()
        .iter()
        .take(MAX_ITEMS)
        .map(|g| {
            let id = s(g.vpn_gateway_id());
            GatewayInfo {
                name: name_tag(tag_pairs(g.tags())).unwrap_or_else(|| id.clone()),
                label: id.clone(),
                state: s(g.state().map(|st| st.as_str())),
                id,
                kind: GatewayKind::Vgw,
            }
        })
        .collect())
}

async fn fetch_tgw(ec2: &aws_sdk_ec2::Client, vpc_id: &str) -> Result<Vec<GatewayInfo>, AppError> {
    let mut out = Vec::new();
    let mut pages = ec2
        .describe_transit_gateway_attachments()
        .filters(filter("resource-id", vpc_id))
        .filters(filter("resource-type", "vpc"))
        .into_paginator()
        .send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "ec2:DescribeTransitGatewayAttachments"))?;
        for a in page.transit_gateway_attachments() {
            if out.len() >= MAX_ITEMS {
                break 'pages;
            }
            let id = s(a.transit_gateway_attachment_id());
            out.push(GatewayInfo {
                name: name_tag(tag_pairs(a.tags())).unwrap_or_else(|| id.clone()),
                label: s(a.transit_gateway_id()),
                state: s(a.state().map(|st| st.as_str())),
                id,
                kind: GatewayKind::Tgw,
            });
        }
    }
    Ok(out)
}

async fn fetch_endpoints(
    ec2: &aws_sdk_ec2::Client,
    vpc_id: &str,
    region: &str,
) -> Result<(Vec<GatewayInfo>, Vec<NodeResource>), AppError> {
    let mut gws = Vec::new();
    let mut res = Vec::new();
    let mut pages = ec2.describe_vpc_endpoints().filters(filter("vpc-id", vpc_id)).into_paginator().send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "ec2:DescribeVpcEndpoints"))?;
        for e in page.vpc_endpoints() {
            if gws.len() + res.len() >= MAX_ITEMS {
                break 'pages;
            }
            let id = s(e.vpc_endpoint_id());
            let name = name_tag(tag_pairs(e.tags())).unwrap_or_else(|| id.clone());
            let service = s(e.service_name());
            let state = s(e.state().map(|st| st.as_str()));
            if e.vpc_endpoint_type() == Some(&VpcEndpointType::Gateway) {
                gws.push(GatewayInfo { id, name, kind: GatewayKind::VpceGateway, label: endpoint_label(&service), state });
            } else {
                let url = full("vpcconsole", region, &format!("EndpointDetails:vpcEndpointId={id}"));
                res.push(
                    NodeResource::new(&id, &name, ResourceKind::Vpce, e.subnet_ids().to_vec(), &state)
                        .field("Type", s(e.vpc_endpoint_type().map(|t| t.as_str())))
                        .field("Service", service)
                        .console(url),
                );
            }
        }
    }
    Ok((gws, res))
}

async fn fetch_peerings(ec2: &aws_sdk_ec2::Client, filter_name: &str, vpc_id: &str) -> Result<Vec<PeeringInfo>, AppError> {
    let mut out = Vec::new();
    let mut pages = ec2
        .describe_vpc_peering_connections()
        .filters(filter(filter_name, vpc_id))
        .into_paginator()
        .send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "ec2:DescribeVpcPeeringConnections"))?;
        for p in page.vpc_peering_connections() {
            if out.len() >= MAX_ITEMS {
                break 'pages;
            }
            let req = p.requester_vpc_info();
            let acc = p.accepter_vpc_info();
            let peer = if req.and_then(|r| r.vpc_id()) == Some(vpc_id) { acc } else { req };
            out.push(PeeringInfo {
                id: s(p.vpc_peering_connection_id()),
                peer_vpc_id: s(peer.and_then(|i| i.vpc_id())),
                peer_cidr: peer.and_then(|i| i.cidr_block()).map(str::to_owned),
                peer_owner_id: peer.and_then(|i| i.owner_id()).map(str::to_owned),
                peer_region: peer.and_then(|i| i.region()).map(str::to_owned),
                status: s(p.status().and_then(|st| st.code()).map(|c| c.as_str())),
            });
        }
    }
    Ok(out)
}

async fn fetch_nat(ec2: &aws_sdk_ec2::Client, vpc_id: &str, region: &str) -> Result<Vec<NodeResource>, AppError> {
    let mut out = Vec::new();
    let mut pages = ec2.describe_nat_gateways().filter(filter("vpc-id", vpc_id)).into_paginator().send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "ec2:DescribeNatGateways"))?;
        for n in page.nat_gateways() {
            let state = s(n.state().map(|st| st.as_str()));
            if state == "deleted" || state == "deleting" {
                continue;
            }
            if out.len() >= MAX_ITEMS {
                break 'pages;
            }
            let id = s(n.nat_gateway_id());
            let name = name_tag(tag_pairs(n.tags())).unwrap_or_else(|| id.clone());
            let addr = n.nat_gateway_addresses().first();
            out.push(
                NodeResource::new(&id, &name, ResourceKind::Nat, n.subnet_id().map(str::to_owned).into_iter().collect(), &state)
                    .field("Public IP", s(addr.and_then(|a| a.public_ip())))
                    .field("Private IP", s(addr.and_then(|a| a.private_ip())))
                    .field("Connectivity", s(n.connectivity_type().map(|c| c.as_str())))
                    .console(full("vpcconsole", region, &format!("NatGatewayDetails:natGatewayId={id}"))),
            );
        }
    }
    Ok(out)
}

async fn fetch_instances(ec2: &aws_sdk_ec2::Client, vpc_id: &str, region: &str) -> Result<Vec<NodeResource>, AppError> {
    let mut out = Vec::new();
    let mut pages = ec2.describe_instances().filters(filter("vpc-id", vpc_id)).into_paginator().send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "ec2:DescribeInstances"))?;
        for rsv in page.reservations() {
            for i in rsv.instances() {
                let state = s(i.state().and_then(|st| st.name()).map(|n| n.as_str()));
                if state == "terminated" {
                    continue;
                }
                if out.len() >= MAX_ITEMS {
                    break 'pages;
                }
                let id = s(i.instance_id());
                let name = name_tag(tag_pairs(i.tags())).unwrap_or_else(|| id.clone());
                out.push(
                    NodeResource::new(&id, &name, ResourceKind::Ec2, i.subnet_id().map(str::to_owned).into_iter().collect(), &state)
                        .field("Instance ID", &id)
                        .field("Type", s(i.instance_type().map(|t| t.as_str())))
                        .field("State", &state)
                        .field("Private IP", s(i.private_ip_address()))
                        .field("Public IP", s(i.public_ip_address()))
                        .console(full("ec2", region, &format!("InstanceDetails:instanceId={id}"))),
                );
            }
        }
    }
    Ok(out)
}

async fn fetch_rds(
    rds: &aws_sdk_rds::Client,
    vpc_id: &str,
    region: &str,
) -> Result<Vec<NodeResource>, AppError> {
    let mut out = Vec::new();
    let mut pages = rds.describe_db_instances().into_paginator().send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "rds:DescribeDBInstances"))?;
        for d in page.db_instances() {
            let Some(group) = d.db_subnet_group().filter(|g| g.vpc_id() == Some(vpc_id)) else {
                continue;
            };
            if out.len() >= MAX_ITEMS {
                break 'pages;
            }
            let members: Vec<(String, String)> = group
                .subnets()
                .iter()
                .map(|sn| (s(sn.subnet_identifier()), s(sn.subnet_availability_zone().and_then(|az| az.name()))))
                .collect();
            let multi_az = d.multi_az().unwrap_or(false);
            let ids = rds_subnet_ids(&members, d.availability_zone(), d.secondary_availability_zone(), multi_az);
            let id = s(d.db_instance_identifier());
            out.push(
                NodeResource::new(&id, &id, ResourceKind::Rds, ids, &s(d.db_instance_status()))
                    .field("Engine", s(d.engine()))
                    .field("Class", s(d.db_instance_class()))
                    .field("Endpoint", s(d.endpoint().and_then(|e| e.address())))
                    .field("Multi-AZ", if multi_az { "Yes" } else { "No" })
                    .console(full("rds", region, &format!("database:id={id};is-cluster=false"))),
            );
        }
    }
    Ok(out)
}

async fn fetch_elb(
    elb: &aws_sdk_elasticloadbalancingv2::Client,
    vpc_id: &str,
    region: &str,
) -> Result<Vec<NodeResource>, AppError> {
    let mut out = Vec::new();
    let mut pages = elb.describe_load_balancers().into_paginator().send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "elasticloadbalancing:DescribeLoadBalancers"))?;
        for lb in page.load_balancers() {
            if lb.vpc_id() != Some(vpc_id) {
                continue;
            }
            if out.len() >= MAX_ITEMS {
                break 'pages;
            }
            let name = s(lb.load_balancer_name());
            let arn = s(lb.load_balancer_arn());
            let ids = lb.availability_zones().iter().filter_map(|az| az.subnet_id().map(str::to_owned)).collect();
            out.push(
                NodeResource::new(&arn, &name, ResourceKind::Elb, ids, &s(lb.state().and_then(|st| st.code()).map(|c| c.as_str())))
                    .field("Type", s(lb.r#type().map(|t| t.as_str())))
                    .field("Scheme", s(lb.scheme().map(|t| t.as_str())))
                    .field("DNS", s(lb.dns_name()))
                    .console(full("ec2", region, &format!("LoadBalancer:loadBalancerArn={}", url_encode(&arn)))),
            );
        }
    }
    Ok(out)
}

async fn fetch_lambda(lambda: &aws_sdk_lambda::Client, vpc_id: &str, region: &str) -> Result<Vec<NodeResource>, AppError> {
    let mut out = Vec::new();
    let mut pages = lambda.list_functions().into_paginator().send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "lambda:ListFunctions"))?;
        for f in page.functions() {
            let Some(cfg) = f.vpc_config().filter(|c| c.vpc_id() == Some(vpc_id)) else {
                continue;
            };
            if out.len() >= MAX_ITEMS {
                break 'pages;
            }
            let name = s(f.function_name());
            out.push(
                NodeResource::new(&name, &name, ResourceKind::Lambda, cfg.subnet_ids().to_vec(), "active")
                    .field("Runtime", s(f.runtime().map(|r| r.as_str())))
                    .console(full("lambda", region, &format!("/functions/{name}"))),
            );
        }
    }
    Ok(out)
}
