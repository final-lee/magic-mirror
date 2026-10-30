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
