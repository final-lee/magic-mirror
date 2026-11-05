use aws_sdk_elasticache::types::{Authentication, CacheNode, NodeGroup, NodeGroupMember};

use super::*;

fn endpoint(address: &str, port: i32) -> Endpoint {
    Endpoint::builder().address(address).port(port).build()
}

fn member(id: &str, address: &str, role: &str) -> NodeGroupMember {
    NodeGroupMember::builder().cache_cluster_id(id).read_endpoint(endpoint(address, 6379)).current_role(role).build()
}

fn disabled_group() -> ReplicationGroup {
    ReplicationGroup::builder()
        .replication_group_id("sessions")
        .arn("arn:aws:elasticache:ap-northeast-2:111111111111:replicationgroup:sessions")
        .cluster_enabled(false)
        .transit_encryption_enabled(true)
        .auth_token_enabled(false)
        .user_group_ids("ug-1")
        .member_clusters("sessions-001")
        .member_clusters("sessions-002")
        .node_groups(
            NodeGroup::builder()
                .node_group_id("0001")
                .primary_endpoint(endpoint("master.sessions.abc.apn2.cache.amazonaws.com", 6379))
                .reader_endpoint(endpoint("replica.sessions.abc.apn2.cache.amazonaws.com", 6379))
                .node_group_members(member("sessions-001", "sessions-001.abc.0001.apn2.cache.amazonaws.com", "primary"))
                .node_group_members(member("sessions-002", "sessions-002.abc.0001.apn2.cache.amazonaws.com", "replica"))
                .build(),
        )
        .build()
}

fn member_cluster(engine: &str, version: &str) -> CacheCluster {
    CacheCluster::builder().cache_cluster_id("sessions-001").engine(engine).engine_version(version).build()
}

#[test]
fn a_cluster_mode_disabled_group_connects_through_its_primary_and_reads_through_the_reader() {
    let users = Some(vec![KvUser { id: "u1".into(), name: "app".into(), auth: "iam".into(), status: "active".into(), access: "on ~* +@all".into() }]);
    let resolved = info_of_group(&disabled_group(), Some(&member_cluster("valkey", "8.0.2")), users.clone()).unwrap();
    let info = &resolved.info;
    assert_eq!(info.kind, KvKind::ReplicationGroup);
    assert_eq!(info.identifier, "sessions");
    assert_eq!(info.engine, "valkey");
    assert_eq!(info.engine_version, "8.0.2");
    assert_eq!(info.endpoint, "master.sessions.abc.apn2.cache.amazonaws.com");
    assert_eq!(info.port, 6379);
    assert_eq!(info.reader_endpoint.as_deref(), Some("replica.sessions.abc.apn2.cache.amazonaws.com"));
    assert!(info.tls && !info.cluster_mode && !info.serverless && !info.auth_token_enabled);
    assert_eq!(info.user_group_ids, vec!["ug-1".to_string()]);
    assert_eq!(info.users, users);
    assert!(info.iam_supported);
    assert_eq!(resolved.members.len(), 2);
    assert_eq!(resolved.members[0], KvNode { id: "sessions-001".into(), address: "sessions-001.abc.0001.apn2.cache.amazonaws.com:6379".into(), role: KvRole::Primary, shard: Some("0001".into()), slots: None });
    assert_eq!(resolved.members[1].role, KvRole::Replica);
}

#[test]
fn a_cluster_mode_enabled_group_connects_through_its_configuration_endpoint() {
    let group = ReplicationGroup::builder()
        .replication_group_id("sharded")
        .cluster_enabled(true)
        .transit_encryption_enabled(true)
        .auth_token_enabled(true)
        .configuration_endpoint(endpoint("clustercfg.sharded.abc.apn2.cache.amazonaws.com", 6379))
        .node_groups(NodeGroup::builder().primary_endpoint(endpoint("ignored", 1)).build())
        .build();
    let resolved = info_of_group(&group, Some(&member_cluster("redis", "7.1.0")), None).unwrap();
    assert!(resolved.info.cluster_mode);
    assert_eq!(resolved.info.endpoint, "clustercfg.sharded.abc.apn2.cache.amazonaws.com");
    assert_eq!(resolved.info.reader_endpoint, None);
    assert!(resolved.info.auth_token_enabled);
    assert_eq!(resolved.info.users, None);
    assert!(resolved.members.is_empty());
}

#[test]
fn a_group_without_an_endpoint_yet_says_so() {
    let group = ReplicationGroup::builder().replication_group_id("creating").build();
    assert_eq!(info_of_group(&group, Some(&member_cluster("redis", "7.0.7")), None).unwrap_err(), endpoint_missing());
}

#[test]
fn memcached_is_refused_with_the_designed_message() {
    let expected = AppError::other("Valkey·Redis OSS 캐시만 열 수 있어요");
    assert_eq!(info_of_group(&disabled_group(), Some(&member_cluster("memcached", "1.6.22")), None).unwrap_err(), expected);
    let cluster = CacheCluster::builder().cache_cluster_id("mc").engine("memcached").build();
    assert_eq!(info_of_cache_cluster(&cluster).unwrap_err(), expected);
    let serverless = ServerlessCache::builder().engine("memcached").build();
    assert_eq!(info_of_serverless(&serverless, None).unwrap_err(), expected);
}

#[test]
fn iam_support_follows_engine_version_and_tls() {
    assert!(iam_supported("valkey", "7.2.6", true));
    assert!(iam_supported("valkey", "8", true));
    assert!(!iam_supported("valkey", "7.1", true));
    assert!(iam_supported("redis", "7.0.7", true));
    assert!(iam_supported("redis", "7.1.0", true));
    assert!(!iam_supported("redis", "6.2.6", true));
    assert!(!iam_supported("valkey", "8.0.2", false));
    assert!(!iam_supported("redis", "", true));
    assert!(!iam_supported("redis", "latest", true));
}

#[test]
fn a_serverless_cache_is_always_tls_cluster_mode_and_never_has_an_auth_token() {
    let cache = ServerlessCache::builder()
        .serverless_cache_name("Sessions")
        .arn("arn:aws:elasticache:us-east-1:111111111111:serverlesscache:sessions")
        .engine("valkey")
        .full_engine_version("8.0")
        .endpoint(endpoint("sessions-abc.serverless.use1.cache.amazonaws.com", 6379))
        .reader_endpoint(endpoint("sessions-abc-ro.serverless.use1.cache.amazonaws.com", 6380))
        .user_group_id("ug-2")
        .build();
    let resolved = info_of_serverless(&cache, None).unwrap();
    let info = resolved.info;
    assert!(info.serverless && info.tls && info.cluster_mode && !info.auth_token_enabled);
    assert_eq!(info.kind, KvKind::ServerlessCache);
    assert_eq!(info.identifier, "Sessions");
    assert_eq!(info.user_group_ids, vec!["ug-2".to_string()]);
    assert_eq!(info.reader_endpoint.as_deref(), Some("sessions-abc-ro.serverless.use1.cache.amazonaws.com"));
    assert!(info.iam_supported);
    assert!(resolved.members.is_empty());
}

fn node(address: &str) -> CacheNode {
    CacheNode::builder().endpoint(endpoint(address, 6379)).build()
}

#[test]
fn a_standalone_node_cluster_is_one_primary_node() {
    let cluster = CacheCluster::builder()
        .cache_cluster_id("cache-1")
        .arn("arn:aws:elasticache:ap-northeast-2:111111111111:cluster:cache-1")
        .engine("redis")
        .engine_version("6.2.6")
        .transit_encryption_enabled(false)
        .auth_token_enabled(true)
        .cache_nodes(node("cache-1.abc.0001.apn2.cache.amazonaws.com"))
        .build();
    let resolved = info_of_cache_cluster(&cluster).unwrap();
    assert_eq!(resolved.info.kind, KvKind::CacheCluster);
    assert_eq!(resolved.info.endpoint, "cache-1.abc.0001.apn2.cache.amazonaws.com");
    assert!(!resolved.info.tls && !resolved.info.iam_supported && resolved.info.auth_token_enabled);
    assert_eq!(resolved.members.len(), 1);
    assert_eq!(resolved.members[0].role, KvRole::Primary);
    assert_eq!(resolved.members[0].address, "cache-1.abc.0001.apn2.cache.amazonaws.com:6379");
}

#[test]
fn a_node_of_a_replication_group_points_to_the_group() {
    let cluster = CacheCluster::builder().cache_cluster_id("sessions-001").engine("valkey").replication_group_id("sessions").cache_nodes(node("n")).build();
    let error = info_of_cache_cluster(&cluster).unwrap_err();
    assert_eq!(error, AppError::other("이 노드는 복제 그룹 sessions에 속해요. 그 그룹을 열어 주세요"));
}

#[test]
fn users_report_their_authentication_kind() {
    let user = |kind: AuthenticationType| User::builder().user_id("u").user_name("name").status("active").access_string("on").authentication(Authentication::builder().r#type(kind).build()).build();
    assert_eq!(kv_user(&user(AuthenticationType::Iam)).auth, "iam");
    assert_eq!(kv_user(&user(AuthenticationType::Password)).auth, "password");
    assert_eq!(kv_user(&user(AuthenticationType::NoPassword)).auth, "no-password");
    assert_eq!(kv_user(&User::builder().build()).auth, "no-password");
}

#[test]
fn engines_are_matched_case_insensitively() {
    assert_eq!(engine_of(Some("Valkey")), Ok("valkey"));
    assert_eq!(engine_of(Some("REDIS")), Ok("redis"));
    assert!(engine_of(None).is_err());
}
