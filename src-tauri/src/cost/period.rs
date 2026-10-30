//! UTC 날짜와 기간 규칙. 순수 함수는 오늘 날짜(`today`)를 인자로 받아서 고정 날짜로 테스트할 수 있다.
//! 날짜 계산은 Howard Hinnant의 `days_from_civil`/`civil_from_days`를 쓴다(새 크레이트 없이).

use std::fmt;

use super::model::{CostPeriod, Granularity};

const DAY_SECS: i64 = 86_400;

/// 그레고리력 날짜(UTC).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Ymd {
    pub y: i32,
    pub m: u32,
    pub d: u32,
}

fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = i64::from(y) - i64::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = i64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> Ymd {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    Ymd { y: y as i32, m, d }
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

impl Ymd {
    /// 유닉스 초 → 그 순간의 UTC 날짜.
    pub fn from_unix(secs: i64) -> Ymd {
        civil_from_days(secs.div_euclid(DAY_SECS))
    }

    /// `YYYY-MM-DD`. 없는 날짜(2월 30일 등)나 다른 모양이면 None.
    pub fn parse(s: &str) -> Option<Ymd> {
        let b = s.as_bytes();
        if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
            return None;
        }
        let digits = |r: std::ops::Range<usize>| s.get(r).filter(|t| t.bytes().all(|c| c.is_ascii_digit())).and_then(|t| t.parse::<u32>().ok());
        let (y, m, d) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
        let y = y as i32;
        if !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) {
            return None;
        }
        Some(Ymd { y, m, d })
    }

    fn days(self) -> i64 {
        days_from_civil(self.y, self.m, self.d)
    }

    pub fn add_days(self, n: i64) -> Ymd {
        civil_from_days(self.days() + n)
    }

    pub fn first_of_month(self) -> Ymd {
        Ymd { d: 1, ..self }
    }

    /// 달을 더한다. 1일에만 쓰므로 일은 1로 둔다.
    pub fn add_months(self, n: i32) -> Ymd {
        let index = self.y * 12 + self.m as i32 - 1 + n;
        Ymd { y: index.div_euclid(12), m: index.rem_euclid(12) as u32 + 1, d: 1 }
    }

    /// `2026-10`
    pub fn year_month(self) -> String {
        format!("{:04}-{:02}", self.y, self.m)
    }

    /// 두 날짜 사이의 날 수(`other - self`).
    pub fn days_until(self, other: Ymd) -> i64 {
        other.days() - self.days()
    }
}

impl fmt::Display for Ymd {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.y, self.m, self.d)
    }
}

/// 한 기간의 조회 범위. 모두 `[시작, 끝)`이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ranges {
    /// 보여줄 범위. 이번 달 1일에는 아직 데이터가 없어서 None이다.
    pub current: Option<(Ymd, Ymd)>,
    pub compare: Option<(Ymd, Ymd)>,
    /// 월말 예상 범위(이번 달에서만)
    pub forecast: Option<(Ymd, Ymd)>,
    pub granularity: Granularity,
}

pub fn ranges(period: CostPeriod, today: Ymd) -> Ranges {
    let this = today.first_of_month();
    let prev = this.add_months(-1);
    match period {
        CostPeriod::ThisMonth => {
            let current = (today.d > 1).then_some((this, today));
            // 지난달 1일부터 같은 날 수만큼. 지난달이 더 짧으면 지난달 말일까지.
            let compare_end = prev.add_days(i64::from(today.d) - 1).min(this);
            let compare = current.map(|_| (prev, compare_end));
            Ranges { current, compare, forecast: Some((today, this.add_months(1))), granularity: Granularity::Daily }
        }
        CostPeriod::LastMonth => Ranges {
            current: Some((prev, this)),
            compare: Some((prev.add_months(-1), prev)),
            forecast: None,
            granularity: Granularity::Daily,
        },
        CostPeriod::Last30Days => Ranges {
            current: Some((today.add_days(-30), today)),
            compare: Some((today.add_days(-60), today.add_days(-30))),
            forecast: None,
            granularity: Granularity::Daily,
        },
        CostPeriod::Last6Months => Ranges {
            // 1일에는 끝이 이번 달 1일이라 지난 다섯 달만 나온다
            current: Some((this.add_months(-5), today)),
            compare: None,
            forecast: None,
            granularity: Granularity::Monthly,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ymd(s: &str) -> Ymd {
        Ymd::parse(s).unwrap()
    }

    fn pair(a: &str, b: &str) -> Option<(Ymd, Ymd)> {
        Some((ymd(a), ymd(b)))
    }

    #[test]
    fn unix_seconds_map_to_utc_dates() {
        assert_eq!(Ymd::from_unix(0), ymd("1970-01-01"));
        assert_eq!(Ymd::from_unix(-1), ymd("1969-12-31"));
        assert_eq!(Ymd::from_unix(951_782_400), ymd("2000-02-29")); // 2000-02-29T00:00:00Z
        assert_eq!(Ymd::from_unix(1_798_761_599), ymd("2026-12-31")); // 2026-12-31T23:59:59Z
        assert_eq!(Ymd::from_unix(1_798_761_600), ymd("2027-01-01"));
    }

    #[test]
    fn days_move_across_month_year_and_leap_days() {
        assert_eq!(ymd("2026-10-31").add_days(1), ymd("2026-11-01"));
        assert_eq!(ymd("2026-12-31").add_days(1), ymd("2027-01-01"));
        assert_eq!(ymd("2028-02-28").add_days(1), ymd("2028-02-29"));
        assert_eq!(ymd("2026-02-28").add_days(1), ymd("2026-03-01"));
        assert_eq!(ymd("2026-03-01").add_days(-1), ymd("2026-02-28"));
        assert_eq!(ymd("2026-10-30").add_days(-60), ymd("2026-08-31"));
        assert_eq!(ymd("2026-10-01").days_until(ymd("2026-10-30")), 29);
    }

    #[test]
    fn months_move_across_years() {
        assert_eq!(ymd("2026-03-01").add_months(-5), ymd("2025-10-01"));
        assert_eq!(ymd("2026-12-01").add_months(1), ymd("2027-01-01"));
        assert_eq!(ymd("2026-01-01").add_months(-1), ymd("2025-12-01"));
        assert_eq!(ymd("2026-10-30").year_month(), "2026-10");
    }

    #[test]
    fn parse_accepts_only_real_dates_and_display_round_trips() {
        for bad in ["2026-13-01", "2026-02-30", "2026-00-10", "2026-04-31", "26-1-1", "", "2026/10/30", "2026-1a-01", "+026-10-30"] {
            assert_eq!(Ymd::parse(bad), None, "{bad}");
        }
        assert_eq!(Ymd::parse("2028-02-29").map(|d| d.to_string()), Some("2028-02-29".to_string()));
        assert_eq!(ymd("2026-03-05").to_string(), "2026-03-05");
    }

    #[test]
    fn this_month_compares_with_the_same_days_of_last_month_and_forecasts_to_month_end() {
        let r = ranges(CostPeriod::ThisMonth, ymd("2026-10-30"));
        assert_eq!(r.current, pair("2026-10-01", "2026-10-30"));
        assert_eq!(r.compare, pair("2026-09-01", "2026-09-30"));
        assert_eq!(r.forecast, pair("2026-10-30", "2026-11-01"));
        assert_eq!(r.granularity, Granularity::Daily);
    }

    #[test]
    fn this_month_compare_stops_at_the_end_of_a_shorter_month() {
        let r = ranges(CostPeriod::ThisMonth, ymd("2026-03-31"));
        assert_eq!(r.current, pair("2026-03-01", "2026-03-31"));
        assert_eq!(r.compare, pair("2026-02-01", "2026-03-01"));
    }

    #[test]
    fn this_month_on_the_first_has_nothing_to_show_but_still_forecasts() {
        let r = ranges(CostPeriod::ThisMonth, ymd("2026-10-01"));
        assert_eq!((r.current, r.compare), (None, None));
        assert_eq!(r.forecast, pair("2026-10-01", "2026-11-01"));
    }

    #[test]
    fn last_month_crosses_the_year() {
        let r = ranges(CostPeriod::LastMonth, ymd("2026-01-15"));
        assert_eq!(r.current, pair("2025-12-01", "2026-01-01"));
        assert_eq!(r.compare, pair("2025-11-01", "2025-12-01"));
        assert_eq!(r.forecast, None);
    }

    #[test]
    fn last_30_days_compares_with_the_30_days_before() {
        let r = ranges(CostPeriod::Last30Days, ymd("2026-10-30"));
        assert_eq!(r.current, pair("2026-09-30", "2026-10-30"));
        assert_eq!(r.compare, pair("2026-08-31", "2026-09-30"));
        assert_eq!(r.granularity, Granularity::Daily);
    }

    #[test]
    fn last_6_months_is_monthly_without_compare() {
        let r = ranges(CostPeriod::Last6Months, ymd("2026-10-30"));
        assert_eq!(r.current, pair("2026-05-01", "2026-10-30"));
        assert_eq!((r.compare, r.forecast), (None, None));
        assert_eq!(r.granularity, Granularity::Monthly);
        // 1일에는 끝이 이번 달 1일이라 지난 다섯 달만 나온다
        let first = ranges(CostPeriod::Last6Months, ymd("2026-10-01"));
        assert_eq!(first.current, pair("2026-05-01", "2026-10-01"));
    }
}
