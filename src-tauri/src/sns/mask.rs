/// 색인에 저장할 개인 엔드포인트를 가린다.
pub fn endpoint(protocol: &str, value: &str) -> String {
    match protocol {
        "email" | "email-json" => match value.split_once('@') {
            Some((local, domain)) => {
                format!("{}***@{}", local.chars().next().unwrap_or('*'), domain)
            }
            None => "***".into(),
        },
        "sms" => {
            let chars: Vec<char> = value.chars().collect();
            if chars.len() <= 4 {
                return "******".into();
            }
            let prefix: String = if value.starts_with('+') && chars.len() > 7 {
                chars.iter().take(3).collect()
            } else {
                String::new()
            };
            let suffix: String = chars.iter().skip(chars.len() - 4).collect();
            format!("{prefix}******{suffix}")
        }
        _ => value.to_owned(),
    }
}

/// 값 하나가 이메일 주소처럼 생겼는가(ARN·공백이 든 문장은 아니다)
pub fn looks_like_email(value: &str) -> bool {
    !value.starts_with("arn:") && !value.chars().any(char::is_whitespace) && value.contains('@')
}

/// 값 하나가 국제 전화번호(+와 숫자)처럼 생겼는가
pub fn looks_like_phone(value: &str) -> bool {
    value
        .strip_prefix('+')
        .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
}
#[cfg(test)]
mod tests;
