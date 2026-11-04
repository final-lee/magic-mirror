use super::*;

fn range(id: &str, cidrs: &[&str]) -> SubnetRange {
    SubnetRange { id: id.into(), cidrs: cidrs.iter().map(|c| Cidr::parse(c).unwrap()).collect() }
}

fn ip(text: &str) -> IpAddr {
    text.parse().unwrap()
}

#[test]
fn a_cidr_contains_its_first_and_last_address_but_not_the_neighbours() {
    let c = Cidr::parse("10.0.1.0/24").unwrap();
    assert!(c.contains(ip("10.0.1.0")));
    assert!(c.contains(ip("10.0.1.255")));
    assert!(!c.contains(ip("10.0.0.255")));
    assert!(!c.contains(ip("10.0.2.0")));
}

#[test]
fn host_bits_in_the_text_are_cleared() {
    // 10.0.1.77/24는 10.0.1.0/24와 같다
    assert_eq!(Cidr::parse("10.0.1.77/24"), Cidr::parse("10.0.1.0/24"));
    assert!(Cidr::parse("10.0.1.77/24").unwrap().contains(ip("10.0.1.3")));
}

#[test]
fn prefix_zero_and_thirty_two_are_the_extremes() {
    assert!(Cidr::parse("0.0.0.0/0").unwrap().contains(ip("203.0.113.9")));
    let one = Cidr::parse("10.0.1.5/32").unwrap();
    assert!(one.contains(ip("10.0.1.5")));
    assert!(!one.contains(ip("10.0.1.6")));
}

#[test]
fn malformed_text_is_rejected() {
    for bad in ["", "10.0.0.0", "10.0.0.0/33", "10.0.0.0/-1", "10.0.0/24", "x/24", "10.0.0.0/", "2600::/129"] {
        assert_eq!(Cidr::parse(bad), None, "{bad}");
    }
}

#[test]
fn ipv4_and_ipv6_never_match_each_other() {
    let v6 = Cidr::parse("2600:1f13:abc::/64").unwrap();
    assert!(v6.contains(ip("2600:1f13:abc::7")));
    assert!(!v6.contains(ip("2600:1f13:abd::7")));
    assert!(!v6.contains(ip("10.0.0.1")));
    assert!(!Cidr::parse("0.0.0.0/0").unwrap().contains(ip("::1")));
    // /0은 v6 전체
    assert!(Cidr::parse("::/0").unwrap().contains(ip("fe80::1")));
}

#[test]
fn capacity_subtracts_the_five_reserved_addresses() {
    assert_eq!(Cidr::parse("10.0.0.0/24").unwrap().capacity(), Some(251));
    assert_eq!(Cidr::parse("10.0.0.0/28").unwrap().capacity(), Some(11));
    assert_eq!(Cidr::parse("10.0.0.0/16").unwrap().capacity(), Some(65_531));
    // /30, /31, /32는 예약분이 더 크거나 같아 0이다
    assert_eq!(Cidr::parse("10.0.0.0/30").unwrap().capacity(), Some(0));
    assert_eq!(Cidr::parse("10.0.0.0/32").unwrap().capacity(), Some(0));
    assert_eq!(Cidr::parse("10.0.0.0/0").unwrap().capacity(), Some((1u64 << 32) - 5));
    assert_eq!(Cidr::parse("2600::/64").unwrap().capacity(), None);
}

#[test]
fn a_pod_ip_belongs_to_the_subnet_that_contains_it() {
    let subnets = [range("subnet-a", &["10.0.0.0/24"]), range("subnet-b", &["10.0.1.0/24"])];
    assert_eq!(subnet_of("10.0.1.200", &subnets), Some("subnet-b"));
    assert_eq!(subnet_of(" 10.0.0.9 ", &subnets), Some("subnet-a"));
    assert_eq!(subnet_of("10.0.2.1", &subnets), None);
    assert_eq!(subnet_of("not-an-ip", &subnets), None);
}

#[test]
fn overlapping_ranges_resolve_to_the_longest_prefix() {
    let subnets = [range("wide", &["10.0.0.0/16"]), range("narrow", &["10.0.1.0/24"])];
    assert_eq!(subnet_of("10.0.1.4", &subnets), Some("narrow"));
    assert_eq!(subnet_of("10.0.9.4", &subnets), Some("wide"));
}

#[test]
fn a_subnet_with_secondary_and_ipv6_ranges_matches_any_of_them() {
    let subnets = [range("subnet-a", &["10.0.0.0/24", "100.64.0.0/20", "2600:1f13::/64"])];
    assert_eq!(subnet_of("100.64.3.1", &subnets), Some("subnet-a"));
    assert_eq!(subnet_of("2600:1f13::5", &subnets), Some("subnet-a"));
}

#[test]
fn counting_separates_subnets_and_outsiders() {
    let subnets = [range("subnet-a", &["10.0.0.0/24"]), range("subnet-b", &["10.0.1.0/24"])];
    let ips = ["10.0.0.1", "10.0.0.2", "10.0.1.9", "192.168.0.1", "garbage"];
    let (counts, outside) = count_by_subnet(ips.iter().copied(), &subnets);
    assert_eq!(counts.get("subnet-a"), Some(&2));
    assert_eq!(counts.get("subnet-b"), Some(&1));
    assert_eq!(outside, 2);
    assert_eq!(count_by_subnet([].into_iter(), &subnets), (HashMap::new(), 0));
}
