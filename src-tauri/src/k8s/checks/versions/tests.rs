use super::*;

fn api(version: &str, end: Option<i64>) -> VersionSupport {
    VersionSupport { version: version.into(), end_of_standard_support: end }
}

#[test]
fn epoch_of_matches_known_dates_including_leap_days_and_the_epoch_itself() {
    assert_eq!(epoch_of(1970, 1, 1), 0);
    assert_eq!(epoch_of(2000, 3, 1), 951_868_800);
    // 2024는 윤년이라 2월 29일이 있고 3월 1일은 그 하루 뒤다
    assert_eq!(epoch_of(2024, 2, 29), 1_709_164_800);
    assert_eq!(epoch_of(2024, 3, 1) - epoch_of(2024, 2, 29), SECONDS_PER_DAY);
    assert_eq!(epoch_of(2023, 3, 1) - epoch_of(2023, 2, 28), SECONDS_PER_DAY);
}

#[test]
fn the_api_date_wins_over_the_table() {
    let (end, source) = standard_support_end("1.30", &[api("1.30", Some(42))]).unwrap();
    assert_eq!((end, source), (42, Source::Api));
}

#[test]
fn the_table_covers_versions_the_api_does_not_return_or_returns_without_a_date() {
    let table = epoch_of(2025, 7, 23);
    assert_eq!(standard_support_end("1.30", &[]), Some((table, Source::Table)));
    assert_eq!(standard_support_end("1.30", &[api("1.29", Some(1))]), Some((table, Source::Table)));
    assert_eq!(standard_support_end("1.30", &[api("1.30", None)]), Some((table, Source::Table)));
}

#[test]
fn a_version_unknown_to_both_has_no_date() {
    assert_eq!(standard_support_end("1.99", &[api("1.30", Some(1))]), None);
}

#[test]
fn table_dates_increase_with_the_version() {
    let ends: Vec<i64> = STANDARD_SUPPORT_END.iter().map(|(_, (y, m, d))| epoch_of(*y, *m, *d)).collect();
    assert!(ends.windows(2).all(|w| w[0] < w[1]), "표가 버전 순서대로 늘어나야 해요");
}
