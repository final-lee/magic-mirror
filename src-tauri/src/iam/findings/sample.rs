//! 테스트용 자격 증명 보고서. 날짜는 기준 시각 `now()`에서 며칠 전인지로 만들어서 고정된 날짜로 규칙을 확인할 수 있다.

use crate::iam::clock::{iso, parse_iso, DAY_SECS};

pub const HEADER: &str = "user,arn,user_creation_time,password_enabled,password_last_used,password_last_changed,password_next_rotation,mfa_active,access_key_1_active,access_key_1_last_rotated,access_key_1_last_used_date,access_key_1_last_used_region,access_key_1_last_used_service,access_key_2_active,access_key_2_last_rotated,access_key_2_last_used_date,access_key_2_last_used_region,access_key_2_last_used_service,cert_1_active,cert_1_last_rotated,cert_2_active,cert_2_last_rotated";

pub const ROOT_ARN: &str = "arn:aws:iam::111111111111:root";

pub fn now() -> i64 {
    parse_iso("2026-10-26T00:00:00Z").unwrap()
}

/// 자격 증명 보고서 형식(`+00:00`)으로 쓴 `days`일 전 시각.
pub fn ago(days: i64) -> String {
    iso(now() - days * DAY_SECS).replace('Z', "+00:00")
}

pub fn na() -> String {
    "N/A".to_string()
}

/// 키 한 개: (활성 여부, 마지막 교체, 마지막 사용)
pub type Key = (&'static str, String, String);

pub fn no_key() -> Key {
    ("false", na(), na())
}

/// 보고서 한 줄. 비밀번호 열은 (활성 여부, 마지막 사용)이다.
pub fn line(user: &str, arn: &str, created: String, password: (&str, String), mfa: &str, key1: Key, key2: Key) -> String {
    let (password_enabled, password_used) = password;
    let (a1, r1, u1) = key1;
    let (a2, r2, u2) = key2;
    let place = |used: &str| if used == "N/A" { ("N/A", "N/A") } else { ("us-east-1", "s3") };
    let ((region1, service1), (region2, service2)) = (place(&u1), place(&u2));
    format!(
        "{user},{arn},{created},{password_enabled},{password_used},N/A,N/A,{mfa},{a1},{r1},{u1},{region1},{service1},{a2},{r2},{u2},{region2},{service2},false,N/A,false,N/A"
    )
}

pub fn user_arn(name: &str) -> String {
    format!("arn:aws:iam::111111111111:user/{name}")
}

/// 루트 + 사용자 8명. 사용자는 `alice` `bob` `carol`이 테스트 스냅숏에 있고 나머지는 보고서에만 있다.
///
/// | 사용자 | 만든 지 | 비밀번호 | MFA | 키 |
/// |---|---|---|---|---|
/// | root | 3000일 | not_supported | 없음 | 활성, 400일 전 교체, 안 씀 |
/// | alice | 500일 | 2일 전 사용 | 있음 | 활성, 200일 전 교체, 어제 사용 |
/// | bob | 300일 | 10일 전 사용 | 없음 | 활성, 120일 전 교체, 한 번도 안 씀 |
/// | carol | 400일 | 200일 전 사용 | 있음 | 활성, 150일 전 교체, 100일 전 사용 |
/// | dave | 200일 | 없음 | 없음 | 없음 |
/// | erin | 400일 | `no_information` | 있음 | 없음 |
/// | frank | 20일 | 없음 | 없음 | 없음 |
/// | gina | 300일 | 200일 전 사용 | 있음 | 비활성(250일 전 교체), 40일 전 사용 |
pub fn rows() -> Vec<String> {
    let none = || no_key();
    vec![
        line("<root_account>", ROOT_ARN, ago(3000), ("not_supported", ago(5)), "false", ("true", ago(400), na()), none()),
        line("alice", &user_arn("alice"), ago(500), ("true", ago(2)), "true", ("true", ago(200), ago(1)), none()),
        line("bob", &user_arn("bob"), ago(300), ("true", ago(10)), "false", ("true", ago(120), na()), none()),
        line("carol", &user_arn("carol"), ago(400), ("true", ago(200)), "true", ("true", ago(150), ago(100)), none()),
        line("dave", &user_arn("dave"), ago(200), ("false", na()), "false", none(), none()),
        line("erin", &user_arn("erin"), ago(400), ("true", "no_information".to_string()), "true", none(), none()),
        line("frank", &user_arn("frank"), ago(20), ("false", na()), "false", none(), none()),
        line("gina", &user_arn("gina"), ago(300), ("true", ago(200)), "true", ("false", ago(250), ago(40)), none()),
    ]
}

pub fn csv() -> String {
    let mut text = String::from(HEADER);
    for row in rows() {
        text.push('\n');
        text.push_str(&row);
    }
    text.push('\n');
    text
}
