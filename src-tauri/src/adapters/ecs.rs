use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_ecs::types::{Cluster, ClusterField, Service, ServiceField, Tag, Task, TaskField};
use aws_sdk_ecs::Client;

use super::util::{degraded, dt, last_segment, region, s, settle, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Ecs;

fn tag_pairs(tags: &[Tag]) -> impl Iterator<Item = (Option<&str>, Option<&str>)> {
    tags.iter().map(|t| (t.key(), t.value()))
}

async fn cluster_arns(client: &Client) -> Result<Vec<String>, AppError> {
    let mut arns = Vec::new();
    let mut pages = client.list_clusters().into_paginator().send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "ecs:ListClusters"))?;
        arns.extend(page.cluster_arns().iter().cloned());
    }
    Ok(arns)
}

#[async_trait]
impl ResourceAdapter for Ecs {
    fn service_id(&self) -> &'static str {
        "ecs"
    }
    fn display_name(&self) -> &'static str {
        "ECS"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![
            ResourceType {
                id: "clusters",
                name: "Clusters",
                columns: vec![
                    col("name", "Name", Text),
                    col("status", "Status", State),
                    col("services", "Services", Text),
                    col("runningTasks", "Running tasks", Text),
                ],
            },
            ResourceType {
                id: "services",
                name: "Services",
                columns: vec![
                    col("name", "Name", Text),
                    col("cluster", "Cluster", Text),
                    col("status", "Status", State),
                    col("tasks", "Running/Desired", Text),
                ],
            },
            ResourceType {
                id: "tasks",
                name: "Tasks",
                columns: vec![
                    col("id", "Task ID", Mono),
                    col("cluster", "Cluster", Text),
                    col("status", "Status", State),
                    col("taskDefinition", "Task definition", Text),
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
                let arns = cluster_arns(&client).await?;
                let mut results = Vec::new();
                for chunk in arns.chunks(100) {
                    results.push(
                        client
                            .describe_clusters()
                            .set_clusters(Some(chunk.to_vec()))
                            .include(ClusterField::Tags)
                            .send()
                            .await
                            .map(|res| {
                                res.clusters()
                                    .iter()
                                    .map(|c| cluster(c, &region))
                                    .collect::<Vec<_>>()
                            })
                            .map_err(|e| from_sdk(e, "ecs:DescribeClusters")),
                    );
                }
                let chunks: Vec<&[String]> = arns.chunks(100).collect();
                let rows = settle(results, |i, e| {
                    chunks[i]
                        .iter()
                        .map(|a| {
                            let n = last_segment(a, '/');
                            degraded(&n, &n, Some(a), e)
                        })
                        .collect()
                })?;
                for r in rows.into_iter().flatten() {
                    if !out.push(r) {
                        break;
                    }
                }
            }
            "services" => {
                'outer: for cluster_arn in cluster_arns(&client).await? {
                    let mut service_arns = Vec::new();
                    let mut pages = client
                        .list_services()
                        .cluster(&cluster_arn)
                        .into_paginator()
                        .send();
                    while let Some(page) = pages.next().await {
                        let page = page.map_err(|e| from_sdk(e, "ecs:ListServices"))?;
                        service_arns.extend(page.service_arns().iter().cloned());
                    }
                    let mut results = Vec::new();
                    for chunk in service_arns.chunks(10) {
                        results.push(
                            client
                                .describe_services()
                                .cluster(&cluster_arn)
                                .set_services(Some(chunk.to_vec()))
                                .include(ServiceField::Tags)
                                .send()
                                .await
                                .map(|res| {
                                    res.services()
                                        .iter()
                                        .map(|svc| service(svc, &region))
                                        .collect::<Vec<_>>()
                                })
                                .map_err(|e| from_sdk(e, "ecs:DescribeServices")),
                        );
                    }
                    let chunks: Vec<&[String]> = service_arns.chunks(10).collect();
                    let rows = settle(results, |i, e| {
                        chunks[i]
                            .iter()
                            .map(|a| degraded(a, &last_segment(a, '/'), Some(a), e))
                            .collect()
                    })?;
                    for r in rows.into_iter().flatten() {
                        if !out.push(r) {
                            break 'outer;
                        }
                    }
                }
            }
            "tasks" => {
                'outer: for cluster_arn in cluster_arns(&client).await? {
                    let mut task_arns = Vec::new();
                    let mut pages = client
                        .list_tasks()
                        .cluster(&cluster_arn)
                        .into_paginator()
                        .send();
                    while let Some(page) = pages.next().await {
                        let page = page.map_err(|e| from_sdk(e, "ecs:ListTasks"))?;
                        task_arns.extend(page.task_arns().iter().cloned());
                    }
                    let mut results = Vec::new();
                    for chunk in task_arns.chunks(100) {
                        results.push(
                            client
                                .describe_tasks()
                                .cluster(&cluster_arn)
                                .set_tasks(Some(chunk.to_vec()))
                                .include(TaskField::Tags)
                                .send()
                                .await
                                .map(|res| {
                                    res.tasks()
                                        .iter()
                                        .map(|t| task(t, &region))
                                        .collect::<Vec<_>>()
                                })
                                .map_err(|e| from_sdk(e, "ecs:DescribeTasks")),
                        );
                    }
                    let chunks: Vec<&[String]> = task_arns.chunks(100).collect();
                    let rows = settle(results, |i, e| {
                        chunks[i]
                            .iter()
                            .map(|a| {
                                let n = last_segment(a, '/');
                                degraded(&n, &n, Some(a), e)
                            })
                            .collect()
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
    let name = s(c.cluster_name());
    Resource::new(&name, &name)
        .arn(c.cluster_arn())
        .value("name", &name)
        .value("status", s(c.status()))
        .value("services", c.active_services_count())
        .value("runningTasks", c.running_tasks_count())
        .field("Pending tasks", c.pending_tasks_count())
        .field(
            "Container instances",
            c.registered_container_instances_count(),
        )
        .field("Capacity providers", c.capacity_providers().join(", "))
        .tags(tag_pairs(c.tags()))
        .raw(c)
        .console(format!(
            "https://{region}.console.aws.amazon.com/ecs/v2/clusters/{name}?region={region}"
        ))
}

fn service(svc: &Service, region: &str) -> Resource {
    let name = s(svc.service_name());
    let cluster = last_segment(&s(svc.cluster_arn()), '/');
    Resource::new(s(svc.service_arn()), &name)
        .arn(svc.service_arn())
        .value("name", &name)
        .value("cluster", &cluster)
        .value("status", s(svc.status()))
        .value("tasks", format!("{}/{}", svc.running_count(), svc.desired_count()))
        .field("Pending", svc.pending_count())
        .field("Launch type", s(svc.launch_type().map(|l| l.as_str())))
        .field("Task definition", last_segment(&s(svc.task_definition()), '/'))
        .field("Created", dt(svc.created_at()))
        .tags(tag_pairs(svc.tags()))
        .raw(svc)
        .console(format!(
            "https://{region}.console.aws.amazon.com/ecs/v2/clusters/{cluster}/services/{name}?region={region}"
        ))
}

fn task(t: &Task, region: &str) -> Resource {
    let arn = s(t.task_arn());
    let id = last_segment(&arn, '/');
    let cluster = last_segment(&s(t.cluster_arn()), '/');
    Resource::new(&id, &id)
        .arn(t.task_arn())
        .value("id", &id)
        .value("cluster", &cluster)
        .value("status", s(t.last_status()))
        .value("taskDefinition", last_segment(&s(t.task_definition_arn()), '/'))
        .field("Desired status", s(t.desired_status()))
        .field("Launch type", s(t.launch_type().map(|l| l.as_str())))
        .field("CPU", s(t.cpu()))
        .field("Memory", s(t.memory()))
        .field("Group", s(t.group()))
        .field("AZ", s(t.availability_zone()))
        .field("Started", dt(t.started_at()))
        .tags(tag_pairs(t.tags()))
        .raw(t)
        .console(format!(
            "https://{region}.console.aws.amazon.com/ecs/v2/clusters/{cluster}/tasks/{id}?region={region}"
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cluster_counts() {
        let c = Cluster::builder()
            .cluster_name("prod")
            .cluster_arn("arn:aws:ecs:r:1:cluster/prod")
            .status("ACTIVE")
            .active_services_count(3)
            .running_tasks_count(7)
            .build();
        let r = cluster(&c, "ap-northeast-2");
        assert_eq!(r.values["services"], "3");
        assert_eq!(r.values["runningTasks"], "7");
        assert!(r.console_url.unwrap().contains("/clusters/prod"));
    }

    #[test]
    fn service_shows_cluster_and_counts() {
        let svc = Service::builder()
            .service_name("api")
            .service_arn("arn:aws:ecs:r:1:service/prod/api")
            .cluster_arn("arn:aws:ecs:r:1:cluster/prod")
            .status("ACTIVE")
            .running_count(2)
            .desired_count(3)
            .build();
        let r = service(&svc, "ap-northeast-2");
        assert_eq!(r.values["cluster"], "prod");
        assert_eq!(r.values["tasks"], "2/3");
        assert!(r
            .console_url
            .unwrap()
            .contains("/clusters/prod/services/api"));
    }

    #[test]
    fn task_uses_short_ids() {
        let t = Task::builder()
            .task_arn("arn:aws:ecs:r:1:task/prod/abc123")
            .cluster_arn("arn:aws:ecs:r:1:cluster/prod")
            .last_status("RUNNING")
            .task_definition_arn("arn:aws:ecs:r:1:task-definition/api:42")
            .build();
        let r = task(&t, "ap-northeast-2");
        assert_eq!(r.id, "abc123");
        assert_eq!(r.values["taskDefinition"], "api:42");
        assert_eq!(r.values["status"], "RUNNING");
    }
}
