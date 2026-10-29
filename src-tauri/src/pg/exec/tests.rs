use std::time::Duration;

use super::*;
use crate::pg::fake_server::{FakeServer, Reply, Rule, Script};

const SHORT: Duration = Duration::from_millis(300);

fn step(run: &str) -> Step {
    Step { run: run.into(), expect: None }
}

fn expecting(run: &str, text: &'static str) -> Step {
    Step { run: run.into(), expect: Some(text) }
}

async fn connect(rules: &'static [Rule]) -> (FakeServer, Connected) {
    let server = FakeServer::start(Script::Writes(rules)).await;
    let conn = server.connected(1).await;
    (server, conn)
}

fn failed_with(text: &str) -> Result<(), ExecError> {
    Err(ExecError::Failed(AppError::other(text)))
}

// tokio-postgres opens a transaction with `START TRANSACTION` (the brief says BEGIN: same command)
const SETTINGS: [&str; 3] = ["START TRANSACTION", "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '60s'"];

fn queries(tail: &[&str]) -> Vec<String> {
    SETTINGS.iter().chain(tail).map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn the_steps_run_in_one_transaction_in_order() {
    let (server, mut conn) = connect(&[]).await;
    run(&mut conn, &[step("CREATE ROLE a"), step("GRANT b TO a")]).await.unwrap();
    assert_eq!(server.simple_queries(), queries(&["CREATE ROLE a", "GRANT b TO a", "COMMIT"]));
}

#[tokio::test]
async fn a_server_error_rolls_back_and_carries_the_servers_message() {
    const RULES: &[Rule] = &[Rule { contains: "GRANT", reply: &[Reply::Error { code: "42704", message: "role \"ghost\" does not exist" }] }];
    let (server, mut conn) = connect(RULES).await;
    let outcome = run(&mut conn, &[step("CREATE ROLE a"), step("GRANT x TO ghost"), step("DROP ROLE never")]).await;
    assert_eq!(outcome, failed_with("적용하지 못했어요: role \"ghost\" does not exist"));
    assert_eq!(server.simple_queries(), queries(&["CREATE ROLE a", "GRANT x TO ghost", "ROLLBACK"]));
    // 연결은 이어 쓸 수 있다
    assert!(!conn.broken);
}

#[tokio::test]
async fn a_lock_timeout_reads_as_the_lock_text() {
    const RULES: &[Rule] = &[Rule { contains: "GRANT", reply: &[Reply::Error { code: "55P03", message: "canceling statement due to lock timeout" }] }];
    let (_server, mut conn) = connect(RULES).await;
    assert_eq!(run(&mut conn, &[step("GRANT SELECT ON t TO a")]).await, failed_with(LOCK_TEXT));
}

#[tokio::test]
async fn a_class_01_notice_fails_the_run_and_rolls_back() {
    const RULES: &[Rule] = &[Rule { contains: "GRANT", reply: &[Reply::Notice { severity: "WARNING", code: "01007", message: "no privileges were granted for \"t\"" }] }];
    let (server, mut conn) = connect(RULES).await;
    let outcome = run(&mut conn, &[step("GRANT SELECT ON t TO a"), step("SELECT 1")]).await;
    assert_eq!(outcome, failed_with("적용하지 못했어요: no privileges were granted for \"t\""));
    assert_eq!(server.simple_queries(), queries(&["GRANT SELECT ON t TO a", "ROLLBACK"]));
}

#[tokio::test]
async fn a_warning_severity_fails_even_with_another_code_and_other_notices_are_ignored() {
    const WARNING: &[Rule] = &[Rule { contains: "A", reply: &[Reply::Notice { severity: "WARNING", code: "XX000", message: "heads up" }] }];
    let (_server, mut conn) = connect(WARNING).await;
    assert_eq!(run(&mut conn, &[step("A")]).await, failed_with("적용하지 못했어요: heads up"));

    const NOTICE: &[Rule] = &[Rule { contains: "A", reply: &[Reply::Notice { severity: "NOTICE", code: "00000", message: "role already a member" }] }];
    let (server, mut conn) = connect(NOTICE).await;
    run(&mut conn, &[step("A")]).await.unwrap();
    assert!(server.simple_queries().ends_with(&["COMMIT".to_string()]));

    // 클래스 01은 심각도가 NOTICE여도 실패다
    const CLASS_01: &[Rule] = &[Rule { contains: "A", reply: &[Reply::Notice { severity: "NOTICE", code: "01000", message: "warning class" }] }];
    let (_server, mut conn) = connect(CLASS_01).await;
    assert_eq!(run(&mut conn, &[step("A")]).await, failed_with("적용하지 못했어요: warning class"));
}

#[tokio::test]
async fn an_expectation_that_is_not_met_fails_with_its_text_before_any_warning_is_read() {
    const RULES: &[Rule] = &[Rule { contains: "pg_terminate_backend", reply: &[Reply::Notice { severity: "WARNING", code: "01000", message: "PID 7 is not a PostgreSQL server process" }, Reply::Row("f")] }];
    let (server, mut conn) = connect(RULES).await;
    let outcome = run(&mut conn, &[expecting("SELECT pg_terminate_backend(7)", "세션이 이미 끝났어요")]).await;
    assert_eq!(outcome, failed_with("세션이 이미 끝났어요"));
    assert_eq!(server.simple_queries().last().map(String::as_str), Some("ROLLBACK"));
}

#[tokio::test]
async fn a_true_first_cell_passes_and_no_row_fails() {
    const TRUE: &[Rule] = &[Rule { contains: "pg_terminate_backend", reply: &[Reply::Row("t")] }];
    let (server, mut conn) = connect(TRUE).await;
    run(&mut conn, &[expecting("SELECT pg_terminate_backend(7)", "세션이 이미 끝났어요")]).await.unwrap();
    assert_eq!(server.simple_queries().last().map(String::as_str), Some("COMMIT"));

    let (_server, mut conn) = connect(&[]).await;
    assert_eq!(run(&mut conn, &[expecting("SELECT pg_terminate_backend(7)", "세션이 이미 끝났어요")]).await, failed_with("세션이 이미 끝났어요"));
}

#[tokio::test]
async fn notices_left_over_from_earlier_statements_are_dropped_before_a_run() {
    const RULES: &[Rule] = &[Rule { contains: "leftover", reply: &[Reply::Notice { severity: "WARNING", code: "01000", message: "from an earlier statement" }] }];
    let (_server, mut conn) = connect(RULES).await;
    conn.client.simple_query("leftover").await.unwrap();
    run(&mut conn, &[step("CREATE ROLE a")]).await.unwrap();
}

#[tokio::test]
async fn a_connection_that_closes_before_commit_is_a_plain_failure() {
    const RULES: &[Rule] = &[Rule { contains: "GRANT", reply: &[Reply::HangUp] }];
    let (server, mut conn) = connect(RULES).await;
    assert_eq!(run(&mut conn, &[step("GRANT x TO a")]).await, failed_with(LOST_BEFORE_COMMIT));
    // 끊긴 연결에는 ROLLBACK도 보내지 않는다
    assert!(!server.simple_queries().contains(&"ROLLBACK".to_string()), "{:?}", server.simple_queries());
}

#[tokio::test]
async fn a_connection_that_closes_during_commit_is_unknown() {
    const RULES: &[Rule] = &[Rule { contains: "COMMIT", reply: &[Reply::HangUp] }];
    let (_server, mut conn) = connect(RULES).await;
    assert_eq!(run(&mut conn, &[step("GRANT x TO a")]).await, Err(ExecError::CommitUnknown));
}

#[tokio::test]
async fn a_fatal_error_ends_the_session_like_a_closed_connection() {
    const BEFORE: &[Rule] = &[Rule { contains: "GRANT", reply: &[Reply::Fatal { code: "57P01", message: "terminating connection due to administrator command" }] }];
    let (_server, mut conn) = connect(BEFORE).await;
    assert_eq!(run(&mut conn, &[step("GRANT x TO a")]).await, failed_with(LOST_BEFORE_COMMIT));

    const DURING: &[Rule] = &[Rule { contains: "COMMIT", reply: &[Reply::Fatal { code: "57P01", message: "terminating connection due to administrator command" }] }];
    let (_server, mut conn) = connect(DURING).await;
    assert_eq!(run(&mut conn, &[step("GRANT x TO a")]).await, Err(ExecError::CommitUnknown));
}

#[tokio::test]
async fn a_run_that_outlasts_the_deadline_marks_the_connection_broken() {
    const BEFORE: &[Rule] = &[Rule { contains: "GRANT", reply: &[Reply::Stall] }];
    let (server, mut conn) = connect(BEFORE).await;
    assert_eq!(run_within(&mut conn, SHORT, &[step("GRANT x TO a")]).await, failed_with(LOST_BEFORE_COMMIT));
    assert!(conn.broken);
    // 깨진 연결에는 문장을 보내지 않는다
    let sent = server.simple_queries().len();
    assert_eq!(run(&mut conn, &[step("SELECT 1")]).await, failed_with(LOST_BEFORE_COMMIT));
    assert_eq!(server.simple_queries().len(), sent);

    const DURING: &[Rule] = &[Rule { contains: "COMMIT", reply: &[Reply::Stall] }];
    let (_server, mut conn) = connect(DURING).await;
    assert_eq!(run_within(&mut conn, SHORT, &[step("GRANT x TO a")]).await, Err(ExecError::CommitUnknown));
    assert!(conn.broken);
}

#[tokio::test]
async fn a_closed_client_is_refused_without_sending() {
    let (server, mut conn) = connect(&[]).await;
    server.close_connections();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(run(&mut conn, &[step("SELECT 1")]).await, failed_with(LOST_BEFORE_COMMIT));
}

#[test]
fn a_step_prints_without_its_statement() {
    let printed = format!("{:?}", Step { run: "ALTER ROLE a PASSWORD 'SCRAM-SHA-256$4096:salt$key:key'".into(), expect: None });
    assert!(!printed.contains("SCRAM") && !printed.contains("ALTER"), "{printed}");
    assert!(printed.contains(crate::pg::password::MASK));
}
