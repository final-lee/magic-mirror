//! 읽기만 한다는 보장의 관문. 백엔드가 서버에 보내는 명령은 모두 `send`를 거치고, `send`는 허용 목록에 있는 명령만 보낸다.
//! 허용 목록에 없는 명령(하위 명령 포함)은 서버로 나가기 전에 거절한다. 이 앱에서 fred의 `custom`을 부르는 곳은 여기 하나다
//! (검사 테스트 `kv::hygiene`가 지킨다). fred의 명령 모음(`i-*` 기능)은 빌드에서 꺼 두었으므로 `set`·`del` 같은 메서드는 아예 없다.
//! fred가 연결을 맺으면서 스스로 보내는 명령(`AUTH`·`PING`·`SELECT`·`CLIENT ID`·`INFO server`·`CLUSTER SLOTS`·`CLUSTER INFO`·`READONLY`)도 모두 읽기·연결 설정이다.
//!
//! 명령 이름은 하위 명령까지 한 글(`CLIENT LIST`)이고 인자는 그 뒤에 온다. 키가 있는 명령은 첫 인자(키)의 슬롯으로 노드를 고른다.

use std::time::Duration;

use fred::bytes::Bytes;
use fred::clients::Client;
use fred::error::Error as FredError;
use fred::interfaces::ClientLike;
use fred::types::config::{Options, Server};
use fred::types::{ClusterHash, CustomCommand, Value};

use crate::error::AppError;

/// 허용된 명령 하나. `keyed`: 첫 인자가 키라서 클러스터에서 그 슬롯의 노드로 보낸다
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Allowed {
    pub name: &'static str,
    pub keyed: bool,
}

const fn any(name: &'static str) -> Allowed {
    Allowed { name, keyed: false }
}

const fn key(name: &'static str) -> Allowed {
    Allowed { name, keyed: true }
}

/// 허용 목록. 명령은 하위 명령까지 이름이 같아야 한다. 이 밖의 것은 보낼 수 없다.
pub const ALLOWED: &[Allowed] = &[
    any("PING"),
    any("HELLO"),
    any("AUTH"),
    any("SELECT"),
    any("INFO"),
    any("DBSIZE"),
    any("SCAN"),
    key("TYPE"),
    key("PTTL"),
    key("MEMORY USAGE"),
    key("OBJECT ENCODING"),
    key("STRLEN"),
    key("GETRANGE"),
    key("HLEN"),
    key("HSCAN"),
    key("LLEN"),
    key("LRANGE"),
    key("SCARD"),
    key("SSCAN"),
    key("ZCARD"),
    key("ZRANGE"),
    key("XLEN"),
    key("XRANGE"),
    key("XINFO STREAM"),
    key("JSON.GET"),
    key("JSON.TYPE"),
    // 🐂 Bull 큐 화면: 큐 키(리스트·정렬 셋·해시)를 읽는다
    key("ZCOUNT"),
    key("ZREVRANGE"),
    key("HGET"),
    key("HMGET"),
    key("LINDEX"),
    key("EXISTS"),
    key("ZSCORE"),
    key("SISMEMBER"),
    key("LPOS"),
    any("SLOWLOG GET"),
    any("CLIENT LIST"),
    any("CLIENT ID"),
    any("CLUSTER SHARDS"),
    any("CLUSTER SLOTS"),
    any("CLUSTER INFO"),
    any("READONLY"),
    any("COMMANDLOG GET"),
];

pub fn allowed(name: &str) -> Option<Allowed> {
    ALLOWED.iter().find(|a| a.name == name).copied()
}

/// 보낼 명령: 이름(하위 명령 포함)과 인자
#[derive(Debug, Clone)]
pub struct Cmd {
    name: &'static str,
    args: Vec<Value>,
}

/// 명령을 만든다. 허용 목록에 없는 이름은 `send`가 거절한다
pub fn cmd(name: &'static str) -> Cmd {
    Cmd { name, args: Vec::new() }
}

impl Cmd {
    pub fn arg(mut self, value: impl Into<Arg>) -> Cmd {
        self.args.push(value.into().0);
        self
    }

    pub fn name(&self) -> &'static str {
        self.name
    }
}

/// 인자. 글, 숫자, 바이트(키 이름처럼 UTF-8이 아닐 수 있는 것)를 같은 길로 받는다
pub struct Arg(Value);

impl From<&str> for Arg {
    fn from(v: &str) -> Arg {
        Arg(Value::from(v))
    }
}

impl From<String> for Arg {
    fn from(v: String) -> Arg {
        Arg(Value::from(v))
    }
}

impl From<i64> for Arg {
    fn from(v: i64) -> Arg {
        Arg(Value::Integer(v))
    }
}

impl From<u64> for Arg {
    fn from(v: u64) -> Arg {
        Arg(Value::Integer(i64::try_from(v).unwrap_or(i64::MAX)))
    }
}

impl From<usize> for Arg {
    fn from(v: usize) -> Arg {
        Arg::from(v as u64)
    }
}

impl From<&[u8]> for Arg {
    fn from(v: &[u8]) -> Arg {
        Arg(Value::Bytes(Bytes::copy_from_slice(v)))
    }
}

impl From<&Vec<u8>> for Arg {
    fn from(v: &Vec<u8>) -> Arg {
        Arg::from(v.as_slice())
    }
}

/// 보낼 곳과 제한
#[derive(Debug, Clone)]
pub struct Route {
    /// 클러스터에서 이 노드로 보낸다. 비우면 키의 슬롯(키 없는 명령은 아무 노드)
    pub node: Option<Server>,
    pub timeout: Duration,
}

/// 허용 목록 검사. 명령이 허용되고 하위 명령이 목록과 같을 때만 통과한다
pub fn check(command: &Cmd) -> Result<Allowed, AppError> {
    allowed(command.name).ok_or_else(|| AppError::other(format!("이 앱은 읽기만 해요: {} 명령은 보내지 않아요", command.name)))
}

/// 서버에 명령을 보내는 유일한 길. 허용 목록 밖의 명령은 보내지 않고 오류를 돌려준다.
pub async fn send(client: &Client, route: &Route, command: Cmd) -> Result<Value, KvCallError> {
    let allowed = check(&command).map_err(KvCallError::Refused)?;
    let hash = if allowed.keyed { ClusterHash::FirstKey } else { ClusterHash::Random };
    let options = Options { timeout: Some(route.timeout), cluster_node: route.node.clone(), ..Default::default() };
    let custom = CustomCommand::new_static(command.name, hash, false);
    client.with_options(&options).custom::<Value, Value>(custom, command.args).await.map_err(KvCallError::Server)
}

/// 명령 하나가 실패한 이유
#[derive(Debug, Clone)]
pub enum KvCallError {
    /// 허용 목록 밖이라 보내지 않았다
    Refused(AppError),
    /// 서버 또는 연결 쪽 오류
    Server(FredError),
}

#[cfg(test)]
mod tests;
