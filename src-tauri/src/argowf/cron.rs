//! CronWorkflow 스케줄의 다음 실행 시각과 놓친 실행. 시간대는 `spec.timezone`, 스케줄 앞의 `CRON_TZ=`가 있으면 그것이 이긴다.
use std::str::FromStr;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use croner::Cron;

/// `startingDeadlineSeconds`가 없을 때 놓쳤다고 보기까지 기다리는 시간(초)
pub const DEFAULT_GRACE_SECS: i64 = 300;

/// "CRON_TZ=Asia/Seoul 30 19 * * *" → (Some("Asia/Seoul"), "30 19 * * *"). `TZ=`도 같다(robfig/cron이 둘 다 받는다).
fn split_tz(schedule: &str) -> (Option<&str>, &str) {
    let s = schedule.trim();
    for prefix in ["CRON_TZ=", "TZ="] {
        if let Some(rest) = s.strip_prefix(prefix) {
            if let Some((tz, expr)) = rest.split_once(char::is_whitespace) {
                return (Some(tz), expr.trim());
            }
        }
    }
    (None, s)
}

/// 시간대 이름을 고른다. 없거나 모르는 이름이면 UTC(컨트롤러 컨테이너의 기본 시간대).
fn zone(schedule_tz: Option<&str>, spec_tz: Option<&str>) -> Tz {
    schedule_tz.or(spec_tz).and_then(|name| Tz::from_str(name).ok()).unwrap_or(Tz::UTC)
}

/// 스케줄 하나. robfig/cron(Argo가 쓰는 파서)은 cron식 말고도 `@every <기간>`을 받는다: 컨트롤러가 그 Cron을 잡은 때부터
/// 기간마다 돈다. 그 기준 시각은 밖에서 알 수 없어 마지막 실행 시각(없으면 만든 시각)을 기준으로 삼는다.
enum Schedule {
    Cron(Box<Cron>, Tz),
    Every(chrono::Duration),
}

/// robfig/cron의 별칭 중 croner가 모르는 것을 같은 뜻으로 바꾼다
fn alias(expr: &str) -> &str {
    match expr {
        "@midnight" => "@daily",
        "@annually" => "@yearly",
        other => other,
    }
}

/// Go `time.ParseDuration` 모양("90s", "1h30m", "1.5h", "500ms")을 읽는다. 0 이하는 받지 않는다.
fn go_duration(text: &str) -> Option<chrono::Duration> {
    let mut rest = text.trim();
    let mut total_ms = 0f64;
    if rest.is_empty() {
        return None;
    }
    while !rest.is_empty() {
        let num_len = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).filter(|&n| n > 0)?;
        let value: f64 = rest[..num_len].parse().ok()?;
        rest = &rest[num_len..];
        let unit_len = rest.find(|c: char| c.is_ascii_digit() || c == '.').unwrap_or(rest.len());
        let ms = match &rest[..unit_len] {
            "h" => 3_600_000.0,
            "m" => 60_000.0,
            "s" => 1_000.0,
            "ms" => 1.0,
            "us" | "µs" => 0.001,
            "ns" => 0.000_001,
            _ => return None,
        };
        total_ms += value * ms;
        rest = &rest[unit_len..];
    }
    (total_ms >= 1.0).then(|| chrono::Duration::milliseconds(total_ms as i64))
}

/// 해석할 수 있는 스케줄. 해석하지 못한 스케줄은 건너뛴다(화면은 원문을 보여 준다).
fn parsed(schedules: &[String], timezone: Option<&str>) -> Vec<Schedule> {
    schedules
        .iter()
        .filter_map(|s| {
            let (tz, expr) = split_tz(s);
            if let Some(every) = expr.strip_prefix("@every") {
                return go_duration(every).map(Schedule::Every);
            }
            Cron::from_str(alias(expr)).ok().map(|c| Schedule::Cron(Box::new(c), zone(tz, timezone)))
        })
        .collect()
}

/// `@every` 실행 중 기준(anchor)에서 기간의 배수만큼 떨어진, at 이후(포함 여부는 inclusive) 첫 시각
fn every_at_or_after(anchor: DateTime<Utc>, every: chrono::Duration, at: DateTime<Utc>, inclusive: bool) -> DateTime<Utc> {
    if at <= anchor {
        return anchor + every;
    }
    let step = every.num_milliseconds().max(1);
    let gone = (at - anchor).num_milliseconds();
    let mut k = gone / step;
    if anchor + chrono::Duration::milliseconds(k * step) < at || !inclusive {
        k += 1;
    }
    anchor + chrono::Duration::milliseconds(k * step)
}

/// after 다음(같은 시각은 빼고)의 실행 시각 n개. 스케줄이 여럿이면 합쳐서 시간순, 겹치는 시각은 하나로.
/// anchor는 `@every`의 기준(마지막 실행 시각, 없으면 만든 시각)이다. 없으면 after에서 센다.
pub fn next_runs(schedules: &[String], timezone: Option<&str>, anchor: Option<DateTime<Utc>>, after: DateTime<Utc>, n: usize) -> Vec<DateTime<Utc>> {
    let mut all: Vec<DateTime<Utc>> = Vec::new();
    for schedule in parsed(schedules, timezone) {
        match schedule {
            Schedule::Cron(cron, tz) => {
                let mut from = after.with_timezone(&tz);
                for _ in 0..n {
                    let Ok(next) = cron.find_next_occurrence(&from, false) else { break };
                    all.push(next.with_timezone(&Utc));
                    from = next;
                }
            }
            Schedule::Every(every) => {
                let first = every_at_or_after(anchor.unwrap_or(after), every, after, false);
                all.extend((0..n as i32).map(|i| first + every * i));
            }
        }
    }
    all.sort();
    all.dedup();
    all.truncate(n);
    all
}

/// before 이전(같은 시각 포함)의 가장 최근 실행 예정 시각. `@every`는 기준이 있을 때만 안다.
pub fn previous_run(schedules: &[String], timezone: Option<&str>, anchor: Option<DateTime<Utc>>, before: DateTime<Utc>) -> Option<DateTime<Utc>> {
    parsed(schedules, timezone)
        .into_iter()
        .filter_map(|schedule| match schedule {
            Schedule::Cron(cron, tz) => cron
                .find_previous_occurrence(&before.with_timezone(&tz), true)
                .ok()
                .map(|t| t.with_timezone(&Utc)),
            Schedule::Every(every) => {
                let anchor = anchor?;
                let next = every_at_or_after(anchor, every, before, true);
                let prev = if next == before { next } else { next - every };
                (prev > anchor).then_some(prev)
            }
        })
        .max()
}

/// 직전 예정 시각에서 기다리는 시간(`startingDeadlineSeconds`, 없으면 5분)이 지났는데도 그때 실행되지 않았으면 놓쳤다.
/// 마지막 실행 시각이 없으면 Cron을 만든 시각이 직전 예정보다 이를 때만 놓쳤다고 본다(갓 만든 Cron은 아직 기회가 없었다).
/// 정지된 Cron은 놓치지 않는다.
pub fn missed(
    schedules: &[String],
    timezone: Option<&str>,
    suspended: bool,
    last_scheduled: Option<DateTime<Utc>>,
    created: Option<DateTime<Utc>>,
    starting_deadline_secs: Option<i64>,
    now: DateTime<Utc>,
) -> bool {
    if suspended {
        return false;
    }
    let Some(prev) = previous_run(schedules, timezone, last_scheduled.or(created), now) else {
        return false;
    };
    let grace = chrono::Duration::seconds(starting_deadline_secs.unwrap_or(DEFAULT_GRACE_SECS).max(0));
    if now < prev + grace {
        return false;
    }
    match (last_scheduled, created) {
        (Some(last), _) => last < prev,
        (None, Some(created)) => created < prev,
        (None, None) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }
    fn s(list: &[&str]) -> Vec<String> {
        list.iter().map(|x| x.to_string()).collect()
    }
    fn iso(list: Vec<DateTime<Utc>>) -> Vec<String> {
        list.into_iter().map(|d| d.to_rfc3339()).collect()
    }

    #[test]
    fn next_runs_follow_the_spec_time_zone() {
        // 19:30 KST = 10:30 UTC
        let runs = next_runs(&s(&["30 19 * * *"]), Some("Asia/Seoul"), None, t("2026-11-02T10:30:00Z"), 2);
        assert_eq!(iso(runs), ["2026-11-03T10:30:00+00:00", "2026-11-04T10:30:00+00:00"]);
    }

    #[test]
    fn cron_tz_prefix_beats_the_spec_time_zone_and_unknown_zones_fall_back_to_utc() {
        let runs = next_runs(
            &s(&["CRON_TZ=America/New_York 0 9 * * *"]),
            Some("Asia/Seoul"),
            None,
            t("2026-11-02T00:00:00Z"),
            1,
        );
        assert_eq!(iso(runs), ["2026-11-02T14:00:00+00:00"]); // 11월 2일은 이미 EST(UTC-5)
        let utc = next_runs(&s(&["0 9 * * *"]), Some("Mars/Olympus"), None, t("2026-11-02T00:00:00Z"), 1);
        assert_eq!(iso(utc), ["2026-11-02T09:00:00+00:00"]);
    }

    #[test]
    fn several_schedules_merge_in_order_without_duplicates() {
        let runs = next_runs(&s(&["0 */6 * * *", "0 12 * * *", "not a cron"]), None, None, t("2026-11-02T01:00:00Z"), 4);
        assert_eq!(
            iso(runs),
            [
                "2026-11-02T06:00:00+00:00",
                "2026-11-02T12:00:00+00:00",
                "2026-11-02T18:00:00+00:00",
                "2026-11-03T00:00:00+00:00"
            ]
        );
    }

    #[test]
    fn descriptors_and_robfig_aliases_work() {
        assert_eq!(
            iso(next_runs(&s(&["@hourly"]), None, None, t("2026-11-02T01:20:00Z"), 1)),
            ["2026-11-02T02:00:00+00:00"]
        );
        assert_eq!(
            iso(next_runs(&s(&["@midnight"]), Some("Asia/Seoul"), None, t("2026-11-02T01:20:00Z"), 1)),
            ["2026-11-02T15:00:00+00:00"]
        );
        assert_eq!(
            iso(next_runs(&s(&["@annually"]), None, None, t("2026-11-02T01:20:00Z"), 1)),
            ["2027-01-01T00:00:00+00:00"]
        );
    }

    #[test]
    fn every_counts_from_the_last_run_and_is_missed_once_a_slot_passes_without_a_run() {
        let sched = s(&["@every 10m"]);
        let last = Some(t("2026-11-02T12:00:00Z"));
        assert_eq!(
            iso(next_runs(&sched, None, last, t("2026-11-02T12:05:00Z"), 2)),
            ["2026-11-02T12:10:00+00:00", "2026-11-02T12:20:00+00:00"]
        );
        assert_eq!(
            iso(next_runs(&s(&["@every 1h30m"]), None, None, t("2026-11-02T12:00:00Z"), 1)),
            ["2026-11-02T13:30:00+00:00"]
        );
        assert!(!missed(&sched, None, false, last, None, Some(60), t("2026-11-02T12:10:59Z")));
        assert!(missed(&sched, None, false, last, None, Some(60), t("2026-11-02T12:11:00Z")));
        assert!(next_runs(&s(&["@every soon"]), None, last, t("2026-11-02T12:05:00Z"), 1).is_empty());
    }

    #[test]
    fn missed_needs_the_grace_period_to_pass_and_the_run_to_be_absent() {
        let sched = s(&["30 19 * * *"]);
        let tz = Some("Asia/Seoul");
        let created = Some(t("2026-10-01T00:00:00Z"));
        // 직전 예정은 11-02 10:30Z. 그 실행이 있었으면 놓치지 않았다
        assert!(!missed(
            &sched,
            tz,
            false,
            Some(t("2026-11-02T10:30:00Z")),
            created,
            Some(300),
            t("2026-11-02T12:00:00Z")
        ));
        // 그 전날 실행이 마지막이면 놓쳤다
        assert!(missed(
            &sched,
            tz,
            false,
            Some(t("2026-11-01T10:30:00Z")),
            created,
            Some(300),
            t("2026-11-02T12:00:00Z")
        ));
        // 기다리는 시간(300초) 안이면 아직 아니다
        assert!(!missed(
            &sched,
            tz,
            false,
            Some(t("2026-11-01T10:30:00Z")),
            created,
            Some(300),
            t("2026-11-02T10:34:59Z")
        ));
        assert!(missed(
            &sched,
            tz,
            false,
            Some(t("2026-11-01T10:30:00Z")),
            created,
            Some(300),
            t("2026-11-02T10:35:00Z")
        ));
        // 정지됐으면 놓치지 않는다
        assert!(!missed(
            &sched,
            tz,
            true,
            Some(t("2026-11-01T10:30:00Z")),
            created,
            Some(300),
            t("2026-11-02T12:00:00Z")
        ));
    }

    #[test]
    fn a_cron_that_never_ran_is_missed_only_if_it_existed_before_the_last_slot() {
        let sched = s(&["0 * * * *"]);
        let now = t("2026-11-02T12:30:00Z");
        assert!(!missed(&sched, None, false, None, Some(t("2026-11-02T12:10:00Z")), None, now));
        assert!(missed(&sched, None, false, None, Some(t("2026-11-02T11:10:00Z")), None, now));
    }
}
