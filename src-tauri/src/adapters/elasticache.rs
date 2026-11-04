use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_elasticache::types::{CacheCluster, Endpoint, LogDeliveryConfiguration, ReplicationGroup, ServerlessCache};

use super::util::{dt, opt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct ElastiCache;

#[async_trait]
impl ResourceAdapter for ElastiCache {
    fn service_id(&self) -> &'static str {
        "elasticache"
    }
    fn display_name(&self) -> &'static str {
        "ElastiCache"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![
            ResourceType {
                id: "replication-groups",
                name: "Replication Groups",
                columns: vec![
                    col("name", "Identifier", Text),
                    col("engine", "Engine", Text),
                    col("status", "Status", State),
                    col("nodeType", "Node type", Text),
                    col("shards", "Shards", Text),
                    col("nodes", "Nodes", Text),
                    col("endpoint", "Endpoint", Mono),
                ],
            },
            ResourceType {
                id: "cache-clusters",
                name: "Cache Clusters",
                columns: vec![
                    col("name", "Identifier", Text),
                    col("engine", "Engine", Text),
                    col("version", "Version", Text),
                    col("status", "Status", State),
                    col("nodeType", "Node type", Text),
                    col("nodes", "Nodes", Text),
                    col("group", "Replication group", Text),
                ],
            },
            ResourceType {
                id: "serverless-caches",
                name: "Serverless Caches",
                columns: vec![
                    col("name", "Name", Text),
                    col("engine", "Engine", Text),
                    col("version", "Version", Text),
                    col("status", "Status", State),
                    col("endpoint", "Endpoint", Mono),
                ],
            },
        ]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        let client = aws_sdk_elasticache::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        match type_id {
            "replication-groups" => {
                let mut pages = client.describe_replication_groups().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "elasticache:DescribeReplicationGroups"))?;
                    for g in page.replication_groups() {
                        if !out.push(replication_group(g, &region)) {
                            break 'pages;
                        }
                    }
                }
            }
            "cache-clusters" => {
                // 노드 목록과 노드 엔드포인트는 이 옵션을 켜야 온다
                let mut pages = client.describe_cache_clusters().show_cache_node_info(true).into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "elasticache:DescribeCacheClusters"))?;
                    for c in page.cache_clusters() {
                        if !out.push(cache_cluster(c, &region)) {
                            break 'pages;
                        }
                    }
                }
            }
            "serverless-caches" => {
                let mut pages = client.describe_serverless_caches().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "elasticache:DescribeServerlessCaches"))?;
                    for c in page.serverless_caches() {
                        if !out.push(serverless_cache(c, &region)) {
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

/// `주소:포트`. 주소가 없으면 빈 문자열
fn address(e: Option<&Endpoint>) -> String {
    match e.and_then(|e| e.address()) {
        Some(a) => match e.and_then(|e| e.port()) {
            Some(p) => format!("{a}:{p}"),
            None => a.to_string(),
        },
        None => String::new(),
    }
}

/// 켜짐·꺼짐 표시. 값이 없으면 빈 문자열
fn on_off(v: Option<bool>) -> &'static str {
    match v {
        Some(true) => "Yes",
        Some(false) => "No",
        None => "",
    }
}

/// 전송 중 암호화: 켜짐 여부와 모드(required·preferred)
fn transit(enabled: Option<bool>, mode: Option<&str>) -> String {
    match (on_off(enabled), mode) {
        ("Yes", Some(m)) => format!("Yes ({m})"),
        (v, _) => v.to_string(),
    }
}

/// 로그 전달: `slow-log → cloudwatch-logs (active)`
fn log_delivery(logs: &[LogDeliveryConfiguration]) -> String {
    logs.iter()
        .map(|l| {
            let kind = l.log_type().map(|t| t.as_str()).unwrap_or("?");
            let to = l.destination_type().map(|t| t.as_str()).unwrap_or("?");
            match l.status() {
                Some(st) => format!("{kind} → {to} ({})", st.as_str()),
                None => format!("{kind} → {to}"),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// ARN만 있는 ElastiCache 리소스는 콘솔의 리전 첫 화면으로 연다
fn console(region: &str) -> String {
    format!("https://{region}.console.aws.amazon.com/elasticache/home?region={region}")
}

fn replication_group(g: &ReplicationGroup, region: &str) -> Resource {
    let id = s(g.replication_group_id());
    let first = g.node_groups().first();
    // 클러스터 모드면 구성 엔드포인트, 아니면 첫(유일한) 샤드의 기본 엔드포인트로 붙는다
    let configuration = address(g.configuration_endpoint());
    let primary = address(first.and_then(|n| n.primary_endpoint()));
    let reader = address(first.and_then(|n| n.reader_endpoint()));
    let endpoint = if configuration.is_empty() { primary.clone() } else { configuration.clone() };
    let cluster_mode = g
        .cluster_mode()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| match g.cluster_enabled() {
            Some(true) => "enabled".into(),
            Some(false) => "disabled".into(),
            None => String::new(),
        });
    Resource::new(&id, &id)
        .arn(g.arn())
        .value("name", &id)
        .value("engine", s(g.engine()))
        .value("status", s(g.status()))
        .value("nodeType", s(g.cache_node_type()))
        .value("shards", g.node_groups().len())
        .value("nodes", g.member_clusters().len())
        .value("endpoint", &endpoint)
        .field("Description", s(g.description()))
        .field("Cluster mode", cluster_mode)
        .field("Automatic failover", s(g.automatic_failover().map(|a| a.as_str())))
        .field("Multi-AZ", s(g.multi_az().map(|m| m.as_str())))
        .field("Configuration endpoint", configuration)
        .field("Primary endpoint", primary)
        .field("Reader endpoint", reader)
        .field("Member clusters", g.member_clusters().join(", "))
        .field("Encryption in transit", transit(g.transit_encryption_enabled(), g.transit_encryption_mode().map(|m| m.as_str())))
        .field("Encryption at rest", on_off(g.at_rest_encryption_enabled()))
        .field("KMS key", s(g.kms_key_id()))
        .field("AUTH token", on_off(g.auth_token_enabled()))
        .field("User groups", g.user_group_ids().join(", "))
        .field("Data tiering", s(g.data_tiering().map(|d| d.as_str())))
        .field("Global datastore", s(g.global_replication_group_info().and_then(|i| i.global_replication_group_id())))
        .field("Snapshot retention (days)", opt(g.snapshot_retention_limit()))
        .field("Snapshot window", s(g.snapshot_window()))
        .field("Auto minor version upgrade", on_off(g.auto_minor_version_upgrade()))
        .field("Network type", s(g.network_type().map(|n| n.as_str())))
        .field("Log delivery", log_delivery(g.log_delivery_configurations()))
        .field("Created", dt(g.replication_group_create_time()))
        .raw(g)
        .console(console(region))
}

fn cache_cluster(c: &CacheCluster, region: &str) -> Resource {
    let id = s(c.cache_cluster_id());
    // Memcached는 구성 엔드포인트가 있고, Valkey·Redis OSS 노드는 노드마다 엔드포인트가 있다
    let nodes = c
        .cache_nodes()
        .iter()
        .map(|n| format!("{} {}", s(n.cache_node_id()), address(n.endpoint())))
        .collect::<Vec<_>>()
        .join(", ");
    let endpoint = match address(c.configuration_endpoint()) {
        e if e.is_empty() => address(c.cache_nodes().first().and_then(|n| n.endpoint())),
        e => e,
    };
    let security_groups = c.security_groups().iter().filter_map(|g| g.security_group_id()).collect::<Vec<_>>().join(", ");
    Resource::new(&id, &id)
        .arn(c.arn())
        .value("name", &id)
        .value("engine", s(c.engine()))
        .value("version", s(c.engine_version()))
        .value("status", s(c.cache_cluster_status()))
        .value("nodeType", s(c.cache_node_type()))
        .value("nodes", opt(c.num_cache_nodes()))
        .value("group", s(c.replication_group_id()))
        .field("Endpoint", endpoint)
        .field("Node endpoints", nodes)
        .field("AZ", s(c.preferred_availability_zone()))
        .field("Subnet group", s(c.cache_subnet_group_name()))
        .field("Security groups", security_groups)
        .field("Parameter group", s(c.cache_parameter_group().and_then(|p| p.cache_parameter_group_name())))
        .field("Maintenance window", s(c.preferred_maintenance_window()))
        .field("Encryption in transit", transit(c.transit_encryption_enabled(), c.transit_encryption_mode().map(|m| m.as_str())))
        .field("Encryption at rest", on_off(c.at_rest_encryption_enabled()))
        .field("AUTH token", on_off(c.auth_token_enabled()))
        .field("Snapshot retention (days)", opt(c.snapshot_retention_limit()))
        .field("Auto minor version upgrade", on_off(c.auto_minor_version_upgrade()))
        .field("Network type", s(c.network_type().map(|n| n.as_str())))
        .field("Log delivery", log_delivery(c.log_delivery_configurations()))
        .field("Created", dt(c.cache_cluster_create_time()))
        .raw(c)
        .console(console(region))
}

fn serverless_cache(c: &ServerlessCache, region: &str) -> Resource {
    let name = s(c.serverless_cache_name());
    let limits = c.cache_usage_limits();
    let storage = limits.and_then(|l| l.data_storage()).map(|d| {
        let unit = d.unit().map(|u| u.as_str()).unwrap_or("");
        format!("{}–{} {unit}", opt(d.minimum()), opt(d.maximum())).trim_end().to_string()
    });
    let ecpu = limits.and_then(|l| l.ecpu_per_second()).map(|e| format!("{}–{}", opt(e.minimum()), opt(e.maximum())));
    Resource::new(&name, &name)
        .arn(c.arn())
        .value("name", &name)
        .value("engine", s(c.engine()))
        .value("version", s(c.full_engine_version().or(c.major_engine_version())))
        .value("status", s(c.status()))
        .value("endpoint", address(c.endpoint()))
        .field("Description", s(c.description()))
        .field("Reader endpoint", address(c.reader_endpoint()))
        .field("Data storage limit", storage.unwrap_or_default())
        .field("ECPU per second limit", ecpu.unwrap_or_default())
        .field("Security groups", c.security_group_ids().join(", "))
        .field("Subnets", c.subnet_ids().join(", "))
        .field("User group", s(c.user_group_id()))
        .field("KMS key", s(c.kms_key_id()))
        .field("Snapshot retention (days)", opt(c.snapshot_retention_limit()))
        .field("Daily snapshot time", s(c.daily_snapshot_time()))
        .field("Network type", s(c.network_type().map(|n| n.as_str())))
        .field("Created", dt(c.create_time()))
        .raw(c)
        .console(console(region))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_elasticache::types::{CacheNode, CacheUsageLimits, ClusterMode, DataStorage, DataStorageUnit, NodeGroup, TransitEncryptionMode};

    fn endpoint(address: &str, port: i32) -> Endpoint {
        Endpoint::builder().address(address).port(port).build()
    }

    fn field<'a>(r: &'a Resource, label: &str) -> Option<&'a str> {
        r.fields.iter().find(|f| f.label == label).map(|f| f.value.as_str())
    }

    #[test]
    fn a_cluster_mode_disabled_group_connects_through_its_primary_endpoint() {
        let g = ReplicationGroup::builder()
            .replication_group_id("sessions")
            .engine("valkey")
            .status("available")
            .cache_node_type("cache.r7g.large")
            .cluster_mode(ClusterMode::Disabled)
            .member_clusters("sessions-001")
            .member_clusters("sessions-002")
            .node_groups(
                NodeGroup::builder()
                    .node_group_id("0001")
                    .primary_endpoint(endpoint("master.sessions.abc.apn2.cache.amazonaws.com", 6379))
                    .reader_endpoint(endpoint("replica.sessions.abc.apn2.cache.amazonaws.com", 6379))
                    .build(),
            )
            .transit_encryption_enabled(true)
            .transit_encryption_mode(TransitEncryptionMode::Required)
            .at_rest_encryption_enabled(false)
            .build();
        let r = replication_group(&g, "ap-northeast-2");
        assert_eq!(r.values["endpoint"], "master.sessions.abc.apn2.cache.amazonaws.com:6379");
        assert_eq!((r.values["shards"].as_str(), r.values["nodes"].as_str()), ("1", "2"));
        assert_eq!(field(&r, "Reader endpoint"), Some("replica.sessions.abc.apn2.cache.amazonaws.com:6379"));
        assert_eq!(field(&r, "Configuration endpoint"), None);
        assert_eq!(field(&r, "Encryption in transit"), Some("Yes (required)"));
        assert_eq!(field(&r, "Encryption at rest"), Some("No"));
        assert_eq!(field(&r, "Cluster mode"), Some("disabled"));
    }

    #[test]
    fn a_cluster_mode_enabled_group_connects_through_its_configuration_endpoint() {
        let g = ReplicationGroup::builder()
            .replication_group_id("cart")
            .configuration_endpoint(endpoint("clustercfg.cart.abc.apn2.cache.amazonaws.com", 6379))
            .cluster_enabled(true)
            .node_groups(NodeGroup::builder().node_group_id("0001").build())
            .node_groups(NodeGroup::builder().node_group_id("0002").build())
            .build();
        let r = replication_group(&g, "ap-northeast-2");
        assert_eq!(r.values["endpoint"], "clustercfg.cart.abc.apn2.cache.amazonaws.com:6379");
        assert_eq!(r.values["shards"], "2");
        // 응답에 cluster_mode가 없으면 cluster_enabled로 적는다
        assert_eq!(field(&r, "Cluster mode"), Some("enabled"));
        assert_eq!(field(&r, "Encryption in transit"), None);
    }

    #[test]
    fn a_memcached_cluster_shows_its_configuration_endpoint_and_every_node() {
        let c = CacheCluster::builder()
            .cache_cluster_id("catalog-mc")
            .engine("memcached")
            .engine_version("1.6.22")
            .cache_cluster_status("available")
            .num_cache_nodes(2)
            .configuration_endpoint(endpoint("catalog-mc.abc.cfg.apn2.cache.amazonaws.com", 11211))
            .cache_nodes(CacheNode::builder().cache_node_id("0001").endpoint(endpoint("catalog-mc.abc.0001.apn2.cache.amazonaws.com", 11211)).build())
            .cache_nodes(CacheNode::builder().cache_node_id("0002").endpoint(endpoint("catalog-mc.abc.0002.apn2.cache.amazonaws.com", 11211)).build())
            .build();
        let r = cache_cluster(&c, "ap-northeast-2");
        assert_eq!(r.values["version"], "1.6.22");
        assert_eq!(r.values["group"], "");
        assert_eq!(field(&r, "Endpoint"), Some("catalog-mc.abc.cfg.apn2.cache.amazonaws.com:11211"));
        assert_eq!(
            field(&r, "Node endpoints"),
            Some("0001 catalog-mc.abc.0001.apn2.cache.amazonaws.com:11211, 0002 catalog-mc.abc.0002.apn2.cache.amazonaws.com:11211")
        );
    }

    #[test]
    fn a_replication_group_member_uses_its_node_endpoint() {
        let c = CacheCluster::builder()
            .cache_cluster_id("sessions-002")
            .engine("valkey")
            .replication_group_id("sessions")
            .cache_nodes(CacheNode::builder().cache_node_id("0001").endpoint(endpoint("sessions-002.abc.apn2.cache.amazonaws.com", 6379)).build())
            .build();
        let r = cache_cluster(&c, "ap-northeast-2");
        assert_eq!(r.values["group"], "sessions");
        assert_eq!(field(&r, "Endpoint"), Some("sessions-002.abc.apn2.cache.amazonaws.com:6379"));
    }

    #[test]
    fn a_serverless_cache_shows_its_full_version_and_usage_limits() {
        let c = ServerlessCache::builder()
            .serverless_cache_name("feature-flags")
            .engine("valkey")
            .major_engine_version("8")
            .full_engine_version("8.0")
            .status("available")
            .endpoint(endpoint("feature-flags-abc.serverless.apn2.cache.amazonaws.com", 6379))
            .cache_usage_limits(
                CacheUsageLimits::builder()
                    .data_storage(DataStorage::builder().minimum(1).maximum(10).unit(DataStorageUnit::Gb).build())
                    .build(),
            )
            .build();
        let r = serverless_cache(&c, "ap-northeast-2");
        assert_eq!(r.values["version"], "8.0");
        assert_eq!(r.values["endpoint"], "feature-flags-abc.serverless.apn2.cache.amazonaws.com:6379");
        assert_eq!(field(&r, "Data storage limit"), Some("1–10 GB"));
        assert_eq!(field(&r, "ECPU per second limit"), None);
        assert_eq!(r.console_url.as_deref(), Some("https://ap-northeast-2.console.aws.amazon.com/elasticache/home?region=ap-northeast-2"));
    }
}
