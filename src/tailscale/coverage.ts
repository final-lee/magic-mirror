import * as text from "./devicesText";

export const EXIT_ROUTES = ["0.0.0.0/0", "::/0"];
export const isExitRoute = (route: string) => EXIT_ROUTES.includes(route);

type Interval = [number, number];
function interval(cidr: string): Interval | null {
  const parts = cidr.split("/");
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return null;
  const prefix = Number(parts[1]);
  const octets = parts[0].split(".");
  if (prefix > 32 || octets.length !== 4 || octets.some((s) => !/^\d+$/.test(s) || Number(s) > 255)) return null;
  const ip = octets.reduce((n, s) => n * 256 + Number(s), 0);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ip / size) * size;
  return [start, start + size - 1];
}
/** 승인된 서브넷 경로의 합집합으로 VPC 전체가 덮이는지 살핀다. Exit node, IPv6와 잘못된 경로는 제외한다. */
export function coverage(cidr: string, routes: string[]): string {
  const target = interval(cidr);
  if (!target) return text.COVERAGE_NONE;
  const ranges = routes.filter((route) => !isExitRoute(route)).map(interval)
    .filter((r): r is Interval => r !== null && r[1] >= target[0] && r[0] <= target[1])
    .sort((a, b) => a[0] - b[0]);
  if (!ranges.length) return text.COVERAGE_NONE;
  let next = target[0];
  for (const [start, end] of ranges) {
    if (start > next) return text.COVERAGE_PARTIAL;
    next = Math.max(next, end + 1);
    if (next > target[1]) return text.COVERAGE_FULL;
  }
  return text.COVERAGE_PARTIAL;
}
