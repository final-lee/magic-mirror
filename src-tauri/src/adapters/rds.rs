use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_rds::types::{DbCluster, DbInstance, Tag};

use super::util::{dt, opt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Rds;

fn tag_pairs(tags: &[Tag]) -> impl Iterator<Item = (Option<&str>, Option<&str>)> {
    tags.iter().map(|t| (t.key(), t.value()))
}

#[async_trait]
impl ResourceAdapter for Rds {
    fn service_id(&self) -> &'static str {
        "rds"
    }
    fn display_name(&self) -> &'static str {
        "RDS"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![
            ResourceType {
                id: "db-instances",
                name: "DB Instances",
                columns: vec![
                    col("name", "Identifier", Text),
                    col("engine", "Engine", Text),
                    col("class", "Class", Text),
                    col("status", "Status", State),
                    col("endpoint", "Endpoint", Mono),
                ],
            },
            ResourceType {
                id: "db-clusters",
                name: "DB Clusters",
                columns: vec![
                    col("name", "Identifier", Text),
                    col("engine", "Engine", Text),
                    col("status", "Status", State),
                    col("endpoint", "Endpoint", Mono),
                ],
            },
        ]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        let client = aws_sdk_rds::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        match type_id {
            "db-instances" => {
                let mut pages = client.describe_db_instances().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "rds:DescribeDBInstances"))?;
                    for d in page.db_instances() {
                        if !out.push(db_instance(d, &region)) {
                            break 'pages;
                        }
                    }
                }
            }
            "db-clusters" => {
                let mut pages = client.describe_db_clusters().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "rds:DescribeDBClusters"))?;
                    for c in page.db_clusters() {
                        if !out.push(db_cluster(c, &region)) {
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

fn db_instance(d: &DbInstance, region: &str) -> Resource {
    let id = s(d.db_instance_identifier());
    Resource::new(&id, &id)
        .arn(d.db_instance_arn())
        .value("name", &id)
        .value("engine", s(d.engine()))
        .value("class", s(d.db_instance_class()))
        .value("status", s(d.db_instance_status()))
        .value("endpoint", s(d.endpoint().and_then(|e| e.address())))
        .value("cluster", s(d.db_cluster_identifier()))
        .field("Engine version", s(d.engine_version()))
        .field("Multi-AZ", opt(d.multi_az()))
        .field("Storage (GiB)", opt(d.allocated_storage()))
        .field("AZ", s(d.availability_zone()))
        .field("VPC", s(d.db_subnet_group().and_then(|g| g.vpc_id())))
        .field("Cluster", s(d.db_cluster_identifier()))
        .field("Created", dt(d.instance_create_time()))
        .tags(tag_pairs(d.tag_list()))
        .raw(d)
        .console(format!("https://{region}.console.aws.amazon.com/rds/home?region={region}#database:id={id};is-cluster=false"))
}

fn db_cluster(c: &DbCluster, region: &str) -> Resource {
    let id = s(c.db_cluster_identifier());
    Resource::new(&id, &id)
        .arn(c.db_cluster_arn())
        .value("name", &id)
        .value("engine", s(c.engine()))
        .value("status", s(c.status()))
        .value("endpoint", s(c.endpoint()))
        .field("Engine version", s(c.engine_version()))
        .field("Reader endpoint", s(c.reader_endpoint()))
        .field("Members", c.db_cluster_members().len())
        .field("Multi-AZ", opt(c.multi_az()))
        .field("Created", dt(c.cluster_create_time()))
        .tags(tag_pairs(c.tag_list()))
        .raw(c)
        .console(format!("https://{region}.console.aws.amazon.com/rds/home?region={region}#database:id={id};is-cluster=true"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_rds::types::Endpoint;

    #[test]
    fn db_instance_resource() {
        let d = DbInstance::builder()
            .db_instance_identifier("orders-db")
            .engine("postgres")
            .db_instance_class("db.t4g.medium")
            .db_instance_status("available")
            .endpoint(Endpoint::builder().address("orders-db.abc.rds.amazonaws.com").build())
            .db_instance_arn("arn:aws:rds:r:1:db:orders-db")
            .db_cluster_identifier("orders-cluster")
            .tag_list(Tag::builder().key("env").value("prod").build())
            .build();
        let r = db_instance(&d, "ap-northeast-2");
        assert_eq!(r.values["status"], "available");
        assert_eq!(r.values["endpoint"], "orders-db.abc.rds.amazonaws.com");
        // PostgreSQL 탭이 Aurora 인스턴스를 그 클러스터의 탭으로 열 때 읽는다
        assert_eq!(r.values["cluster"], "orders-cluster");
        assert_eq!(r.tags["env"], "prod");
        assert!(r.console_url.unwrap().contains("is-cluster=false"));
    }

    #[test]
    fn a_standalone_db_instance_has_an_empty_cluster_value() {
        let d = DbInstance::builder().db_instance_identifier("orders-db").engine("postgres").build();
        assert_eq!(db_instance(&d, "ap-northeast-2").values["cluster"], "");
    }

    #[test]
    fn db_cluster_resource() {
        let c = DbCluster::builder()
            .db_cluster_identifier("aurora-1")
            .engine("aurora-mysql")
            .status("available")
            .endpoint("aurora-1.cluster-abc.rds.amazonaws.com")
            .build();
        let r = db_cluster(&c, "ap-northeast-2");
        assert_eq!(r.name, "aurora-1");
        assert_eq!(r.values["engine"], "aurora-mysql");
        assert!(r.console_url.unwrap().contains("is-cluster=true"));
    }
}
