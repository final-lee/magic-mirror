use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_ec2::types::{Subnet, Vpc as SdkVpc};

use super::ec2::tag_pairs;
use super::util::{name_tag, opt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Vpc;

#[async_trait]
impl ResourceAdapter for Vpc {
    fn service_id(&self) -> &'static str {
        "vpc"
    }
    fn display_name(&self) -> &'static str {
        "VPC"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![
            ResourceType {
                id: "vpcs",
                name: "VPCs",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "VPC ID", Mono),
                    col("cidr", "CIDR", Mono),
                    col("default", "Default", Text),
                    col("state", "State", State),
                ],
            },
            ResourceType {
                id: "subnets",
                name: "Subnets",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "Subnet ID", Mono),
                    col("vpc", "VPC", Mono),
                    col("cidr", "CIDR", Mono),
                    col("az", "AZ", Text),
                ],
            },
        ]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        let client = aws_sdk_ec2::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        match type_id {
            "vpcs" => {
                let mut pages = client.describe_vpcs().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "ec2:DescribeVpcs"))?;
                    for v in page.vpcs() {
                        if !out.push(vpc(v, &region)) {
                            break 'pages;
                        }
                    }
                }
            }
            "subnets" => {
                let mut pages = client.describe_subnets().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "ec2:DescribeSubnets"))?;
                    for sn in page.subnets() {
                        if !out.push(subnet(sn, &region)) {
                            break 'pages;
                        }
                    }
                }
            }
            other => return Err(unknown_type(other)),
        }
        Ok(out.finish())
    }
}

fn yes_no(b: Option<bool>) -> &'static str {
    if b == Some(true) {
        "Yes"
    } else {
        "No"
    }
}

fn vpc(v: &SdkVpc, region: &str) -> Resource {
    let id = s(v.vpc_id());
    let name = name_tag(tag_pairs(v.tags())).unwrap_or_else(|| id.clone());
    let owner = s(v.owner_id());
    let arn = (!owner.is_empty()).then(|| format!("arn:aws:ec2:{region}:{owner}:vpc/{id}"));
    Resource::new(&id, &name)
        .arn(arn)
        .value("name", &name)
        .value("id", &id)
        .value("cidr", s(v.cidr_block()))
        .value("default", yes_no(v.is_default()))
        .value("state", s(v.state().map(|st| st.as_str())))
        .field("Tenancy", s(v.instance_tenancy().map(|t| t.as_str())))
        .field("DHCP options", s(v.dhcp_options_id()))
        .tags(tag_pairs(v.tags()))
        .raw(v)
        .console(format!("https://{region}.console.aws.amazon.com/vpcconsole/home?region={region}#VpcDetails:VpcId={id}"))
}

fn subnet(sn: &Subnet, region: &str) -> Resource {
    let id = s(sn.subnet_id());
    let name = name_tag(tag_pairs(sn.tags())).unwrap_or_else(|| id.clone());
    Resource::new(&id, &name)
        .arn(sn.subnet_arn())
        .value("name", &name)
        .value("id", &id)
        .value("vpc", s(sn.vpc_id()))
        .value("cidr", s(sn.cidr_block()))
        .value("az", s(sn.availability_zone()))
        .field("Available IPs", opt(sn.available_ip_address_count()))
        .field("Public IP on launch", yes_no(sn.map_public_ip_on_launch()))
        .field("Default for AZ", yes_no(sn.default_for_az()))
        .tags(tag_pairs(sn.tags()))
        .raw(sn)
        .console(format!("https://{region}.console.aws.amazon.com/vpcconsole/home?region={region}#SubnetDetails:subnetId={id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ec2::types::Tag;

    #[test]
    fn vpc_default_flag_and_arn() {
        let v = SdkVpc::builder().vpc_id("vpc-1").cidr_block("10.0.0.0/16").is_default(true).owner_id("1").build();
        let r = vpc(&v, "ap-northeast-2");
        assert_eq!(r.name, "vpc-1");
        assert_eq!(r.values["default"], "Yes");
        assert_eq!(r.values["cidr"], "10.0.0.0/16");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:ec2:ap-northeast-2:1:vpc/vpc-1"));
    }

    #[test]
    fn subnet_uses_name_tag_and_sdk_arn() {
        let sn = Subnet::builder()
            .subnet_id("subnet-1")
            .subnet_arn("arn:aws:ec2:r:1:subnet/subnet-1")
            .vpc_id("vpc-1")
            .availability_zone("ap-northeast-2a")
            .tags(Tag::builder().key("Name").value("private-a").build())
            .build();
        let r = subnet(&sn, "ap-northeast-2");
        assert_eq!(r.name, "private-a");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:ec2:r:1:subnet/subnet-1"));
        assert_eq!(r.values["az"], "ap-northeast-2a");
    }
}
