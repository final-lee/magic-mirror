//! 화면에 나가는 문구 도우미.

/// 이름을 `shown`개까지만 보여 주고 나머지는 "외 N개"로 줄인다.
pub fn shortened(names: &[String], shown: usize) -> String {
    match names.len().checked_sub(shown) {
        Some(rest) if rest > 0 => format!("{} 외 {rest}개", names[..shown].join(", ")),
        _ => names.join(", "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn shows_everything_up_to_the_limit_and_counts_the_rest() {
        assert_eq!(shortened(&[], 3), "");
        assert_eq!(shortened(&names(&["a"]), 3), "a");
        assert_eq!(shortened(&names(&["a", "b", "c"]), 3), "a, b, c");
        assert_eq!(shortened(&names(&["a", "b", "c", "d"]), 3), "a, b, c 외 1개");
        assert_eq!(shortened(&names(&["a", "b", "c", "d", "e"]), 3), "a, b, c 외 2개");
        assert_eq!(shortened(&names(&["a", "b"]), 1), "a 외 1개");
    }
}
