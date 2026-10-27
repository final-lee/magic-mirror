# SSO 자동 로그인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a command fails because an SSO profile's session expired, start `aws sso login` automatically: one login per SSO session, cancellable, with a banner, and reload the data afterwards.

**Architecture:**
- Backend: `~/.aws/config` parsing tells which profile is SSO (`ssoLogin`, `ssoKey`). A small single-flight runner (`aws/sso.rs`) runs one `aws sso login` per SSO session and supports cancel. `sso_login` clears the cached SDK configs of every profile that shares the session.
- Frontend: all Tauri calls go through `src/api/invoke.ts`, which reports `ssoExpired` failures with their `profile`. One manager hook (`useSsoLogin`) in App decides when to log in, exposes state through context, and invalidates the profile's queries on success. `SsoBanner` shows progress and failures. `ErrorState`'s button joins the manager.

**Tech Stack:** Tauri 2, Rust (tokio process/sync), React 18 + TS, TanStack Query, Vitest + Testing Library.

## Global Constraints
- UI copy is Korean 해요체. Code identifiers and commit messages are English.
- Contract changes are additive only:
  - `ProfileInfo { name, region, ssoLogin: string | null, ssoKey: string | null }`. In TS the new fields are optional (`ssoLogin?: string | null`), and missing is treated as null.
  - `sso_login(profile) -> ()` keeps its name and argument.
  - New: `sso_login_cancel(profile) -> ()`.
- Exact texts:
  - "로그인을 취소했어요"
  - "aws CLI를 찾을 수 없어요"
  - "aws sso login이 실패했어요 ({status})"
  - banner running: `${profile}: SSO 로그인 중이에요. 브라우저에서 승인해 주세요` [취소]
  - banner failed: `${profile}: SSO 로그인에 실패했어요: ${message}` [다시 로그인] [닫기]
  - ErrorState busy: "브라우저에서 로그인을 완료하세요…"
- Keys:
  - `session:<sso_session>`
  - `url:<sso_start_url>`
  - fallback `profile:<name>`
- Follow `source_profile` up to 5 levels; stop on a cycle.
- Rust: `cargo test` and the literal `cargo clippy --all-targets -- -D warnings` are clean. Frontend: `npx vitest run`, `npx tsc --noEmit`, `npm run build` are clean.
- Commits end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage files by explicit path, because Tasks S1 and S2 run concurrently in one tree. S1 touches only `src-tauri/`; S2 touches only `src/`.
- Branch: `feat/sso-auto-login`. Spec: `docs/superpowers/specs/2026-10-27-sso-auto-login-design.md`.

## Execution order
S1 (backend) and S2 (frontend) run in parallel; the contract above is fixed. Then S3 (docs, final review, merge).

---

### Task S1: Backend — SSO profile parsing, single-flight login, cancel

**Files:**
- Modify: `src-tauri/src/aws/context.rs` (ProfileInfo fields, parser, `forget_profiles`, tests)
- Create: `src-tauri/src/aws/sso.rs` (single-flight runner + `aws sso login` process + tests)
- Modify: `src-tauri/src/aws/mod.rs` (`pub mod sso;`)
- Modify: `src-tauri/src/commands.rs`:
  - `AppState.sso`
  - `sso_login` and new `sso_login_cancel`
  - the pure helpers `login_plan` and `profiles_sharing`, with tests
  - remove `AWS_CLI_CANDIDATES` and the now-unused imports
- Modify: `src-tauri/src/lib.rs` (`sso: Default::default()` in `AppState`, register `commands::sso_login_cancel`)

**Interfaces:**
- Produces:
  - `ProfileInfo { name: String, region: Option<String>, sso_login: Option<String>, sso_key: Option<String> }`, serialized camelCase
  - `AwsContext::forget_profiles(&self, names: &[String])`, which replaces `forget_profile`
  - `sso::SsoLogins::{login, cancel}`
  - `sso::run_aws_sso_login(profile: String, cancel: Arc<Notify>) -> Result<(), AppError>`
  - `sso::CANCELLED`
  - commands `sso_login(profile)` and `sso_login_cancel(profile)`

- [ ] **Step 1: Write the failing parser tests** in `context.rs` `mod tests`. Update the existing `parses_profiles_and_regions` expectations to include the new fields, then add:

```rust
    fn info(name: &str, region: Option<&str>, sso: Option<(&str, &str)>) -> ProfileInfo {
        ProfileInfo {
            name: name.into(),
            region: region.map(Into::into),
            sso_login: sso.map(|(login, _)| login.to_string()),
            sso_key: sso.map(|(_, key)| key.to_string()),
        }
    }

    #[test]
    fn parses_profiles_and_regions() {
        assert_eq!(
            parse_profiles(SAMPLE),
            vec![
                info("default", Some("us-west-2"), None),
                info("prod-sso", Some("ap-northeast-2"), Some(("prod-sso", "session:my-sso"))),
                info("localstack", None, None),
            ]
        );
    }

    #[test]
    fn legacy_start_url_profiles_are_sso() {
        let text = "[profile old]\nsso_start_url = https://corp.awsapps.com/start\nsso_region = us-east-1\n";
        assert_eq!(parse_profiles(text), vec![info("old", None, Some(("old", "url:https://corp.awsapps.com/start")))]);
    }

    #[test]
    fn role_profiles_log_in_through_their_sso_source() {
        let text = "\
[profile base]
sso_session = corp
[profile admin]
role_arn = arn:aws:iam::111111111111:role/Admin
source_profile = base
[profile deeper]
role_arn = arn:aws:iam::222222222222:role/Ops
source_profile = admin
";
        let parsed = parse_profiles(text);
        assert_eq!(parsed[1], info("admin", None, Some(("base", "session:corp"))));
        assert_eq!(parsed[2], info("deeper", None, Some(("base", "session:corp"))));
    }

    #[test]
    fn source_profile_cycles_and_plain_keys_are_not_sso() {
        let text = "\
[profile a]
source_profile = b
[profile b]
source_profile = a
[profile keys]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
";
        assert!(parse_profiles(text).iter().all(|p| p.sso_login.is_none() && p.sso_key.is_none()));
    }

    #[test]
    fn source_chains_longer_than_five_steps_are_not_followed() {
        let mut text = String::from("[profile p0]\nsso_session = corp\n");
        for i in 1..=6 {
            text.push_str(&format!("[profile p{i}]\nsource_profile = p{}\n", i - 1));
        }
        let parsed = parse_profiles(&text);
        assert_eq!(parsed[5].sso_key.as_deref(), Some("session:corp")); // p5 → p0: 5 steps
        assert_eq!(parsed[6].sso_key, None); // p6 → p0: 6 steps
    }

    #[test]
    fn profile_info_serializes_camel_case() {
        let v = serde_json::to_value(info("p", None, Some(("p", "session:s")))).unwrap();
        assert_eq!(v, serde_json::json!({ "name": "p", "region": null, "ssoLogin": "p", "ssoKey": "session:s" }));
    }

    #[tokio::test]
    async fn forget_profiles_drops_only_the_named_profiles() {
        let ctx = AwsContext::default();
        {
            let mut cache = ctx.cache.lock().await;
            for p in ["a", "b", "c"] {
                cache.insert((p.to_string(), "us-east-1".to_string()), SdkConfig::builder().build());
            }
        }
        ctx.forget_profiles(&["a".to_string(), "c".to_string()]).await;
        let left: Vec<String> = ctx.cache.lock().await.keys().map(|(p, _)| p.clone()).collect();
        assert_eq!(left, vec!["b".to_string()]);
    }
```

- [ ] **Step 2: Run them and confirm they fail.** Run `cd src-tauri && cargo test aws::context`. Expected: compile errors, because the fields and `forget_profiles` don't exist yet.

- [ ] **Step 3: Implement** in `context.rs`. Replace `ProfileInfo`, `parse_profiles` and `forget_profile`:

```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub name: String,
    pub region: Option<String>,
    /// `aws sso login`에 넘길 프로필: 자기 자신이거나 `source_profile` 체인에서 처음 나오는 SSO 프로필. SSO가 아니면 None
    pub sso_login: Option<String>,
    /// 같은 SSO 세션을 쓰는 프로필끼리 같은 값: `session:<이름>` 또는 `url:<start url>`
    pub sso_key: Option<String>,
}

/// `source_profile`을 따라가는 최대 단계
const MAX_SOURCE_STEPS: usize = 5;

#[derive(Default)]
struct Section {
    region: Option<String>,
    sso_session: Option<String>,
    sso_start_url: Option<String>,
    source_profile: Option<String>,
}

/// `~/.aws/config` 형식에서 `[default]`, `[profile X]` 섹션만 프로필로 읽는다.
pub fn parse_profiles(text: &str) -> Vec<ProfileInfo> {
    let mut order: Vec<String> = Vec::new();
    let mut sections: HashMap<String, Section> = HashMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            let header = line[1..line.len() - 1].trim();
            let name = if header == "default" { Some("default") } else { header.strip_prefix("profile ").map(str::trim) };
            current = name.map(str::to_string);
            if let Some(name) = &current {
                if !sections.contains_key(name) {
                    order.push(name.clone());
                    sections.insert(name.clone(), Section::default());
                }
            }
        } else if let (Some(name), Some((k, v))) = (&current, line.split_once('=')) {
            let Some(section) = sections.get_mut(name) else { continue };
            let v = v.trim().to_string();
            match k.trim() {
                "region" => section.region = Some(v),
                "sso_session" => section.sso_session = Some(v),
                "sso_start_url" => section.sso_start_url = Some(v),
                "source_profile" => section.source_profile = Some(v),
                _ => {}
            }
        }
    }
    order
        .iter()
        .map(|name| {
            let (sso_login, sso_key) = sso_target(&sections, name).unzip();
            ProfileInfo { name: name.clone(), region: sections[name].region.clone(), sso_login, sso_key }
        })
        .collect()
}

/// 이 프로필이 기대는 SSO 프로필과 그 세션 키. 자신이 SSO가 아니면 `source_profile`을 따라간다(최대 5단계, 순환이면 None).
fn sso_target(sections: &HashMap<String, Section>, name: &str) -> Option<(String, String)> {
    let mut current = name;
    let mut seen: Vec<&str> = Vec::new();
    for _ in 0..=MAX_SOURCE_STEPS {
        if seen.contains(&current) {
            return None;
        }
        seen.push(current);
        let section = sections.get(current)?;
        if let Some(session) = &section.sso_session {
            return Some((current.to_string(), format!("session:{session}")));
        }
        if let Some(url) = &section.sso_start_url {
            return Some((current.to_string(), format!("url:{url}")));
        }
        current = section.source_profile.as_deref()?;
    }
    None
}
```

and in `impl AwsContext`:

```rust
    /// SSO 재로그인 뒤 새 토큰을 읽도록 그 프로필들의 캐시를 비운다(같은 SSO 세션을 쓰는 프로필 모두).
    pub async fn forget_profiles(&self, names: &[String]) {
        self.cache.lock().await.retain(|(p, _), _| !names.iter().any(|n| n == p));
    }
```

- [ ] **Step 4: Write the failing runner tests.** Create `src-tauri/src/aws/sso.rs` with the code from Step 5, and its tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    async fn wait_running(logins: &SsoLogins, key: &str) {
        while !logins.is_running(key).await {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn a_second_login_for_the_same_key_joins_the_running_one() {
        let logins = Arc::new(SsoLogins::default());
        let runs = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Notify::new());
        let first = {
            let (logins, runs, gate) = (logins.clone(), runs.clone(), gate.clone());
            tokio::spawn(async move {
                logins
                    .login("session:a", move |_| async move {
                        runs.fetch_add(1, Ordering::SeqCst);
                        gate.notified().await;
                        Ok(())
                    })
                    .await
            })
        };
        wait_running(&logins, "session:a").await;
        let second = {
            let (logins, runs) = (logins.clone(), runs.clone());
            tokio::spawn(async move {
                logins
                    .login("session:a", move |_| async move {
                        runs.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        gate.notify_one();
        assert_eq!(first.await.unwrap(), Ok(()));
        assert_eq!(second.await.unwrap(), Ok(()));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_failure_reaches_every_waiter() {
        let logins = Arc::new(SsoLogins::default());
        let gate = Arc::new(Notify::new());
        let first = {
            let (logins, gate) = (logins.clone(), gate.clone());
            tokio::spawn(async move {
                logins
                    .login("k", move |_| async move {
                        gate.notified().await;
                        Err(AppError::other("boom"))
                    })
                    .await
            })
        };
        wait_running(&logins, "k").await;
        let second = {
            let logins = logins.clone();
            tokio::spawn(async move { logins.login("k", |_| async { Ok(()) }).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        gate.notify_one();
        assert_eq!(first.await.unwrap(), Err(AppError::other("boom")));
        assert_eq!(second.await.unwrap(), Err(AppError::other("boom")));
    }

    #[tokio::test]
    async fn different_keys_and_finished_logins_run_again() {
        let logins = SsoLogins::default();
        let runs = Arc::new(AtomicUsize::new(0));
        for key in ["a", "b", "a"] {
            let runs = runs.clone();
            logins
                .login(key, move |_| async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
                .unwrap();
        }
        assert_eq!(runs.load(Ordering::SeqCst), 3);
        assert!(!logins.is_running("a").await);
    }

    #[tokio::test]
    async fn cancel_ends_the_running_login() {
        let logins = Arc::new(SsoLogins::default());
        let task = {
            let logins = logins.clone();
            tokio::spawn(async move {
                logins
                    .login("k", |cancel| async move {
                        cancel.notified().await;
                        Err(AppError::other(CANCELLED))
                    })
                    .await
            })
        };
        wait_running(&logins, "k").await;
        logins.cancel("k").await;
        assert_eq!(task.await.unwrap(), Err(AppError::other(CANCELLED)));
    }

    #[tokio::test]
    async fn cancel_without_a_running_login_does_not_affect_the_next_one() {
        let logins = SsoLogins::default();
        logins.cancel("k").await;
        let result = logins
            .login("k", |cancel| async move {
                tokio::select! {
                    _ = cancel.notified() => Err(AppError::other(CANCELLED)),
                    _ = tokio::time::sleep(Duration::from_millis(20)) => Ok(()),
                }
            })
            .await;
        assert_eq!(result, Ok(()));
    }
}
```

- [ ] **Step 5: Implement `sso.rs`** (above the tests), and add `pub mod sso;` to `aws/mod.rs`:

```rust
//! SSO 로그인 실행. 같은 SSO 세션의 로그인은 하나만 돌고, 나중에 온 요청은 진행 중인 결과를 함께 기다린다.
use std::collections::HashMap;
use std::future::Future;
use std::io::ErrorKind;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::process::Command;
use tokio::sync::{watch, Mutex, Notify};

use crate::error::AppError;

/// Finder에서 실행하면 PATH가 짧으므로 Homebrew 경로도 시도한다.
const AWS_CLI_CANDIDATES: [&str; 3] = ["aws", "/opt/homebrew/bin/aws", "/usr/local/bin/aws"];

pub const CANCELLED: &str = "로그인을 취소했어요";

type Outcome = Option<Result<(), AppError>>;

struct Flight {
    id: u64,
    done: watch::Receiver<Outcome>,
    cancel: Arc<Notify>,
}

#[derive(Default)]
pub struct SsoLogins {
    flights: Arc<Mutex<HashMap<String, Flight>>>,
    next_id: AtomicU64,
}

impl SsoLogins {
    /// `key`의 로그인이 진행 중이면 그 결과를 기다리고, 아니면 `run`으로 새로 시작한다. `run`은 취소 신호를 받는다.
    /// 실행은 따로 띄운 작업에서 돌아서, 기다리던 호출이 사라져도 끝까지 간다.
    pub async fn login<F, Fut>(&self, key: &str, run: F) -> Result<(), AppError>
    where
        F: FnOnce(Arc<Notify>) -> Fut,
        Fut: Future<Output = Result<(), AppError>> + Send + 'static,
    {
        let mut done = {
            let mut flights = self.flights.lock().await;
            if let Some(flight) = flights.get(key) {
                flight.done.clone()
            } else {
                let id = self.next_id.fetch_add(1, Ordering::Relaxed);
                let (tx, rx) = watch::channel(None);
                let cancel = Arc::new(Notify::new());
                flights.insert(key.to_string(), Flight { id, done: rx.clone(), cancel: cancel.clone() });
                let fut = run(cancel);
                let all = self.flights.clone();
                let key = key.to_string();
                tokio::spawn(async move {
                    let result = fut.await;
                    // 결과를 보내기 전에 목록에서 뺀다: 결과를 받은 쪽이 곧바로 다시 로그인하면 새 실행이 시작된다
                    {
                        let mut flights = all.lock().await;
                        if flights.get(&key).is_some_and(|f| f.id == id) {
                            flights.remove(&key);
                        }
                    }
                    let _ = tx.send(Some(result));
                });
                rx
            }
        };
        loop {
            let current = done.borrow_and_update().clone();
            if let Some(result) = current {
                return result;
            }
            if done.changed().await.is_err() {
                return Err(AppError::other("로그인이 중단됐어요"));
            }
        }
    }

    /// 진행 중인 `key`의 로그인을 취소한다. 진행 중이 아니면 아무것도 하지 않는다.
    pub async fn cancel(&self, key: &str) {
        if let Some(flight) = self.flights.lock().await.get(key) {
            flight.cancel.notify_one();
        }
    }

    #[cfg(test)]
    async fn is_running(&self, key: &str) -> bool {
        self.flights.lock().await.contains_key(key)
    }
}

/// `aws sso login --profile <profile>`을 실행한다. 브라우저는 aws CLI가 연다. 취소 신호가 오면 프로세스를 끝낸다.
pub async fn run_aws_sso_login(profile: String, cancel: Arc<Notify>) -> Result<(), AppError> {
    for bin in AWS_CLI_CANDIDATES {
        let mut child = match Command::new(bin)
            .args(["sso", "login", "--profile", &profile])
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return Err(AppError::other(e.to_string())),
        };
        return tokio::select! {
            status = child.wait() => match status {
                Ok(s) if s.success() => Ok(()),
                Ok(s) => Err(AppError::other(format!("aws sso login이 실패했어요 ({s})"))),
                Err(e) => Err(AppError::other(e.to_string())),
            },
            _ = cancel.notified() => {
                let _ = child.kill().await;
                Err(AppError::other(CANCELLED))
            }
        };
    }
    Err(AppError::other("aws CLI를 찾을 수 없어요"))
}
```

- [ ] **Step 6: Commands.** In `commands.rs`, add `use crate::aws::sso::{self, SsoLogins};` and `pub sso: SsoLogins` to `AppState`, delete `AWS_CLI_CANDIDATES` and the old `sso_login` body, and drop the now-unused `ErrorKind`/`Command` imports. Add:

```rust
/// 이 프로필로 로그인할 때의 키와 `aws sso login`에 넘길 프로필. SSO 설정을 못 찾으면 그 프로필 자신이다(프론트엔드와 같은 규칙).
fn login_plan(profiles: &[ProfileInfo], profile: &str) -> (String, String) {
    match profiles.iter().find(|p| p.name == profile) {
        Some(ProfileInfo { sso_key: Some(key), sso_login: Some(target), .. }) => (key.clone(), target.clone()),
        _ => (format!("profile:{profile}"), profile.to_string()),
    }
}

/// 같은 로그인 키를 쓰는 프로필들: 로그인 뒤 새 토큰을 읽도록 캐시를 비울 대상. 요청한 프로필은 늘 들어 있다.
fn profiles_sharing(profiles: &[ProfileInfo], profile: &str, key: &str) -> Vec<String> {
    let mut names: Vec<String> = profiles.iter().filter(|p| p.sso_key.as_deref() == Some(key)).map(|p| p.name.clone()).collect();
    if !names.iter().any(|n| n == profile) {
        names.push(profile.to_string());
    }
    names
}

#[tauri::command]
pub async fn sso_login(state: State<'_, AppState>, profile: String) -> Result<(), AppError> {
    let profiles = context::list_profiles();
    let (key, target) = login_plan(&profiles, &profile);
    state.sso.login(&key, move |cancel| sso::run_aws_sso_login(target, cancel)).await?;
    state.ctx.forget_profiles(&profiles_sharing(&profiles, &profile, &key)).await;
    Ok(())
}

#[tauri::command]
pub async fn sso_login_cancel(state: State<'_, AppState>, profile: String) -> Result<(), AppError> {
    let (key, _) = login_plan(&context::list_profiles(), &profile);
    state.sso.cancel(&key).await;
    Ok(())
}
```

Tests (new `#[cfg(test)] mod tests` in `commands.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str, sso: Option<(&str, &str)>) -> ProfileInfo {
        ProfileInfo { name: name.into(), region: None, sso_login: sso.map(|s| s.0.into()), sso_key: sso.map(|s| s.1.into()) }
    }

    #[test]
    fn login_plan_uses_the_sso_source_and_falls_back_to_the_profile() {
        let profiles = vec![p("base", Some(("base", "session:corp"))), p("admin", Some(("base", "session:corp"))), p("keys", None)];
        assert_eq!(login_plan(&profiles, "admin"), ("session:corp".into(), "base".into()));
        assert_eq!(login_plan(&profiles, "keys"), ("profile:keys".into(), "keys".into()));
        assert_eq!(login_plan(&profiles, "missing"), ("profile:missing".into(), "missing".into()));
    }

    #[test]
    fn profiles_sharing_lists_every_profile_of_the_session() {
        let profiles = vec![p("base", Some(("base", "session:corp"))), p("admin", Some(("base", "session:corp"))), p("other", Some(("other", "session:x")))];
        assert_eq!(profiles_sharing(&profiles, "admin", "session:corp"), vec!["base".to_string(), "admin".to_string()]);
        assert_eq!(profiles_sharing(&profiles, "keys", "profile:keys"), vec!["keys".to_string()]);
    }
}
```

In `lib.rs`, add `sso: Default::default(),` to the `AppState { … }` literal and `commands::sso_login_cancel,` after `commands::sso_login,`.

- [ ] **Step 7: Verify.** Run `cd src-tauri && cargo test` and the literal `cargo clippy --all-targets -- -D warnings`. Expected: all pass, no warnings. Mutation-check: remove the `flights.get(key)` join branch (always start a new run) and confirm `a_second_login_for_the_same_key_joins_the_running_one` fails, then restore it.

- [ ] **Step 8: Commit** the files above. Message: `feat(sso): parse SSO profiles, one login per SSO session, cancel`.

---

### Task S2: Frontend — invoke wrapper, login manager, banner

**Files:**
- Create: `src/api/invoke.ts`, `src/api/invoke.test.ts`
- Modify: `src/api/client.ts`, `src/explorer/api.ts`, `src/iam/api.ts`, `src/vpcmap/api.ts`. Import `invoke` from the wrapper instead of `@tauri-apps/api/core`. `client.ts` also gets `ssoLoginCancel`.
- Modify: `src/api/types.ts` (`ProfileInfo` optional fields)
- Create: `src/lib/useSsoLogin.ts`, `src/lib/useSsoLogin.test.tsx`
- Create: `src/components/SsoBanner.tsx`, `src/components/SsoBanner.test.tsx`
- Modify: `src/components/ErrorState.tsx`, `src/components/ErrorState.test.tsx`
- Modify: `src/App.tsx`. Call the hook, wrap the app in the provider, render `<SsoBanner>` right after `<UpdateBanner>`, and call `sso.rearm(name)` in `changeProfile`.
- Modify: `src/App.test.tsx`. Add `ssoLoginCancel: vi.fn()` to the `./api/client` mock and add one wiring test.

**Interfaces:**
- Consumes: the commands `sso_login(profile)` and `sso_login_cancel(profile)`, and `ProfileInfo.ssoLogin` / `ssoKey`. These come from S1 and the contract is fixed.
- Produces:
  - `invoke<T>(cmd, args?)`
  - `onSsoExpired(listener) => () => void`
  - `reportSsoExpired(profile)`
  - `loginPlan(profiles, profile)`
  - `useSsoLogin(profiles)` returning `{ entries, statusFor, start, cancel, dismiss, rearm }`
  - `SsoLoginContext`, `useSsoLoginContext()`
  - `SsoBanner`

- [ ] **Step 1: Failing wrapper tests.** In `src/api/invoke.test.ts`:

```ts
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { invoke, onSsoExpired } from "./invoke";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const raw = vi.mocked(tauriInvoke);

test("an ssoExpired failure with a profile is reported and still rethrown", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("list_resources", { profile: "prod", region: "x" })).rejects.toEqual({ kind: "ssoExpired" });
  expect(seen).toEqual(["prod"]);
  off();
});

test("other failures, calls without a profile and successes are not reported", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "accessDenied", action: "a" });
  await expect(invoke("get_account", { profile: "prod" })).rejects.toBeTruthy();
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("list_profiles")).rejects.toBeTruthy();
  raw.mockResolvedValueOnce("123");
  await expect(invoke("get_account", { profile: "prod" })).resolves.toBe("123");
  expect(seen).toEqual([]);
  off();
});

test("unsubscribed listeners are not called", async () => {
  const seen: string[] = [];
  onSsoExpired((p) => seen.push(p))();
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("get_account", { profile: "prod" })).rejects.toBeTruthy();
  expect(seen).toEqual([]);
});
```

- [ ] **Step 2: Implement `src/api/invoke.ts`:**

```ts
import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { isAppError } from "./errors";

type Listener = (profile: string) => void;
const listeners = new Set<Listener>();

/** SSO 세션 만료로 실패한 명령의 프로필을 받는다. 로그인 관리자가 구독한다. */
export function onSsoExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 이 프로필의 SSO 세션이 만료됐다고 알린다. */
export function reportSsoExpired(profile: string) {
  for (const listener of [...listeners]) listener(profile);
}

/** 모든 Tauri 명령이 지나는 길. 오류는 그대로 다시 던지고, SSO 만료면 그 명령의 profile을 알린다. */
export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    const profile = (args as Record<string, unknown> | undefined)?.profile;
    if (isAppError(e) && e.kind === "ssoExpired" && typeof profile === "string") reportSsoExpired(profile);
    throw e;
  }
}
```

Then switch the four API modules: `import { invoke } from "./invoke";` in `src/api/client.ts`, and `import { invoke } from "../api/invoke";` in the other three. Add to `api` in `client.ts`: `ssoLoginCancel: (profile: string) => invoke<void>("sso_login_cancel", { profile }),`. In `types.ts`:

```ts
export interface ProfileInfo {
  name: string;
  region: string | null;
  /** aws sso login에 넘길 프로필(자기 자신 또는 source_profile 체인의 SSO 프로필). SSO가 아니면 null */
  ssoLogin?: string | null;
  /** 같은 SSO 세션을 쓰는 프로필끼리 같은 값. SSO가 아니면 null */
  ssoKey?: string | null;
}
```

Run `npx vitest run src/api/invoke.test.ts`. Expected: PASS.

- [ ] **Step 3: Failing manager tests.** In `src/lib/useSsoLogin.test.tsx`:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "../api/client";
import { reportSsoExpired } from "../api/invoke";
import type { ProfileInfo } from "../api/types";
import { useSsoLogin } from "./useSsoLogin";

vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn(), ssoLoginCancel: vi.fn() } }));
const m = vi.mocked(api);

const PROFILES: ProfileInfo[] = [
  { name: "base", region: null, ssoLogin: "base", ssoKey: "session:corp" },
  { name: "admin", region: null, ssoLogin: "base", ssoKey: "session:corp" },
  { name: "keys", region: null, ssoLogin: null, ssoKey: null },
];

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useSsoLogin(PROFILES), { wrapper });
  return { hook, invalidate };
}

beforeEach(() => vi.clearAllMocks());

test("an expiry report starts one login per SSO session", async () => {
  const d = deferred();
  m.ssoLogin.mockReturnValue(d.promise);
  const { hook } = setup();
  act(() => {
    reportSsoExpired("admin");
    reportSsoExpired("base");
    reportSsoExpired("admin");
  });
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);
  expect(m.ssoLogin).toHaveBeenCalledWith("base");
  expect(hook.result.current.entries).toEqual([{ key: "session:corp", profile: "admin", target: "base", status: { kind: "running" } }]);
  await act(async () => d.resolve());
});

test("success clears the entry and reloads every profile of the session", async () => {
  m.ssoLogin.mockResolvedValue(undefined);
  const { hook, invalidate } = setup();
  act(() => reportSsoExpired("admin"));
  await waitFor(() => expect(hook.result.current.entries).toEqual([]));
  const predicate = (invalidate.mock.calls[0][0] as { predicate: (q: { queryKey: unknown[] }) => boolean }).predicate;
  expect(predicate({ queryKey: ["resources", "base", "x"] })).toBe(true);
  expect(predicate({ queryKey: ["account", "admin"] })).toBe(true);
  expect(predicate({ queryKey: ["account", "keys"] })).toBe(false);
  expect(predicate({ queryKey: ["settings"] })).toBe(false);
});

test("a failure is not retried automatically, but re-selecting the profile or a manual start retries", async () => {
  m.ssoLogin.mockRejectedValueOnce({ kind: "other", message: "aws CLI를 찾을 수 없어요" });
  const { hook } = setup();
  act(() => reportSsoExpired("base"));
  await waitFor(() => expect(hook.result.current.statusFor("base")).toEqual({ kind: "failed", message: "aws CLI를 찾을 수 없어요" }));
  act(() => reportSsoExpired("base"));
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);

  m.ssoLogin.mockResolvedValue(undefined);
  act(() => hook.result.current.rearm("admin"));
  expect(hook.result.current.statusFor("base")).toBeNull();
  act(() => reportSsoExpired("base"));
  expect(m.ssoLogin).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(hook.result.current.entries).toEqual([]));

  m.ssoLogin.mockRejectedValueOnce({ kind: "other", message: "x" });
  act(() => reportSsoExpired("base"));
  await waitFor(() => expect(hook.result.current.statusFor("base")?.kind).toBe("failed"));
  let ok = true;
  await act(async () => {
    ok = await hook.result.current.start("base", { manual: true });
  });
  expect(m.ssoLogin).toHaveBeenCalledTimes(4);
  expect(ok).toBe(true);
});

test("cancel stops the login and keeps it from reopening", async () => {
  const d = deferred();
  m.ssoLogin.mockReturnValue(d.promise);
  m.ssoLoginCancel.mockResolvedValue(undefined);
  const { hook } = setup();
  act(() => reportSsoExpired("admin"));
  act(() => hook.result.current.cancel("session:corp"));
  expect(m.ssoLoginCancel).toHaveBeenCalledWith("base");
  await act(async () => d.reject({ kind: "other", message: "로그인을 취소했어요" }));
  expect(hook.result.current.statusFor("admin")).toEqual({ kind: "cancelled" });
  act(() => reportSsoExpired("admin"));
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);
});

test("dismissing a failure keeps it closed; non-SSO profiles never log in automatically", async () => {
  m.ssoLogin.mockRejectedValueOnce({ kind: "other", message: "x" });
  const { hook } = setup();
  act(() => reportSsoExpired("keys"));
  expect(m.ssoLogin).not.toHaveBeenCalled();
  act(() => reportSsoExpired("base"));
  await waitFor(() => expect(hook.result.current.statusFor("base")?.kind).toBe("failed"));
  act(() => hook.result.current.dismiss("session:corp"));
  expect(hook.result.current.statusFor("base")).toEqual({ kind: "cancelled" });
});

test("a manual start joins the running login", async () => {
  const d = deferred();
  m.ssoLogin.mockReturnValue(d.promise);
  const { hook } = setup();
  act(() => reportSsoExpired("admin"));
  let joined: Promise<boolean> = Promise.resolve(false);
  act(() => {
    joined = hook.result.current.start("base", { manual: true });
  });
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);
  await act(async () => d.resolve());
  await expect(joined).resolves.toBe(true);
});
```

- [ ] **Step 4: Implement `src/lib/useSsoLogin.ts`:**

```ts
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { errorMessage } from "../api/errors";
import { onSsoExpired } from "../api/invoke";
import type { ProfileInfo } from "../api/types";

/** 로그인 하나의 상태. 성공하면 목록에서 빠진다(= 대기). */
export type SsoStatus = { kind: "running" } | { kind: "failed"; message: string } | { kind: "cancelled" };

export interface SsoEntry {
  key: string;
  /** 로그인을 연 프로필(배너에 보여줄 이름) */
  profile: string;
  /** aws sso login에 넘긴 프로필 */
  target: string;
  status: SsoStatus;
}

/** 프로필의 로그인 키와 대상. SSO 설정이 없으면 그 프로필 자신이고 자동 로그인은 하지 않는다(백엔드와 같은 규칙). */
export function loginPlan(profiles: ProfileInfo[] | undefined, profile: string) {
  const info = profiles?.find((p) => p.name === profile);
  if (info?.ssoKey && info.ssoLogin) return { key: info.ssoKey, target: info.ssoLogin, auto: true };
  return { key: `profile:${profile}`, target: profile, auto: false };
}

/**
 * SSO 로그인 관리자. 명령이 SSO 만료로 실패하면 그 프로필의 세션에 로그인을 한 번 연다.
 * 실패하거나 취소한 세션은 사용자가 그 프로필을 다시 고르거나 직접 누를 때까지 자동으로 다시 열지 않는다.
 */
export function useSsoLogin(profiles: ProfileInfo[] | undefined) {
  const qc = useQueryClient();
  const [entries, setEntries] = useState<Record<string, SsoEntry>>({});
  // 알림 처리(동기)에서 최신 값을 보려고 ref에도 둔다
  const entriesRef = useRef(entries);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const flights = useRef(new Map<string, Promise<boolean>>());
  const cancelled = useRef(new Set<string>());

  const write = useCallback((next: (prev: Record<string, SsoEntry>) => Record<string, SsoEntry>) => {
    entriesRef.current = next(entriesRef.current);
    setEntries(entriesRef.current);
  }, []);

  const start = useCallback(
    (profile: string, opts: { manual: boolean }): Promise<boolean> => {
      const plan = loginPlan(profilesRef.current, profile);
      const running = flights.current.get(plan.key);
      if (running) return running;
      if (!opts.manual && (!plan.auto || entriesRef.current[plan.key])) return Promise.resolve(false);
      cancelled.current.delete(plan.key);
      const entry = (status: SsoStatus): SsoEntry => ({ key: plan.key, profile, target: plan.target, status });
      write((prev) => ({ ...prev, [plan.key]: entry({ kind: "running" }) }));
      const flight = api
        .ssoLogin(plan.target)
        .then(
          () => {
            write(({ [plan.key]: _done, ...rest }) => rest);
            const affected = new Set(
              (profilesRef.current ?? []).filter((p) => loginPlan(profilesRef.current, p.name).key === plan.key).map((p) => p.name),
            );
            affected.add(profile);
            void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[1] === "string" && affected.has(q.queryKey[1]) });
            return true;
          },
          (e: unknown) => {
            const status: SsoStatus = cancelled.current.has(plan.key) ? { kind: "cancelled" } : { kind: "failed", message: errorMessage(e) };
            write((prev) => ({ ...prev, [plan.key]: entry(status) }));
            return false;
          },
        )
        .finally(() => flights.current.delete(plan.key));
      flights.current.set(plan.key, flight);
      return flight;
    },
    [qc, write],
  );

  const cancel = useCallback((key: string) => {
    const entry = entriesRef.current[key];
    if (entry?.status.kind !== "running") return;
    cancelled.current.add(key);
    void api.ssoLoginCancel(entry.target).catch(() => {});
  }, []);

  /** 실패 배너를 닫는다. 닫은 세션은 취소한 것처럼 자동으로 다시 열지 않는다. */
  const dismiss = useCallback(
    (key: string) => {
      write((prev) => (prev[key]?.status.kind === "failed" ? { ...prev, [key]: { ...prev[key], status: { kind: "cancelled" } } } : prev));
    },
    [write],
  );

  /** 사용자가 프로필을 직접 고르면 그 세션의 실패·취소 기록을 지워 자동 로그인을 다시 켠다. */
  const rearm = useCallback(
    (profile: string) => {
      const { key } = loginPlan(profilesRef.current, profile);
      write((prev) => {
        if (!prev[key] || prev[key].status.kind === "running") return prev;
        const { [key]: _old, ...rest } = prev;
        return rest;
      });
    },
    [write],
  );

  useEffect(() => onSsoExpired((profile) => void start(profile, { manual: false })), [start]);

  return useMemo(
    () => ({
      entries: Object.values(entries),
      statusFor: (profile: string): SsoStatus | null => entries[loginPlan(profiles, profile).key]?.status ?? null,
      start,
      cancel,
      dismiss,
      rearm,
    }),
    [entries, profiles, start, cancel, dismiss, rearm],
  );
}

export type SsoLogin = ReturnType<typeof useSsoLogin>;

export const SsoLoginContext = createContext<SsoLogin | null>(null);

/** 앱 안에서는 로그인 관리자를, 단독으로 그린 컴포넌트(테스트 등)에서는 null을 준다. */
export const useSsoLoginContext = () => useContext(SsoLoginContext);
```

Run `npx vitest run src/lib/useSsoLogin.test.tsx`. Expected: PASS.

- [ ] **Step 5: Banner tests + implementation.** In `src/components/SsoBanner.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { SsoBanner } from "./SsoBanner";

test("running and failed logins get their own lines and actions", () => {
  const onCancel = vi.fn();
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  render(
    <SsoBanner
      entries={[
        { key: "session:a", profile: "prod", target: "prod", status: { kind: "running" } },
        { key: "session:b", profile: "dev", target: "dev", status: { kind: "failed", message: "aws CLI를 찾을 수 없어요" } },
        { key: "session:c", profile: "old", target: "old", status: { kind: "cancelled" } },
      ]}
      onCancel={onCancel}
      onRetry={onRetry}
      onDismiss={onDismiss}
    />,
  );
  expect(screen.getByText("prod: SSO 로그인 중이에요. 브라우저에서 승인해 주세요")).toBeInTheDocument();
  expect(screen.getByText("dev: SSO 로그인에 실패했어요: aws CLI를 찾을 수 없어요")).toBeInTheDocument();
  expect(screen.queryByText(/old/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  fireEvent.click(screen.getByRole("button", { name: "다시 로그인" }));
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(onCancel).toHaveBeenCalledWith("session:a");
  expect(onRetry).toHaveBeenCalledWith("dev");
  expect(onDismiss).toHaveBeenCalledWith("session:b");
});

test("nothing to show renders nothing", () => {
  const { container } = render(<SsoBanner entries={[]} onCancel={() => {}} onRetry={() => {}} onDismiss={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});
```

`src/components/SsoBanner.tsx`:

```tsx
import type { SsoEntry } from "../lib/useSsoLogin";

interface Props {
  entries: SsoEntry[];
  onCancel: (key: string) => void;
  onRetry: (profile: string) => void;
  onDismiss: (key: string) => void;
}

/** 진행 중이거나 실패한 SSO 로그인을 한 줄씩 보여준다. 취소한 로그인은 보여주지 않는다. */
export function SsoBanner({ entries, onCancel, onRetry, onDismiss }: Props) {
  const shown = entries.filter((e) => e.status.kind !== "cancelled");
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((e) => (
        <div key={e.key} className="update-banner" role="status">
          {e.status.kind === "failed" ? (
            <>
              <span>{`${e.profile}: SSO 로그인에 실패했어요: ${e.status.message}`}</span>
              <button className="btn small primary" onClick={() => onRetry(e.profile)}>
                다시 로그인
              </button>
              <button className="btn small" onClick={() => onDismiss(e.key)}>
                닫기
              </button>
            </>
          ) : (
            <>
              <span>{`${e.profile}: SSO 로그인 중이에요. 브라우저에서 승인해 주세요`}</span>
              <button className="btn small" onClick={() => onCancel(e.key)}>
                취소
              </button>
            </>
          )}
        </div>
      ))}
    </>
  );
}
```

- [ ] **Step 6: ErrorState joins the manager.** Keep the existing tests: without a provider, the old direct path still applies. Add to `ErrorState.test.tsx`:

```tsx
import { SsoLoginContext, type SsoLogin } from "../lib/useSsoLogin";

function manager(over: Partial<SsoLogin> = {}): SsoLogin {
  return { entries: [], statusFor: () => null, start: vi.fn(async () => true), cancel: vi.fn(), dismiss: vi.fn(), rearm: vi.fn(), ...over };
}

test("inside the app the login button goes through the manager", async () => {
  const sso = manager();
  const onRetry = vi.fn();
  render(
    <SsoLoginContext.Provider value={sso}>
      <ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={onRetry} />
    </SsoLoginContext.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  await waitFor(() => expect(onRetry).toHaveBeenCalled());
  expect(sso.start).toHaveBeenCalledWith("prod", { manual: true });
  expect(api.ssoLogin).not.toHaveBeenCalled();
});

test("a running login shows the busy button", () => {
  const sso = manager({ statusFor: () => ({ kind: "running" }) });
  render(
    <SsoLoginContext.Provider value={sso}>
      <ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={() => {}} />
    </SsoLoginContext.Provider>,
  );
  expect(screen.getByRole("button", { name: "브라우저에서 로그인을 완료하세요…" })).toBeDisabled();
});
```

In `ErrorState.tsx`, call `const sso = useSsoLoginContext();` at the top, with the other hooks. In the `ssoExpired` branch:

```tsx
    const running = sso ? sso.statusFor(profile)?.kind === "running" : busy;
    const login = async () => {
      if (sso) {
        if (await sso.start(profile, { manual: true })) onRetry();
        return;
      }
      setBusy(true);
      setLoginError(null);
      try {
        await api.ssoLogin(profile);
        onRetry();
      } catch (e) {
        setLoginError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    };
```

The button becomes `disabled={running}`, with label `{running ? "브라우저에서 로그인을 완료하세요…" : "로그인"}`. Keep `loginError` rendering. It is only set on the fallback path; inside the app, the banner shows failures.

- [ ] **Step 7: App wiring.** In `src/App.tsx`:
  - Hooks first, before any early return: `const sso = useSsoLogin(profiles.data);`.
  - In `changeProfile(name)`, call `sso.rearm(name);`, because an explicit selection re-arms auto-login.
  - Wrap the returned `<div className="app">…</div>` in `<SsoLoginContext.Provider value={sso}>…</SsoLoginContext.Provider>`.
  - Right after `<UpdateBanner … />`, add:

```tsx
      <SsoBanner entries={sso.entries} onCancel={sso.cancel} onRetry={(p) => void sso.start(p, { manual: true })} onDismiss={sso.dismiss} />
```

In `src/App.test.tsx`:
- Add `ssoLoginCancel: vi.fn(),` to the `./api/client` mock.
- Add `import { reportSsoExpired } from "./api/invoke";` and `act` from Testing Library if it isn't imported yet.
- Add this test:

```tsx
test("an expired SSO session logs in automatically and shows the banner", async () => {
  m.listProfiles.mockResolvedValue([
    { name: "dev", region: "us-east-1", ssoLogin: "dev", ssoKey: "session:corp" },
    { name: "prod", region: "ap-northeast-2", ssoLogin: "dev", ssoKey: "session:corp" },
  ]);
  m.ssoLogin.mockReturnValue(new Promise(() => {}));
  renderWithClient(<App />);
  await screen.findByRole("combobox", { name: "프로필" });
  act(() => reportSsoExpired("prod"));
  expect(m.ssoLogin).toHaveBeenCalledWith("dev");
  expect(await screen.findByText("prod: SSO 로그인 중이에요. 브라우저에서 승인해 주세요")).toBeInTheDocument();
});
```

`renderWithClient` comes from `./test/utils` and is already imported. Add `act` to the existing `@testing-library/react` import.

- [ ] **Step 8: Verify.** Run `npx vitest run` (all), `npx tsc --noEmit` and `npm run build`. Expected: all pass. Mutation-check: in `start`, drop the `flights.current.get` join and confirm "an expiry report starts one login per SSO session" fails. Then drop the `entriesRef.current[plan.key]` check and confirm the failure test fails. Restore both.

- [ ] **Step 9: Commit** the files above. Message: `feat(sso): log in automatically when an SSO session expires`.

---

### Task S3: Docs, final review, merge (controller)
- README: replace "When an SSO session expires, you can sign in again from the app." with: "When an SSO session has expired — when you pick the profile, when the app starts, or while you work — the app runs `aws sso login` for you. Approve it in the browser that opens and the lists reload. A banner shows the progress and lets you cancel. Profiles that share an SSO session sign in once."
- `docs/manual-test-checklist.md`: add an SSO section:
  1. Run `aws sso logout`, then start the app. The browser opens without a click. Approve, and the list loads by itself.
  2. Switch to another expired SSO profile. Same result.
  3. Press [취소] in the banner. The banner goes away and the browser doesn't open again until you re-select the profile or press [로그인].
  4. Use two profiles that share one `sso_session`. You sign in once.
  5. Use a role profile with `source_profile` pointing at an SSO profile. It signs in through the source profile.
  6. Use a non-SSO profile. Nothing opens.
- Whole-branch review (most capable model), one fix wave, merge `feat/sso-auto-login` into `main` (fast-forward), and push.
