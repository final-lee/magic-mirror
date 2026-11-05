//! Bull·BullMQ의 키 이름(순수 함수). 큐 하나의 키는 `<prefix>:<queue>:<종류>`이고 작업은 `<prefix>:<queue>:<jobId>`다(BullMQ `queue-keys.ts`).
//! 큐 이름에 `:`가 있어도 prefix 뒤부터 마지막 `:<종류>` 앞까지가 이름이다.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

use super::model::{KvBullFlavor, KvBullState};

/// SCAN MATCH 패턴에서 특별한 글자(`* ? [ ] \`)는 글자 그대로 찾도록 `\`를 붙인다
pub fn glob_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// 사용자가 넣은 prefix: 앞뒤 공백과 끝의 `:`를 뗀다. 남는 게 없으면 `None`.
/// BullMQ의 prefix가 정말 `:`로 끝나도(`a:` → 키 `a::q:meta`) `a`로 찾으면 큐 이름이 `:q`가 되어 키는 같게 만들어진다.
pub fn normalize_prefix(prefix: &str) -> Option<&str> {
    let prefix = prefix.trim().trim_end_matches(':');
    (!prefix.is_empty()).then_some(prefix)
}

/// 큐를 찾는 SCAN 패턴. 큐가 있다는 표시인 `<prefix>:<큐>:meta`(BullMQ)와 `<prefix>:<큐>:id`(BullMQ·옛 Bull)를 한 번의 훑기로 모은다.
/// glob에는 "또는"이 없어 마지막 마디가 `me…`·`id…`인 키를 모두 받고, 정확한 이름은 [`discovered_queue`]가 가린다.
pub fn discovery_pattern(prefix: &str) -> String {
    format!("{}:*:[im][de]*", glob_escape(prefix))
}

/// 찾기 패턴에 걸린 키에서 큐 이름(`…:meta`나 `…:id`가 아니면 `None`)
pub fn discovered_queue(prefix: &str, key: &str) -> Option<String> {
    queue_name_of(prefix, key, "meta").or_else(|| queue_name_of(prefix, key, "id"))
}

/// 큐 키: `<prefix>:<queue>:<종류>`
pub fn queue_key(prefix: &str, queue: &str, suffix: &str) -> String {
    format!("{prefix}:{queue}:{suffix}")
}

/// 작업 해시의 키: `<prefix>:<queue>:<jobId>`
pub fn job_key(prefix: &str, queue: &str, id: &str) -> String {
    format!("{prefix}:{queue}:{id}")
}

/// `<prefix>:<이름>:<suffix>` 꼴의 키에서 큐 이름. prefix와 suffix가 다르거나 이름이 비면 `None`
pub fn queue_name_of(prefix: &str, key: &str, suffix: &str) -> Option<String> {
    let rest = key.strip_prefix(prefix)?.strip_prefix(':')?;
    let name = rest.strip_suffix(suffix)?.strip_suffix(':')?;
    (!name.is_empty()).then(|| name.to_string())
}

/// 상태가 놓인 키의 종류. 옛 Bull의 우선순위 큐는 `priority`다
pub fn state_suffix(state: KvBullState, flavor: KvBullFlavor) -> &'static str {
    match state {
        KvBullState::Wait => "wait",
        KvBullState::Active => "active",
        KvBullState::Delayed => "delayed",
        KvBullState::Prioritized => match flavor {
            KvBullFlavor::Bullmq => "prioritized",
            KvBullFlavor::Bull => "priority",
        },
        KvBullState::WaitingChildren => "waiting-children",
        KvBullState::Paused => "paused",
        KvBullState::Completed => "completed",
        KvBullState::Failed => "failed",
    }
}

/// 워커 연결 이름의 기준: `<prefix>:<base64(큐 이름)>`. BullMQ 워커는 거기에 `:w:<워커 이름>`을 붙인다
pub fn worker_base(prefix: &str, queue: &str) -> String {
    format!("{prefix}:{}", STANDARD.encode(queue))
}

/// 연결 이름이 이 큐의 워커를 가리키면 워커 이름(이름이 없으면 빈 글).
/// - `<기준>:w:<이름>`은 워커다.
/// - `<기준>` 그대로는 큐 객체(생산자)도 쓰는 이름이라, 블로킹 명령을 기다리는 연결(`flags`에 `b`, 또는 마지막 명령이 `b…`)일 때만 워커로 본다.
pub fn worker_name(client_name: &str, flags: &str, last_cmd: &str, prefix: &str, queue: &str) -> Option<String> {
    let base = worker_base(prefix, queue);
    if let Some(name) = client_name.strip_prefix(&base).and_then(|rest| rest.strip_prefix(":w:")) {
        return Some(name.to_string());
    }
    let blocked = flags.contains('b') || last_cmd.starts_with('b');
    (client_name == base && blocked).then(String::new)
}

#[cfg(test)]
mod tests;
