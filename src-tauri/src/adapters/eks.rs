use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_eks::types::{Cluster, Nodegroup};
use aws_sdk_eks::Client;

use super::util::{
    degraded, dt, hash_tags, map_concurrent, opt, region, s, settle, unknown_type, Capped,
};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Eks;

async fn cluster_names(client: &Client) -> Result<Vec<String>, AppError> {
    let mut names = Vec::new();
    let mut pages = client.list_clusters().into_paginator().send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "eks:ListClusters"))?;
        names.extend(page.clusters().iter().cloned());
    }
    Ok(names)
}

#[async_trait]
impl ResourceAdapter for Eks {
    fn service_id(&self) -> &'static str {
        "eks"
    }
    fn display_name(&self) -> &'static str {
        "EKS"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![
            ResourceType {
                id: "clusters",
                name: "Clusters",
                columns: vec![
                    col("name", "Name", Text),
                    col("version", "Version", Text),
                    col("status", "Status", State),
                    col("endpoint", "Endpoint", Mono),
                ],
            },
            ResourceType {
                id: "node-groups",
                name: "Node Groups",
                columns: vec![
                    col("name", "Name", Text),
                    col("cluster", "Cluster", Text),
                    col("status", "Status", State),
                    col("instanceTypes", "Instance types", Text),
                    col("size", "Size (min/desired/max)", Text),
                ],
            },
        ]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        let client = Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        match type_id {
            "clusters" => {
                let names = cluster_names(&client).await?;
                let results = map_concurrent(names.clone(), |name| {
                    let client = client.clone();
                    let region = region.clone();
                    async move {
                        client
                            .describe_cluster()
                            .name(name)
                            .send()
                            .await
                            .map(|res| res.cluster().map(|c| cluster(c, &region)))
                            .map_err(|e| from_sdk(e, "eks:DescribeCluster"))
                    }
                })
                .await;
                let rows = settle(results, |i, e| {
                    Some(degraded(&names[i], &names[i], None, e))
                })?;
                for r in rows.into_iter().flatten() {
                    if !out.push(r) {
                        break;
                    }
                }
            }
            "node-groups" => {
                'outer: for cluster_name in cluster_names(&client).await? {
                    let mut ng_names = Vec::new();
                    let mut pages = client
                        .list_nodegroups()
                        .cluster_name(&cluster_name)
                        .into_paginator()
                        .send();
                    while let Some(page) = pages.next().await {
                        let page = page.map_err(|e| from_sdk(e, "eks:ListNodegroups"))?;
                        ng_names.extend(page.nodegroups().iter().cloned());
                    }
                    let results = map_concurrent(ng_names.clone(), |ng| {
                        let client = client.clone();
                        let cluster_name = cluster_name.clone();
                        let region = region.clone();
                        async move {
                            client
                                .describe_nodegroup()
                                .cluster_name(cluster_name)
                                .nodegroup_name(ng)
                                .send()
                                .await
                                .map(|res| res.nodegroup().map(|n| nodegroup(n, &region)))
                                .map_err(|e| from_sdk(e, "eks:DescribeNodegroup"))
                        }
                    })
                    .await;
                    let rows = settle(results, |i, e| {
                        let mut r = degraded(&ng_names[i], &ng_names[i], None, e)
                            .value("cluster", &cluster_name);
                        r.id = format!("{cluster_name}/{}", ng_names[i]);
                        Some(r)
                    })?;
                    for r in rows.into_iter().flatten() {
                        if !out.push(r) {
                            break 'outer;
                        }
                    }
                }
            }
            other => return Err(unknown_type(other)),
        }
        Ok(out.finish())
    }
}

fn cluster(c: &Cluster, region: &str) -> Resource {
    let name = s(c.name());
    Resource::new(&name, &name)
        .arn(c.arn())
        .value("name", &name)
        .value("version", s(c.version()))
        .value("status", s(c.status().map(|st| st.as_str())))
        .value("endpoint", s(c.endpoint()))
        .field("Platform version", s(c.platform_version()))
        .field("Role", s(c.role_arn()))
        .field("Created", dt(c.created_at()))
        .tags(hash_tags(c.tags()))
        .raw(c)
        .console(format!(
            "https://{region}.console.aws.amazon.com/eks/home?region={region}#/clusters/{name}"
        ))
}

fn nodegroup(ng: &Nodegroup, region: &str) -> Resource {
    let name = s(ng.nodegroup_name());
    let cluster = s(ng.cluster_name());
    let size = ng
        .scaling_config()
        .map(|sc| {
            format!(
                "{}/{}/{}",
                opt(sc.min_size()),
                opt(sc.desired_size()),
                opt(sc.max_size())
            )
        })
        .unwrap_or_default();
    Resource::new(s(ng.nodegroup_arn()), &name)
        .arn(ng.nodegroup_arn())
        .value("name", &name)
        .value("cluster", &cluster)
        .value("status", s(ng.status().map(|st| st.as_str())))
        .value("instanceTypes", ng.instance_types().join(", "))
        .value("size", size)
        .field("Capacity type", s(ng.capacity_type().map(|c| c.as_str())))
        .field("Kubernetes version", s(ng.version()))
        .field("AMI release", s(ng.release_version()))
        .field("Created", dt(ng.created_at()))
        .tags(hash_tags(ng.tags()))
        .raw(ng)
        .console(format!(
            "https://{region}.console.aws.amazon.com/eks/home?region={region}#/clusters/{cluster}/nodegroups/{name}"
        ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_eks::types::{ClusterStatus, NodegroupScalingConfig, NodegroupStatus};

    #[test]
    fn cluster_resource_with_tags() {
        let c = Cluster::builder()
            .name("prod")
            .version("1.31")
            .status(ClusterStatus::Active)
            .endpoint("https://abc.eks.amazonaws.com")
            .tags("env", "prod")
            .build();
        let r = cluster(&c, "ap-northeast-2");
        assert_eq!(r.values["status"], "ACTIVE");
        assert_eq!(r.values["version"], "1.31");
        assert_eq!(r.tags["env"], "prod");
    }

    #[test]
    fn nodegroup_size_and_types() {
        let ng = Nodegroup::builder()
            .nodegroup_name("default")
            .cluster_name("prod")
            .status(NodegroupStatus::Active)
            .instance_types("m6i.large")
            .instance_types("m6i.xlarge")
            .scaling_config(
                NodegroupScalingConfig::builder()
                    .min_size(1)
                    .desired_size(2)
                    .max_size(5)
                    .build(),
            )
            .build();
        let r = nodegroup(&ng, "ap-northeast-2");
        assert_eq!(r.values["instanceTypes"], "m6i.large, m6i.xlarge");
        assert_eq!(r.values["size"], "1/2/5");
        assert!(r
            .console_url
            .unwrap()
            .contains("/clusters/prod/nodegroups/default"));
    }
}
