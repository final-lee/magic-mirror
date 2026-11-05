use super::*;

fn fields(values: &[Option<&str>]) -> Vec<Option<String>> {
    values.iter().map(|v| v.map(str::to_string)).collect()
}

#[test]
fn a_row_reads_the_job_hash_fields_in_order() {
    // name timestamp processedOn finishedOn attemptsMade atm progress failedReason delay priority
    let f = fields(&[Some("send"), Some("1000"), Some("2000"), Some("3500"), None, Some("2"), Some("50"), Some("boom"), Some("0"), Some("3")]);
    let row = row_of("12", KvBullState::Failed, &f, None);
    assert_eq!((row.id.as_str(), row.name.as_str()), ("12", "send"));
    assert_eq!((row.timestamp, row.processed_on, row.finished_on), (Some(1000), Some(2000), Some(3500)));
    // BullMQ 5는 시도 횟수를 `atm`에 둔다
    assert_eq!(row.attempts_made, 2);
    assert_eq!((row.progress.as_deref(), row.failed_reason.as_deref(), row.priority), (Some("50"), Some("boom"), Some(3)));
}

#[test]
fn missing_fields_become_defaults() {
    let row = row_of("1", KvBullState::Delayed, &[], Some(99));
    assert_eq!((row.name.as_str(), row.attempts_made, row.delay_until, row.priority), ("", 0, Some(99), None));
}
