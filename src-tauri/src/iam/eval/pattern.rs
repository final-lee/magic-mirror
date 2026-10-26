//! 리소스 패턴(`*`, `?`) 두 개를 견주는 코드. Deny가 Allow를 덮는지, 경계가 신원 정책의 범위를 얼마나 남기는지 따질 때 쓴다.

use crate::iam::policy::glob;

/// 패턴 `d`가 패턴 `g`가 가리키는 리소스를 모두 포함하는지. `d`를 `g` 글자 그대로에 glob으로 맞춰 보는
/// 보수적인 판정이다(`?`가 든 `d`는 따지지 않는다).
pub(super) fn pattern_covers(d: &str, g: &str) -> bool {
    !d.contains('?') && glob(d, g, false)
}

/// 두 패턴에 함께 맞는 글자열이 있는지. 대소문자를 구분한다. 정책 변수(`${…}`)가 든 패턴은 값을 모르니 겹칠 수 있다고 본다.
pub(super) fn patterns_overlap(a: &str, b: &str) -> bool {
    if a.contains("${") || b.contains("${") {
        return true;
    }
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let width = b.len() + 1;
    // reach[i * width + j]: a의 앞 i개와 b의 앞 j개를 같은 글자열로 맞출 수 있다
    let mut reach = vec![false; (a.len() + 1) * width];
    reach[0] = true;
    for i in 0..=a.len() {
        for j in 0..=b.len() {
            if !reach[i * width + j] {
                continue;
            }
            let (pa, pb) = (a.get(i).copied(), b.get(j).copied());
            // 별은 아무 글자도 맞추지 않고 넘어갈 수 있다
            if pa == Some('*') {
                reach[(i + 1) * width + j] = true;
            }
            if pb == Some('*') {
                reach[i * width + j + 1] = true;
            }
            match (pa, pb) {
                (Some('*'), Some('*')) | (None, _) | (_, None) => {}
                // 한쪽 별이 다른 쪽 패턴이 맞추는 글자 하나를 삼킨다
                (Some('*'), Some(_)) => reach[i * width + j + 1] = true,
                (Some(_), Some('*')) => reach[(i + 1) * width + j] = true,
                (Some(x), Some(y)) if x == y || x == '?' || y == '?' => reach[(i + 1) * width + j + 1] = true,
                _ => {}
            }
        }
    }
    reach[a.len() * width + b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_is_a_literal_glob_match_of_the_narrower_pattern() {
        assert!(pattern_covers("*", "arn:aws:s3:::b/x"));
        assert!(pattern_covers("arn:aws:s3:::team-*", "arn:aws:s3:::team-a/*"));
        assert!(pattern_covers("arn:aws:s3:::b*", "arn:aws:s3:::b"));
        assert!(pattern_covers("arn:aws:s3:::b/*", "arn:aws:s3:::b/x*"));
        assert!(!pattern_covers("arn:aws:s3:::b/x*", "arn:aws:s3:::b/*"));
        assert!(!pattern_covers("arn:aws:s3:::a/*", "arn:aws:s3:::b/*"));
        // `?`가 든 쪽은 따지지 않는다
        assert!(!pattern_covers("arn:aws:s3:::b?", "arn:aws:s3:::b1"));
        // 대소문자를 구분한다
        assert!(!pattern_covers("arn:aws:s3:::B*", "arn:aws:s3:::b1"));
    }

    #[test]
    fn overlap_examples() {
        assert!(patterns_overlap("*", "arn:aws:s3:::b"));
        assert!(patterns_overlap("arn:aws:s3:::b", "arn:aws:s3:::b"));
        assert!(patterns_overlap("arn:aws:s3:::team-*", "arn:aws:s3:::*-prod/*"));
        assert!(patterns_overlap("a/*", "a/b/*"));
        assert!(patterns_overlap("a?c", "?bc"));
        assert!(patterns_overlap("a*", "*b"));
        assert!(patterns_overlap("*", ""));
        assert!(!patterns_overlap("a/*", "b/*"));
        assert!(!patterns_overlap("other/*", "allowed/*"));
        assert!(!patterns_overlap("arn:aws:s3:::a", "arn:aws:s3:::b"));
        assert!(!patterns_overlap("a*c", "b*"));
        assert!(!patterns_overlap("a?", "b"));
        assert!(!patterns_overlap("?", ""));
        assert!(!patterns_overlap("ab", "a"));
        assert!(!patterns_overlap("a*z", "a*y"));
        // 대소문자를 구분한다
        assert!(!patterns_overlap("A*", "a*"));
        // 한글도 한 글자다
        assert!(patterns_overlap("가?", "가나"));
        assert!(!patterns_overlap("가?", "가"));
    }

    #[test]
    fn policy_variables_may_overlap_with_anything() {
        assert!(patterns_overlap("arn:aws:s3:::${aws:username}/*", "arn:aws:s3:::home/*"));
        assert!(patterns_overlap("x", "${aws:username}"));
    }

    /// 짧은 패턴·글자열을 모두 늘어놓고 `glob`과 견준다: 함께 맞는 글자열이 있으면 겹친다.
    #[test]
    fn overlap_agrees_with_brute_force_on_a_tiny_alphabet() {
        fn all_strings(alphabet: &[char], max_len: usize) -> Vec<String> {
            let mut out = vec![String::new()];
            let mut layer = vec![String::new()];
            for _ in 0..max_len {
                layer = layer.iter().flat_map(|s| alphabet.iter().map(move |c| format!("{s}{c}"))).collect();
                out.extend(layer.iter().cloned());
            }
            out
        }
        // 패턴 쪽 글자는 a, b, *, ?; 글자열에는 "그 밖의 글자" c도 넣는다. 가장 짧은 증거는 두 패턴 길이의 합 이하다
        let patterns = all_strings(&['a', 'b', '*', '?'], 3);
        let strings = all_strings(&['a', 'b', 'c'], 6);
        let matches: Vec<Vec<bool>> = patterns.iter().map(|p| strings.iter().map(|s| glob(p, s, false)).collect()).collect();
        for (i, a) in patterns.iter().enumerate() {
            for (j, b) in patterns.iter().enumerate() {
                let witness = matches[i].iter().zip(&matches[j]).any(|(x, y)| *x && *y);
                assert_eq!(patterns_overlap(a, b), witness, "{a:?} vs {b:?}");
            }
        }
        assert_eq!(patterns.len(), 85);
    }
}
