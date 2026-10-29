//! 데이터베이스를 바꾸는 문장을 보내는 유일한 곳. 변경 하나(또는 장바구니 하나)가 트랜잭션 하나다.
//!
//! `BEGIN`, `SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '60s'`, 문장들, `COMMIT` 순서로 보낸다.
//! 문장 하나가 실패하거나 경고 알림(클래스 01, 심각도 WARNING)을 보내면 `ROLLBACK`하고 거기서 멈춘다: 알림은 서버가 "요청을 다 하지 못했다"는 뜻으로 보내는 경우가
//! 많다(`GRANT`를 줄 권한이 없을 때 오류 없이 경고만 낸다). 반쪽만 적용된 채로 커밋하지 않는다.
//! 여기를 부르는 곳은 `pg_commands`가 `commit::commit`과 `drop::apply`에 넘기는 닫힘 하나씩이다(검사 테스트 `pg::hygiene`이 센다).
//! 앱이 쓰는 질의는 읽기(`catalog`)와 이 파일뿐이다.
//!
//! 비밀번호의 검증값이 든 문장은 `Step`에 들어 있다. `Step`은 `Debug`를 파생하지 않고 가려서 찍는다.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::mpsc::UnboundedReceiver;
use tokio_postgres::error::SqlState;
use tokio_postgres::{Client, SimpleQueryMessage};

use super::connect::{Connected, Notice};
use crate::error::AppError;

/// 다른 작업이 잠근 객체를 기다리는 시간
const LOCK_TIMEOUT: &str = "SET LOCAL lock_timeout = '5s'";
/// 문장 하나가 쓸 수 있는 시간
const STATEMENT_TIMEOUT: &str = "SET LOCAL statement_timeout = '60s'";

/// 변경 하나가 끝나야 하는 시간(트랜잭션 전체). 서버가 지켜 주는 시간(`statement_timeout`)은 연결이 조용히 끊기면 소용이 없어서 클라이언트도 잰다.
/// 넘기면 그 연결은 버린다(`Connected::broken`)
const RUN_DEADLINE: Duration = Duration::from_secs(90);

pub const LOCK_TEXT: &str = "다른 작업이 객체를 잠그고 있어 적용하지 못했어요. 잠시 뒤 다시 시도하세요";
/// `COMMIT`을 보내기 전에 연결이 끊겼다: 서버는 클라이언트가 떠난 열린 트랜잭션을 되돌린다
pub const LOST_BEFORE_COMMIT: &str = "적용하지 못했어요: 데이터베이스 연결이 끊겼어요";
/// `COMMIT`의 답을 기다리다 연결이 끊겼다: 서버가 커밋했는지 알 수 없다
pub const UNKNOWN_OUTCOME: &str = "데이터베이스 연결이 끊겨 적용됐는지 알 수 없어요. 다시 읽어서 확인해 주세요";

/// 서버에 보낼 문장 하나. `run`에는 비밀번호의 검증값이 들어 있을 수 있어서 `Debug`는 문장을 찍지 않는다
pub struct Step {
    pub run: String,
    /// 문장이 돌려준 첫 줄의 첫 칸이 `true`가 아니면 이 문구로 실패한다
    pub expect: Option<&'static str>,
}

impl fmt::Debug for Step {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Step {{ run: {}, expect: {:?} }}", super::password::MASK, self.expect)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExecError {
    /// 적용되지 않았다(되돌렸다). 사용자 문구가 든다
    Failed(AppError),
    /// `COMMIT`을 보낸 뒤 연결이 끊겨 서버가 커밋했는지 알 수 없다
    CommitUnknown,
}

/// 오류를 낸 쪽
enum Fault {
    /// 서버가 거절했다. 연결은 살아 있다
    Rejected(AppError),
    /// 연결이 끊겼다(서버가 세션을 끝낸 것 포함)
    Lost,
}

fn failed(reason: &str) -> ExecError {
    ExecError::Failed(AppError::other(format!("적용하지 못했어요: {reason}")))
}

fn lost_before_commit() -> ExecError {
    ExecError::Failed(AppError::other(LOST_BEFORE_COMMIT))
}

fn fault_of(error: &tokio_postgres::Error) -> Fault {
    let Some(db) = error.as_db_error() else { return Fault::Lost };
    // 서버가 세션을 끝낸 오류(관리자 종료 57P01, 충돌 종료 57P02, 접속 불가 57P03)와 치명 오류는 연결이 끊긴 것과 같다
    if matches!(db.code().code(), "57P01" | "57P02" | "57P03") || matches!(db.severity(), "FATAL" | "PANIC") {
        return Fault::Lost;
    }
    if *db.code() == SqlState::LOCK_NOT_AVAILABLE {
        return Fault::Rejected(AppError::other(LOCK_TEXT));
    }
    Fault::Rejected(AppError::other(format!("적용하지 못했어요: {}", db.message())))
}

/// 쌓인 알림 가운데 적용을 멈춰야 하는 것(SQLSTATE가 `01`로 시작하거나 심각도가 WARNING)의 문구. 나머지 알림은 버린다
fn warning_in(notices: &mut UnboundedReceiver<Notice>) -> Option<String> {
    let mut found = None;
    while let Ok(notice) = notices.try_recv() {
        if found.is_none() && (notice.code.starts_with("01") || notice.severity == "WARNING") {
            found = Some(notice.message);
        }
    }
    found
}

/// 첫 줄의 첫 칸이 `true`인가
fn first_cell_is_true(messages: &[SimpleQueryMessage]) -> bool {
    messages.iter().find_map(|message| if let SimpleQueryMessage::Row(row) = message { Some(row) } else { None }).is_some_and(|row| row.try_get(0).ok().flatten() == Some("t"))
}

/// 문장들을 트랜잭션 하나에서 돌리고 커밋한다. 아무것도 적용되지 않았거나(`Failed`) 알 수 없다(`CommitUnknown`).
pub async fn run(conn: &mut Connected, steps: &[Step]) -> Result<(), ExecError> {
    run_within(conn, RUN_DEADLINE, steps).await
}

/// `run`에 제한 시간을 넘기는 꼴: 시험이 90초를 기다리지 않는다
pub(super) async fn run_within(conn: &mut Connected, deadline: Duration, steps: &[Step]) -> Result<(), ExecError> {
    if conn.broken || conn.client.is_closed() {
        return Err(lost_before_commit());
    }
    conn.drain_notices();
    let committing = AtomicBool::new(false);
    let Connected { client, notices, .. } = &mut *conn;
    match tokio::time::timeout(deadline, transact(client, notices, steps, &committing)).await {
        Ok(done) => done,
        Err(_elapsed) => {
            conn.broken = true;
            Err(if committing.load(Ordering::SeqCst) { ExecError::CommitUnknown } else { lost_before_commit() })
        }
    }
}

/// 중간에 멈춘 이유: 지금까지의 오류와, `ROLLBACK`을 보내야 하는가(연결이 끊겼으면 보낼 곳이 없다)
struct Stop {
    error: ExecError,
    rollback: bool,
}

impl From<Fault> for Stop {
    fn from(fault: Fault) -> Stop {
        match fault {
            Fault::Rejected(app) => Stop { error: ExecError::Failed(app), rollback: true },
            Fault::Lost => Stop { error: lost_before_commit(), rollback: false },
        }
    }
}

impl From<tokio_postgres::Error> for Stop {
    fn from(error: tokio_postgres::Error) -> Stop {
        fault_of(&error).into()
    }
}

/// `BEGIN` 뒤 `COMMIT` 앞: 시간 제한을 걸고 문장들을 돌린다
async fn body(tx: &tokio_postgres::Transaction<'_>, notices: &mut UnboundedReceiver<Notice>, steps: &[Step]) -> Result<(), Stop> {
    for setting in [LOCK_TIMEOUT, STATEMENT_TIMEOUT] {
        tx.batch_execute(setting).await?;
    }
    for step in steps {
        let messages = tx.simple_query(&step.run).await?;
        // 줄의 확인이 먼저다: 사라진 pid는 경고도 보내는데, 사용자에게 보일 문구는 확인의 것이다
        if let Some(text) = step.expect {
            if !first_cell_is_true(&messages) {
                return Err(Stop { error: ExecError::Failed(AppError::other(text)), rollback: true });
            }
        }
        if let Some(message) = warning_in(notices) {
            return Err(Stop { error: failed(&message), rollback: true });
        }
    }
    Ok(())
}

async fn transact(client: &mut Client, notices: &mut UnboundedReceiver<Notice>, steps: &[Step], committing: &AtomicBool) -> Result<(), ExecError> {
    // 이 앱에서 쓰기 트랜잭션을 여는 곳은 여기 하나뿐이다: 읽기 전용이 아니다
    let tx = client.build_transaction().start().await.map_err(|e| Stop::from(e).error)?;
    if let Err(stop) = body(&tx, notices, steps).await {
        if stop.rollback {
            let _ = tx.rollback().await;
        }
        return Err(stop.error);
    }
    finish(tx, committing).await
}

/// 마지막 문장 뒤: 연결이 닫혔는지 보고 `COMMIT`한다(시험이 닫힌 뒤의 이 결정만 따로 본다)
async fn finish(tx: tokio_postgres::Transaction<'_>, committing: &AtomicBool) -> Result<(), ExecError> {
    // 마지막 문장 뒤에 연결이 이미 닫혔으면 COMMIT은 가지도 못했다: 알 수 없는 것이 아니라 적용되지 않은 것이다
    if tx.client().is_closed() {
        return Err(lost_before_commit());
    }
    committing.store(true, Ordering::SeqCst);
    tx.commit().await.map_err(|e| match fault_of(&e) {
        Fault::Rejected(app) => ExecError::Failed(app),
        Fault::Lost => ExecError::CommitUnknown,
    })
}

#[cfg(test)]
mod tests;
