use super::*;

const PRIMARY: &str = "# Server\r\nredis_version:7.1.0\r\nvalkey_version:8.0.2\r\nrun_id:abc123\r\nuptime_in_seconds:86400\r\n\r\n# Clients\r\nconnected_clients:12\r\n\r\n# Memory\r\nused_memory:1048576\r\nused_memory_peak:2097152\r\nmaxmemory:4194304\r\nmem_fragmentation_ratio:1.25\r\n\r\n# Stats\r\ninstantaneous_ops_per_sec:340\r\nkeyspace_hits:900\r\nkeyspace_misses:100\r\nevicted_keys:3\r\nexpired_keys:77\r\n\r\n# Replication\r\nrole:master\r\nconnected_slaves:1\r\n\r\n# Keyspace\r\ndb1:keys=5,expires=0,avg_ttl=0\r\ndb0:keys=42,expires=7,avg_ttl=1234\r\n";

#[test]
fn a_primary_info_is_summarised() {
    let info = node_info("host:6379", PRIMARY);
    assert_eq!(info.node, "host:6379");
    // Valkey는 `redis_version`을 호환용으로 두고 `valkey_version`이 진짜 버전이다
    assert_eq!(info.version, "8.0.2");
    assert_eq!(info.role, "primary");
    assert_eq!(info.used_memory, 1_048_576);
    assert_eq!(info.used_memory_peak, 2_097_152);
    assert_eq!(info.max_memory, Some(4_194_304));
    assert_eq!(info.fragmentation, Some(1.25));
    assert_eq!((info.hits, info.misses), (900, 100));
    assert_eq!(info.ops_per_sec, 340);
    assert_eq!(info.connected_clients, 12);
    assert_eq!((info.evicted_keys, info.expired_keys), (3, 77));
    assert_eq!(info.uptime_seconds, 86_400);
    assert_eq!(info.replication_lag_seconds, None);
    // 번호 순서로
    assert_eq!(info.keyspace, vec![KvKeyspace { db: 0, keys: 42, expires: 7 }, KvKeyspace { db: 1, keys: 5, expires: 0 }]);
}

#[test]
fn a_replica_reports_its_lag_and_unlimited_memory_is_none() {
    let info = node_info("r:6379", "redis_version:7.0.7\r\nrole:slave\r\nmaxmemory:0\r\nmaster_last_io_seconds_ago:2\r\nmaster_link_status:up\r\n");
    assert_eq!(info.version, "7.0.7");
    assert_eq!(info.role, "replica");
    assert_eq!(info.max_memory, None);
    assert_eq!(info.replication_lag_seconds, Some(2));
    assert!(info.keyspace.is_empty());
    // 링크가 끊기면 -1이다: 알 수 없다
    let down = node_info("r:6379", "role:slave\r\nmaster_last_io_seconds_ago:-1\r\n");
    assert_eq!(down.replication_lag_seconds, None);
}

#[test]
fn missing_sections_and_junk_fall_back_to_zero() {
    let info = node_info("s:6379", "# Server\r\nredis_version:7.2\r\n\r\nnot a line\r\nused_memory:abc\r\n");
    assert_eq!(info.used_memory, 0);
    assert_eq!(info.fragmentation, None);
    assert_eq!(info.role, "");
    assert!(info.keyspace.is_empty());
}

#[test]
fn run_id_identifies_the_server() {
    assert_eq!(run_id(PRIMARY).as_deref(), Some("abc123"));
    assert_eq!(run_id("# Server\r\n"), None);
}

#[test]
fn keyspace_ignores_lines_that_are_not_databases() {
    let fields = parse("dbx:keys=1\r\ndb2:keys=9,expires=3\r\nused_memory:1");
    assert_eq!(keyspace(&fields), vec![KvKeyspace { db: 2, keys: 9, expires: 3 }]);
}
