use std::time::Duration;

use fred::types::Builder;

use super::*;

/// 설계 문서의 허용 목록(`읽기만 한다는 보장`)
const SPEC: [&str; 33] = [
    "PING",
    "HELLO",
    "AUTH",
    "SELECT",
    "INFO",
    "DBSIZE",
    "SCAN",
    "TYPE",
    "PTTL",
    "MEMORY USAGE",
    "OBJECT ENCODING",
    "STRLEN",
    "GETRANGE",
    "HLEN",
    "HSCAN",
    "LLEN",
    "LRANGE",
    "SCARD",
    "SSCAN",
    "ZCARD",
    "ZRANGE",
    "XLEN",
    "XRANGE",
    "XINFO STREAM",
    "JSON.GET",
    "JSON.TYPE",
    "SLOWLOG GET",
    "CLIENT LIST",
    "CLUSTER SHARDS",
    "CLUSTER SLOTS",
    "CLUSTER INFO",
    "READONLY",
    "COMMANDLOG GET",
];

/// 🐂 Bull 화면이 더한 읽기 명령
const BULL: [&str; 9] = ["ZCOUNT", "ZREVRANGE", "HGET", "HMGET", "LINDEX", "EXISTS", "ZSCORE", "SISMEMBER", "LPOS"];

#[test]
fn every_command_of_the_design_is_allowed() {
    for name in SPEC.iter().chain(BULL.iter()) {
        assert!(allowed(name).is_some(), "{name}");
    }
}

#[test]
fn the_list_holds_nothing_else_than_the_design_and_read_only_helpers() {
    // `CLIENT ID`는 앱 자신의 연결을 알아보는 읽기 명령이다
    let extra = ["CLIENT ID"];
    for entry in ALLOWED {
        assert!(SPEC.contains(&entry.name) || BULL.contains(&entry.name) || extra.contains(&entry.name), "{}", entry.name);
    }
}

#[test]
fn write_and_dangerous_commands_are_refused() {
    let refused = [
        "SET", "DEL", "UNLINK", "FLUSHALL", "FLUSHDB", "EXPIRE", "PEXPIRE", "PERSIST", "RENAME", "HSET", "HDEL", "LPUSH", "RPUSH", "LPOP", "SADD", "SREM", "ZADD", "ZREM", "XADD", "XDEL",
        "APPEND", "INCR", "DECR", "GETSET", "GETDEL", "SETEX", "EVAL", "EVALSHA", "SCRIPT", "FUNCTION", "CONFIG", "CONFIG SET", "CONFIG GET", "ACL", "DEBUG", "SHUTDOWN", "FAILOVER",
        "REPLICAOF", "SLAVEOF", "PUBLISH", "SUBSCRIBE", "MULTI", "EXEC", "WATCH", "MIGRATE", "RESTORE", "SORT", "COPY", "MOVE", "KEYS", "MONITOR", "SAVE", "BGSAVE", "BGREWRITEAOF",
        "CLIENT KILL", "CLIENT SETNAME", "CLIENT PAUSE", "CLIENT REPLY", "SLOWLOG RESET", "MEMORY PURGE", "OBJECT FREQ", "XINFO GROUPS", "XGROUP CREATE", "CLUSTER RESET", "CLUSTER FAILOVER",
        "CLUSTER NODES", "CLUSTER ADDSLOTS", "COMMANDLOG RESET", "JSON.SET", "JSON.DEL", "QUIT", "RESET", "get", "scan", "Scan", "SCAN ", "",
    ];
    for name in refused {
        assert!(allowed(name).is_none(), "{name}");
    }
}

#[test]
fn keyed_commands_route_by_their_key() {
    for name in ["TYPE", "PTTL", "GETRANGE", "ZRANGE", "XINFO STREAM", "JSON.GET", "ZCOUNT", "HMGET"] {
        assert!(allowed(name).unwrap().keyed, "{name}");
    }
    for name in ["SCAN", "INFO", "DBSIZE", "CLIENT LIST", "SLOWLOG GET", "CLUSTER SHARDS"] {
        assert!(!allowed(name).unwrap().keyed, "{name}");
    }
}

#[tokio::test]
async fn send_refuses_a_command_outside_the_list_before_touching_the_connection() {
    // 연결하지 않은 클라이언트: 허용 목록 검사가 먼저라서 연결이 없어도 거절 오류가 온다
    let client = Builder::default_centralized().build().unwrap();
    let route = Route { node: None, timeout: Duration::from_secs(1) };
    for name in ["SET", "FLUSHALL", "CONFIG SET", "CLIENT KILL"] {
        let error = send(&client, &route, cmd(name)).await.unwrap_err();
        match error {
            KvCallError::Refused(AppError::Other { message }) => assert!(message.contains(name), "{message}"),
            other => panic!("{name}: {other:?}"),
        }
    }
}

#[test]
fn arguments_keep_their_bytes() {
    let command = cmd("TYPE").arg(&vec![0xff_u8, 0x00]).arg("x").arg(5i64);
    assert_eq!(command.name(), "TYPE");
    assert_eq!(command.args.len(), 3);
    assert_eq!(command.args[0].as_bytes(), Some(&[0xff_u8, 0x00][..]));
}
