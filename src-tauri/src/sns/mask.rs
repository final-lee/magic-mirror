/// 색인에 저장할 개인 엔드포인트를 가린다.
pub fn endpoint(protocol: &str, value: &str) -> String {
    match protocol {
        "email" | "email-json" => match value.split_once('@') {
            Some((local, domain)) => format!("{}***@{}", local.chars().next().unwrap_or('*'), domain),
            None => "***".into(),
        },
        "sms" => {
            let chars: Vec<char> = value.chars().collect();
            if chars.len() <= 4 { return "******".into(); }
            let prefix: String = if value.starts_with('+') && chars.len() > 7 { chars.iter().take(3).collect() } else { String::new() };
            let suffix: String = chars.iter().skip(chars.len() - 4).collect();
            format!("{prefix}******{suffix}")
        }
        _ => value.to_owned(),
    }
}
#[cfg(test)]
mod tests;
