use super::*;

#[test]
fn cpu_in_millicores() {
    for (q, want) in [("100m", 100), ("2", 2000), ("0.5", 500), ("1500000n", 2), ("250u", 1), ("1.25", 1250)] {
        assert_eq!(cpu_milli(q), Some(want), "{q}");
    }
    assert_eq!(cpu_milli("x"), None);
    assert_eq!(cpu_milli(""), None);
}

#[test]
fn memory_in_bytes() {
    for (q, want) in [("128Mi", 134_217_728), ("1G", 1_000_000_000), ("1000k", 1_000_000), ("123", 123), ("1e3", 1000), ("1.5Gi", 1_610_612_736), ("2Ki", 2048)] {
        assert_eq!(bytes(q), Some(want), "{q}");
    }
    assert_eq!(bytes("Mi"), None);
}

#[test]
fn exact_rounding_and_saturation() {
    for (q, b, cpu) in [
        ("1n", 1, 1), ("1u", 1, 1), ("999n", 1, 1),
        ("1e-9", 1, 1), ("0.5", 1, 500),
        ("1.5Gi", 1_610_612_736, 1_610_612_736_000),
        ("1e3", 1000, 1_000_000), ("1E3", 1000, 1_000_000),
        ("1Ei", 1_152_921_504_606_846_976, i64::MAX),
        ("0", 0, 0), ("1e100", i64::MAX, i64::MAX),
        ("9223372036854775807.0001", i64::MAX, i64::MAX),
        ("-1n", 0, 0), ("-1.5", -1, -1500),
    ] {
        assert_eq!(bytes(q), Some(b), "bytes {q}");
        assert_eq!(cpu_milli(q), Some(cpu), "cpu {q}");
    }
}
