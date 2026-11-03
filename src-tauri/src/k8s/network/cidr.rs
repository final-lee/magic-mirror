//! IP·CIDR 계산: Pod IP가 어느 서브넷에 속하는지, 서브넷에서 쓸 수 있는 주소 수. 순수 함수만 둔다.
use std::collections::HashMap;
use std::net::IpAddr;

/// AWS가 서브넷마다 예약하는 IPv4 주소 수(네트워크, VPC 라우터, DNS, 예비, 브로드캐스트)
pub const RESERVED_IPV4: u64 = 5;

/// 호스트 비트를 지운 네트워크 주소와 접두 길이. IPv4와 IPv6를 함께 다룬다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    network: u128,
    prefix: u8,
    v6: bool,
}

fn bits(ip: IpAddr) -> (u128, bool) {
    match ip {
        IpAddr::V4(v4) => (u128::from(u32::from(v4)), false),
        IpAddr::V6(v6) => (u128::from(v6), true),
    }
}

fn mask(prefix: u8, width: u8) -> u128 {
    if prefix == 0 {
        return 0;
    }
    let all = if width == 128 { u128::MAX } else { (1u128 << width) - 1 };
    all & !all.checked_shr(u32::from(prefix)).unwrap_or(0)
}

impl Cidr {
    /// `10.0.0.0/24`, `2600:1f13::/64`. 접두 길이가 없거나 범위를 벗어나면 None이다. 호스트 비트는 지운다.
    pub fn parse(text: &str) -> Option<Cidr> {
        let (addr, prefix) = text.trim().split_once('/')?;
        let (value, v6) = bits(addr.parse().ok()?);
        let width: u8 = if v6 { 128 } else { 32 };
        let prefix: u8 = prefix.parse().ok().filter(|p| *p <= width)?;
        Some(Cidr { network: value & mask(prefix, width), prefix, v6 })
    }

    pub fn prefix(&self) -> u8 {
        self.prefix
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        let (value, v6) = bits(ip);
        let width: u8 = if v6 { 128 } else { 32 };
        v6 == self.v6 && value & mask(self.prefix, width) == self.network
    }

    /// IPv4 서브넷에서 쓸 수 있는 주소 수(예약분을 뺀다). IPv6는 None이다.
    pub fn capacity(&self) -> Option<u64> {
        if self.v6 {
            return None;
        }
        Some((1u64 << (32 - self.prefix)).saturating_sub(RESERVED_IPV4))
    }
}

/// 서브넷 하나와 그 CIDR들(IPv4 하나와 IPv6 몇 개까지 있을 수 있다)
#[derive(Debug, Clone, PartialEq)]
pub struct SubnetRange {
    pub id: String,
    pub cidrs: Vec<Cidr>,
}

/// 가장 긴 접두에 맞는 서브넷(서브넷끼리는 겹치지 않지만 입력이 겹쳐도 하나로 정한다). 어디에도 없으면 None.
pub fn subnet_of<'a>(ip: &str, subnets: &'a [SubnetRange]) -> Option<&'a str> {
    let ip: IpAddr = ip.trim().parse().ok()?;
    subnets
        .iter()
        .filter_map(|s| s.cidrs.iter().filter(|c| c.contains(ip)).map(Cidr::prefix).max().map(|p| (p, s.id.as_str())))
        .max_by_key(|(p, _)| *p)
        .map(|(_, id)| id)
}

/// 서브넷별 IP 수와, 어느 서브넷에도 속하지 않은(또는 IP가 아닌) 수
pub fn count_by_subnet<'a>(ips: impl Iterator<Item = &'a str>, subnets: &[SubnetRange]) -> (HashMap<String, usize>, usize) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut outside = 0;
    for ip in ips {
        match subnet_of(ip, subnets) {
            Some(id) => *counts.entry(id.to_string()).or_default() += 1,
            None => outside += 1,
        }
    }
    (counts, outside)
}

#[cfg(test)]
mod tests;
