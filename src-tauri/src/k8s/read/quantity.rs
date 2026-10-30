//! 쿠버네티스 수량 글(`100m`, `1.5Gi`, `2e3`)을 숫자로. CPU는 밀리코어, 메모리는 바이트, 둘 다 올림. 해석하지 못하면 None.

/// 정밀도 손실 없이 십진 자리와 이진 접미사를 적용하고 마지막에만 i64 범위로 제한한다.
fn rounded(q: &str, extra_scale: i64) -> Option<i64> {
    let q = q.trim();
    let (negative, q) = match q.as_bytes().first() {
        Some(b'-') => (true, &q[1..]),
        Some(b'+') => (false, &q[1..]),
        _ => (false, q),
    };
    let mut digits = Vec::new();
    let mut dot = false;
    let mut fractional = 0_i64;
    let mut end = 0;
    for (i, b) in q.bytes().enumerate() {
        match b {
            b'0'..=b'9' => {
                digits.push(b - b'0');
                if dot {
                    fractional = fractional.saturating_add(1);
                }
            }
            b'.' if !dot => dot = true,
            _ => break,
        }
        end = i + 1;
    }
    if digits.is_empty() {
        return None;
    }
    let suffix = &q[end..];
    let (scale, binary) = match suffix {
        "" => (0, 1_u64),
        "n" => (-9, 1), "u" => (-6, 1), "m" => (-3, 1),
        "k" => (3, 1), "M" => (6, 1), "G" => (9, 1),
        "T" => (12, 1), "P" => (15, 1), "E" => (18, 1),
        "Ki" => (0, 1 << 10), "Mi" => (0, 1 << 20),
        "Gi" => (0, 1 << 30), "Ti" => (0, 1 << 40),
        "Pi" => (0, 1 << 50), "Ei" => (0, 1 << 60),
        _ if suffix.starts_with(['e', 'E']) => {
            let exponent = &suffix[1..];
            let (negative_exp, exponent) = match exponent.as_bytes().first() {
                Some(b'-') => (true, &exponent[1..]),
                Some(b'+') => (false, &exponent[1..]),
                _ => (false, exponent),
            };
            if exponent.is_empty() || !exponent.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let n = exponent.bytes().fold(0_i64, |n, b| n.saturating_mul(10).saturating_add(i64::from(b - b'0')));
            (if negative_exp { -n } else { n }, 1)
        }
        _ => return None,
    };
    // 자리 배열을 작은 자리부터 곱해 이진 접미사도 정확히 십진수로 바꾼다.
    digits.reverse();
    let mut carry = 0_u64;
    for d in &mut digits {
        let n = u64::from(*d) * binary + carry;
        *d = (n % 10) as u8;
        carry = n / 10;
    }
    while carry != 0 {
        digits.push((carry % 10) as u8);
        carry /= 10;
    }
    while digits.last() == Some(&0) {
        digits.pop();
    }
    if digits.is_empty() {
        return Some(0);
    }
    let scale = i128::from(scale) - i128::from(fractional) + i128::from(extra_scale);
    let integer_digits = digits.len() as i128 + scale;
    if integer_digits > 19 {
        return Some(if negative { i64::MIN } else { i64::MAX });
    }
    let mut integer = 0_u128;
    for place in (0..integer_digits.max(0) as usize).rev() {
        let index = place as i128 - scale;
        let digit = if index >= 0 && index < digits.len() as i128 { digits[index as usize] } else { 0 };
        integer = integer * 10 + u128::from(digit);
    }
    let fractional_nonzero = scale < 0 && digits.iter().take((-scale).min(digits.len() as i128) as usize).any(|&d| d != 0);
    if !negative && fractional_nonzero {
        integer += 1;
    }
    if negative {
        Some(if integer > i64::MAX as u128 { i64::MIN } else { -(integer as i64) })
    } else {
        Some(integer.min(i64::MAX as u128) as i64)
    }
}

pub fn cpu_milli(q: &str) -> Option<i64> {
    rounded(q, 3)
}

pub fn bytes(q: &str) -> Option<i64> {
    rounded(q, 0)
}

#[cfg(test)]
mod tests;
