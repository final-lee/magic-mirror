//! SSO 로그인 실행. 같은 SSO 세션의 로그인은 하나만 돌고, 나중에 온 요청은 진행 중인 결과를 함께 기다린다.
use std::collections::HashMap;
use std::ffi::OsStr;
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
                // 등록하기 전에 만든다: `run`이 바로 패닉해도 목록에 죽은 항목이 남지 않는다
                let fut = run(cancel.clone());
                flights.insert(key.to_string(), Flight { id, done: rx.clone(), cancel });
                let all = self.flights.clone();
                let key = key.to_string();
                tokio::spawn(async move {
                    // 실행이 패닉해도 목록 정리와 결과 전달은 한다. 안 그러면 이 키가 앱을 다시 켤 때까지 막힌다
                    let result = tokio::spawn(fut).await.unwrap_or_else(|_| Err(AppError::other("로그인이 중단됐어요")));
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
    run_sso_login_with(&AWS_CLI_CANDIDATES, &profile, cancel).await
}

/// `bins`를 순서대로 시도해 처음 실행되는 것으로 로그인한다. 없는 경로는 건너뛴다. 테스트가 가짜 CLI를 넘길 수 있게 후보를 인자로 받는다.
async fn run_sso_login_with<S: AsRef<OsStr>>(bins: &[S], profile: &str, cancel: Arc<Notify>) -> Result<(), AppError> {
    for bin in bins {
        let mut child = match Command::new(bin)
            .args(["sso", "login", "--profile", profile])
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// 고장 나면 멈춰 버리지 않고 실패하도록, 곧 끝나야 하는 대기를 5초로 막는다.
    async fn within<T>(fut: impl Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(5), fut).await.expect("did not finish within 5s")
    }

    async fn wait_running(logins: &SsoLogins, key: &str) {
        within(async {
            while !logins.is_running(key).await {
                tokio::task::yield_now().await;
            }
        })
        .await;
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
        assert_eq!(within(first).await.unwrap(), Ok(()));
        assert_eq!(within(second).await.unwrap(), Ok(()));
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
        assert_eq!(within(first).await.unwrap(), Err(AppError::other("boom")));
        assert_eq!(within(second).await.unwrap(), Err(AppError::other("boom")));
    }

    #[tokio::test]
    async fn different_keys_and_finished_logins_run_again() {
        let logins = SsoLogins::default();
        let runs = Arc::new(AtomicUsize::new(0));
        for key in ["a", "b", "a"] {
            let runs = runs.clone();
            within(logins.login(key, move |_| async move {
                runs.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }))
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
        assert_eq!(within(task).await.unwrap(), Err(AppError::other(CANCELLED)));
    }

    #[tokio::test]
    async fn cancel_without_a_running_login_does_not_affect_the_next_one() {
        let logins = SsoLogins::default();
        logins.cancel("k").await;
        let result = within(logins.login("k", |cancel| async move {
            tokio::select! {
                _ = cancel.notified() => Err(AppError::other(CANCELLED)),
                _ = tokio::time::sleep(Duration::from_millis(20)) => Ok(()),
            }
        }))
        .await;
        assert_eq!(result, Ok(()));
    }

    #[tokio::test]
    async fn the_entry_is_removed_before_the_result_is_sent() {
        let logins = Arc::new(SsoLogins::default());
        let gate = Arc::new(Notify::new());
        let first = {
            let (logins, gate) = (logins.clone(), gate.clone());
            tokio::spawn(async move {
                logins
                    .login("k", move |_| async move {
                        gate.notified().await;
                        Ok(())
                    })
                    .await
            })
        };
        wait_running(&logins, "k").await;
        // 목록 잠금을 쥔 채 실행을 끝낸다: 항목을 뺄 수 없으니 결과도 아직 나가면 안 된다
        let table = logins.flights.lock().await;
        gate.notify_one();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!first.is_finished(), "the result was sent while the entry was still listed");
        drop(table);
        assert_eq!(within(first).await.unwrap(), Ok(()));
    }

    #[tokio::test]
    async fn a_run_that_panics_does_not_block_the_key() {
        let logins = SsoLogins::default();
        let first = within(logins.login("k", |_| async { panic!("run blew up") })).await;
        assert_eq!(first, Err(AppError::other("로그인이 중단됐어요")));
        assert!(!logins.is_running("k").await);
        let runs = Arc::new(AtomicUsize::new(0));
        let second = {
            let runs = runs.clone();
            within(logins.login("k", move |_| async move {
                runs.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }))
            .await
        };
        assert_eq!(second, Ok(()));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_run_that_panics_before_returning_its_future_leaves_no_entry() {
        let logins = Arc::new(SsoLogins::default());
        let task = {
            let logins = logins.clone();
            tokio::spawn(async move {
                logins
                    .login("k", |_| -> std::future::Ready<Result<(), AppError>> { panic!("run blew up") })
                    .await
            })
        };
        assert!(within(task).await.unwrap_err().is_panic());
        assert!(!logins.is_running("k").await);
        assert_eq!(within(logins.login("k", |_| async { Ok(()) })).await, Ok(()));
    }

    #[test]
    fn the_cancelled_text_is_the_agreed_one() {
        // 프론트엔드와 문서가 이 문구를 그대로 쓴다
        assert_eq!(CANCELLED, "로그인을 취소했어요");
    }

    /// 가짜 `aws` 스크립트로 실제 프로세스 경로(`run_sso_login_with`)를 확인한다. 진짜 `aws`는 쓰지 않는다.
    #[cfg(unix)]
    mod fake_cli {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::path::{Path, PathBuf};

        /// `dir`에 실행 가능한 셸 스크립트를 만든다.
        fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        /// 스크립트가 자기 pid를 적을 때까지 기다린다(= 프로세스가 실제로 떴다).
        async fn wait_for_pid(file: &Path) -> u32 {
            loop {
                if let Some(pid) = std::fs::read_to_string(file).ok().and_then(|s| s.trim().parse().ok()) {
                    return pid;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }

        /// `kill -0`은 신호를 보내지 않고 그 pid가 남아 있는지만 확인한다.
        fn process_exists(pid: u32) -> bool {
            std::process::Command::new("sh")
                .args(["-c", "kill -0 \"$1\" 2>/dev/null", "sh", &pid.to_string()])
                .status()
                .unwrap()
                .success()
        }

        #[tokio::test]
        async fn passes_sso_login_profile_as_separate_arguments_and_skips_missing_candidates() {
            let dir = tempfile::tempdir().unwrap();
            let argv = dir.path().join("argv");
            let aws = script(dir.path(), "aws", &format!("printf '%s\\n' \"$@\" > '{}'", argv.display()));
            let missing = dir.path().join("no-such-dir").join("aws");
            let result = within(run_sso_login_with(&[missing.as_path(), aws.as_path()], "my prof", Arc::new(Notify::new()))).await;
            assert_eq!(result, Ok(()));
            // 인자마다 한 줄: 공백이 든 프로필 이름도 한 인자다(셸을 거치지 않는다)
            assert_eq!(std::fs::read_to_string(&argv).unwrap(), "sso\nlogin\n--profile\nmy prof\n");
        }

        #[tokio::test]
        async fn a_nonzero_exit_is_a_failure_with_the_status() {
            let dir = tempfile::tempdir().unwrap();
            let aws = script(dir.path(), "aws", "exit 3");
            let result = within(run_sso_login_with(&[aws.as_path()], "p", Arc::new(Notify::new()))).await;
            assert_eq!(result, Err(AppError::other("aws sso login이 실패했어요 (exit status: 3)")));
        }

        #[tokio::test]
        async fn cancel_kills_the_running_process() {
            let dir = tempfile::tempdir().unwrap();
            let pid_file = dir.path().join("pid");
            // exec: 셸이 sleep으로 바뀌어서 적어 둔 pid가 곧 우리가 띄운 프로세스다
            let aws = script(dir.path(), "aws", &format!("echo $$ > '{}'\nexec sleep 30", pid_file.display()));
            let cancel = Arc::new(Notify::new());
            let candidates = [aws.as_path()];
            let (result, pid) = within(async {
                let login = run_sso_login_with(&candidates, "p", cancel.clone());
                let cancel_once_running = async {
                    let pid = wait_for_pid(&pid_file).await;
                    cancel.notify_one();
                    pid
                };
                tokio::join!(login, cancel_once_running)
            })
            .await;
            assert_eq!(result, Err(AppError::other(CANCELLED)));
            assert!(!process_exists(pid), "process {pid} is still alive after cancel");
        }

        #[tokio::test]
        async fn a_cancel_sent_before_the_process_starts_is_honored() {
            let dir = tempfile::tempdir().unwrap();
            let aws = script(dir.path(), "aws", "exec sleep 30");
            let cancel = Arc::new(Notify::new());
            cancel.notify_one();
            let result = within(run_sso_login_with(&[aws.as_path()], "p", cancel)).await;
            assert_eq!(result, Err(AppError::other(CANCELLED)));
        }

        #[tokio::test]
        async fn no_candidate_means_the_cli_is_not_found() {
            let dir = tempfile::tempdir().unwrap();
            let candidates = [dir.path().join("a").join("aws"), dir.path().join("b").join("aws")];
            let result = within(run_sso_login_with(&candidates, "p", Arc::new(Notify::new()))).await;
            assert_eq!(result, Err(AppError::other("aws CLI를 찾을 수 없어요")));
        }
    }
}
