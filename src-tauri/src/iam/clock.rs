//! 시각 도우미. 순수 함수는 현재 시각을 직접 읽지 않고 유닉스 초(`now`)를 받아서 고정 날짜로 테스트할 수 있다.

use std::time::{SystemTime, UNIX_EPOCH};

use aws_smithy_types::date_time::Format;
use aws_smithy_types::DateTime;

pub const DAY_SECS: i64 = 86_400;

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// `2026-10-26T03:10:00Z`나 `2026-10-26T03:10:00+00:00`(자격 증명 보고서 형식)을 유닉스 초로 바꾼다. 읽지 못하면 None.
pub fn parse_iso(text: &str) -> Option<i64> {
    DateTime::from_str(text.trim(), Format::DateTimeWithOffset).ok().map(|d| d.secs())
}

/// 유닉스 초 → `2026-10-26T03:10:00Z`
pub fn iso(secs: i64) -> String {
    DateTime::from_secs(secs).fmt(Format::DateTime).unwrap_or_default()
}

/// AWS 응답의 시각 → ISO 문자열(초 미만은 버린다).
pub fn iso_of(time: Option<&DateTime>) -> Option<String> {
    time.map(|t| iso(t.secs()))
}

/// `then`부터 `now`까지 지난 날 수(내림). `then`이 미래면 0이다.
pub fn days_between(then: i64, now: i64) -> i64 {
    ((now - then) / DAY_SECS).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_z_and_offset_forms_to_the_same_second() {
        let z = parse_iso("2026-10-26T03:10:00Z").unwrap();
        assert_eq!(parse_iso("2026-10-26T03:10:00+00:00"), Some(z));
        assert_eq!(parse_iso("2026-10-26T03:10:00.000Z"), Some(z));
        assert_eq!(parse_iso(" 2026-10-26T03:10:00Z "), Some(z));
        // 오프셋이 있으면 UTC로 맞춘다
        assert_eq!(parse_iso("2026-10-26T12:10:00+09:00"), Some(z));
    }

    #[test]
    fn rejects_non_times() {
        for text in ["", "N/A", "no_information", "not_supported", "2026-10-26", "yesterday"] {
            assert_eq!(parse_iso(text), None, "{text}");
        }
    }

    #[test]
    fn formats_utc_without_fraction() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        let secs = parse_iso("2026-10-26T03:10:00+00:00").unwrap();
        assert_eq!(iso(secs), "2026-10-26T03:10:00Z");
        assert_eq!(parse_iso(&iso(secs)), Some(secs));
    }

    #[test]
    fn iso_of_drops_subseconds_and_keeps_none() {
        let t = DateTime::from_millis(1_700_000_000_999);
        assert_eq!(iso_of(Some(&t)), Some(iso(1_700_000_000)));
        assert_eq!(iso_of(None), None);
    }

    #[test]
    fn days_are_floored_and_never_negative() {
        let now = parse_iso("2026-10-26T00:00:00Z").unwrap();
        assert_eq!(days_between(now, now), 0);
        assert_eq!(days_between(now - DAY_SECS + 1, now), 0);
        assert_eq!(days_between(now - DAY_SECS, now), 1);
        assert_eq!(days_between(now - 90 * DAY_SECS - 3600, now), 90);
        assert_eq!(days_between(now + 5 * DAY_SECS, now), 0);
    }

    #[test]
    fn now_reads_the_system_clock() {
        assert!(now_secs() > 1_700_000_000);
    }
}
