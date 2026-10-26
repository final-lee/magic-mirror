use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_ec2::types::{Instance, SecurityGroup, Tag, Volume};

use super::util::{dt, name_tag, opt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Ec2;

pub(crate) fn tag_pairs(tags: &[Tag]) -> impl Iterator<Item = (Option<&str>, Option<&str>)> {
    tags.iter().map(|t| (t.key(), t.value()))
}

#[async_trait]
impl ResourceAdapter for Ec2 {
    fn service_id(&self) -> &'static str {
        "ec2"
    }
    fn display_name(&self) -> &'static str {
        "EC2"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![
            ResourceType {
                id: "instances",
                name: "Instances",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "Instance ID", Mono),
                    col("state", "State", State),
                    col("type", "Type", Text),
                    col("privateIp", "Private IP", Mono),
                    col("az", "AZ", Text),
                ],
            },
            ResourceType {
                id: "security-groups",
                name: "Security Groups",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "Group ID", Mono),
                    col("vpc", "VPC", Mono),
                    col("description", "Description", Text),
                ],
            },
            ResourceType {
                id: "volumes",
                name: "Volumes",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "Volume ID", Mono),
                    col("state", "State", State),
                    col("size", "Size (GiB)", Text),
                    col("type", "Type", Text),
                    col("attachedTo", "Attached To", Mono),
                ],
            },
        ]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        let client = aws_sdk_ec2::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        match type_id {
            "instances" => {
                let mut pages = client.describe_instances().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "ec2:DescribeInstances"))?;
                    for rsv in page.reservations() {
                        let owner = s(rsv.owner_id());
                        for i in rsv.instances() {
                            if !out.push(instance(i, &owner, &region)) {
                                break 'pages;
                            }
                        }
                    }
                }
            }
            "security-groups" => {
                let mut pages = client.describe_security_groups().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "ec2:DescribeSecurityGroups"))?;
                    for g in page.security_groups() {
                        if !out.push(security_group(g, &region)) {
                            break 'pages;
                        }
                    }
                }
            }
            "volumes" => {
                let mut pages = client.describe_volumes().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "ec2:DescribeVolumes"))?;
                    for v in page.volumes() {
                        if !out.push(volume(v, &region)) {
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

fn instance(i: &Instance, owner: &str, region: &str) -> Resource {
    let id = s(i.instance_id());
    let name = name_tag(tag_pairs(i.tags())).unwrap_or_else(|| id.clone());
    let arn = (!owner.is_empty()).then(|| format!("arn:aws:ec2:{region}:{owner}:instance/{id}"));
    Resource::new(&id, &name)
        .arn(arn)
        .value("name", &name)
        .value("id", &id)
        .value("state", s(i.state().and_then(|st| st.name()).map(|n| n.as_str())))
        .value("type", s(i.instance_type().map(|t| t.as_str())))
        .value("privateIp", s(i.private_ip_address()))
        .value("az", s(i.placement().and_then(|p| p.availability_zone())))
        .field("Public IP", s(i.public_ip_address()))
        .field("VPC", s(i.vpc_id()))
        .field("Subnet", s(i.subnet_id()))
        .field("AMI", s(i.image_id()))
        .field("Key pair", s(i.key_name()))
        .field("Launched", dt(i.launch_time()))
        .field(
            "Security groups",
            i.security_groups().iter().filter_map(|g| g.group_id()).collect::<Vec<_>>().join(", "),
        )
        .tags(tag_pairs(i.tags()))
        .raw(i)
        .console(format!("https://{region}.console.aws.amazon.com/ec2/home?region={region}#InstanceDetails:instanceId={id}"))
}

fn security_group(g: &SecurityGroup, region: &str) -> Resource {
    let id = s(g.group_id());
    let name = name_tag(tag_pairs(g.tags())).unwrap_or_else(|| s(g.group_name()));
    let owner = s(g.owner_id());
    let arn = (!owner.is_empty()).then(|| format!("arn:aws:ec2:{region}:{owner}:security-group/{id}"));
    Resource::new(&id, &name)
        .arn(arn)
        .value("name", &name)
        .value("id", &id)
        .value("vpc", s(g.vpc_id()))
        .value("description", s(g.description()))
        .field("Group name", s(g.group_name()))
        .field("Inbound rules", g.ip_permissions().len())
        .field("Outbound rules", g.ip_permissions_egress().len())
        .tags(tag_pairs(g.tags()))
        .raw(g)
        .console(format!("https://{region}.console.aws.amazon.com/ec2/home?region={region}#SecurityGroup:groupId={id}"))
}

fn volume(v: &Volume, region: &str) -> Resource {
    let id = s(v.volume_id());
    let name = name_tag(tag_pairs(v.tags())).unwrap_or_else(|| id.clone());
    Resource::new(&id, &name)
        .value("name", &name)
        .value("id", &id)
        .value("state", s(v.state().map(|st| st.as_str())))
        .value("size", opt(v.size()))
        .value("type", s(v.volume_type().map(|t| t.as_str())))
        .value(
            "attachedTo",
            v.attachments().iter().filter_map(|a| a.instance_id()).collect::<Vec<_>>().join(", "),
        )
        .field("AZ", s(v.availability_zone()))
        .field("IOPS", opt(v.iops()))
        .field("Encrypted", opt(v.encrypted()))
        .field("Created", dt(v.create_time()))
        .tags(tag_pairs(v.tags()))
        .raw(v)
        .console(format!("https://{region}.console.aws.amazon.com/ec2/home?region={region}#VolumeDetails:volumeId={id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ec2::types::{
        InstanceState, InstanceStateName, InstanceType, Placement, VolumeAttachment, VolumeState, VolumeType,
    };

    #[test]
    fn instance_uses_name_tag_and_builds_arn() {
        let i = Instance::builder()
            .instance_id("i-1")
            .instance_type(InstanceType::T3Micro)
            .state(InstanceState::builder().name(InstanceStateName::Running).build())
            .private_ip_address("10.0.0.1")
            .placement(Placement::builder().availability_zone("ap-northeast-2a").build())
            .tags(Tag::builder().key("Name").value("web-1").build())
            .tags(Tag::builder().key("env").value("prod").build())
            .build();
        let r = instance(&i, "123456789012", "ap-northeast-2");
        assert_eq!(r.id, "i-1");
        assert_eq!(r.name, "web-1");
        assert_eq!(r.values["state"], "running");
        assert_eq!(r.values["type"], "t3.micro");
        assert_eq!(r.values["az"], "ap-northeast-2a");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:ec2:ap-northeast-2:123456789012:instance/i-1"));
        assert_eq!(r.tags["env"], "prod");
        assert!(r.console_url.unwrap().contains("instanceId=i-1"));
    }

    #[test]
    fn instance_without_name_tag_falls_back_to_id() {
        let i = Instance::builder().instance_id("i-2").build();
        let r = instance(&i, "", "us-east-1");
        assert_eq!(r.name, "i-2");
        assert_eq!(r.arn, None);
        assert_eq!(r.values["state"], "");
    }

    #[test]
    fn security_group_falls_back_to_group_name() {
        let g = SecurityGroup::builder().group_id("sg-1").group_name("web").vpc_id("vpc-1").owner_id("1").build();
        let r = security_group(&g, "us-east-1");
        assert_eq!(r.name, "web");
        assert_eq!(r.values["vpc"], "vpc-1");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:ec2:us-east-1:1:security-group/sg-1"));
    }

    #[test]
    fn volume_lists_attachments() {
        let v = Volume::builder()
            .volume_id("vol-1")
            .state(VolumeState::InUse)
            .size(8)
            .volume_type(VolumeType::Gp3)
            .attachments(VolumeAttachment::builder().instance_id("i-1").build())
            .build();
        let r = volume(&v, "us-east-1");
        assert_eq!(r.values["state"], "in-use");
        assert_eq!(r.values["size"], "8");
        assert_eq!(r.values["type"], "gp3");
        assert_eq!(r.values["attachedTo"], "i-1");
    }
}
