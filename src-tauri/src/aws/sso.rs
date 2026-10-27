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
