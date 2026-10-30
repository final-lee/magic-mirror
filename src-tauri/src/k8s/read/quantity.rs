//! 쿠버네티스 수량 글(`100m`, `1.5Gi`, `2e3`)을 숫자로. CPU는 밀리코어, 메모리는 바이트, 둘 다 올림. 해석하지 못하면 None.

/// 접미사와 배수. 두 글자(이진)를 한 글자보다 먼저 본다.
const SUFFIXES: [(&str, f64); 15] = [
    ("Ki", 1024.0),
    ("Mi", 1_048_576.0),
    ("Gi", 1_073_741_824.0),
    ("Ti", 1_099_511_627_776.0),
    ("Pi", 1_125_899_906_842_624.0),
    ("Ei", 1_152_921_504_606_846_976.0),
    ("n", 1e-9),
    ("u", 1e-6),
    ("m", 1e-3),
    ("k", 1e3),
    ("M", 1e6),
    ("G", 1e9),
    ("T", 1e12),
    ("P", 1e15),
    ("E", 1e18),
];

fn amount(q: &str) -> Option<f64> {
    let q = q.trim();
    let number = |n: &str| n.parse::<f64>().ok().filter(|v| v.is_finite());
    for (suffix, factor) in SUFFIXES {
        if let Some(n) = q.strip_suffix(suffix) {
            return number(n).map(|v| v * factor);
        }
    }
    number(q)
}

pub fn cpu_milli(q: &str) -> Option<i64> {
    amount(q).map(|v| (v * 1000.0 - 1e-9).ceil() as i64)
}

pub fn bytes(q: &str) -> Option<i64> {
    amount(q).map(|v| (v - 1e-9).ceil() as i64)
}

#[cfg(test)]
mod tests;
