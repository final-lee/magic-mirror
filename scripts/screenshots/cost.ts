// 데모용 비용 명령 흉내. 날짜는 2026-10-30(설계 문서 C0와 같은 날)로 고정해서 스크린샷이 늘 같게 나온다.
import type { BreakdownRow, CostBreakdown, CostOverview, CostQuery } from "../../src/cost/types";

const ACCOUNT = "123456789012";
const FETCHED = new Date(Date.now() - 2 * 3_600_000).toISOString();

// 서비스별 하루 기준 금액
const SERVICES: [string, number][] = [
  ["Amazon Relational Database Service", 9.8],
  ["Amazon Elastic Compute Cloud - Compute", 6.4],
  ["EC2 - Other", 3.1],
  ["Amazon Elastic Container Service for Kubernetes", 2.4],
  ["Amazon Virtual Private Cloud", 1.7],
  ["Claude Sonnet 5 (Amazon Bedrock Edition)", 1.2],
  ["Amazon Simple Storage Service", 0.6],
  ["AWS Secrets Manager", 0.13],
  ["AWS Cost Explorer", 0.03],
  ["Amazon Simple Queue Service", 0.0004],
];
const REGIONS: [string, number][] = [["ap-northeast-2", 0.82], ["us-east-1", 0.14], ["global", 0.04]];
const USAGE: [string, number][] = [["APN2-InstanceUsage", 0.62], ["APN2-Aurora:StorageIOUsage", 0.21], ["APN2-RDS:GP3-Storage", 0.12], ["APN2-RDS:ChargedBackupUsage", 0.05]];
const TAGS: [string, number][] = [["team$platform", 0.55], ["team$api", 0.3], ["team$", 0.15]];

const out = (n: number) => String(Math.round(n * 1e6) / 1e6);
// 날마다 조금씩 다르게(결정적)
const wave = (day: number, k: number) => 1 + 0.18 * Math.sin(day * 0.9 + k * 1.7) + (day % 7 === 5 || day % 7 === 6 ? -0.12 : 0);

function days(start: string, n: number): string[] {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(t0 + i * 86_400_000).toISOString().slice(0, 10));
}

function scale(q: CostQuery): number {
  let s = q.metric === "AmortizedCost" ? 1.04 : 1;
  for (const f of q.filters) {
    if ("tag" in f) s *= TAGS.find(([k]) => k === `${f.tag}$${f.value}`)?.[1] ?? 0.2;
    else if (f.dimension === "REGION") s *= REGIONS.find(([k]) => k === f.value)?.[1] ?? 0.1;
    else if (f.dimension === "USAGE_TYPE") s *= USAGE.find(([k]) => k === f.value)?.[1] ?? 0.1;
  }
  return s;
}

function services(q: CostQuery): [string, number][] {
  const only = q.filters.find((f) => "dimension" in f && f.dimension === "SERVICE")?.value;
  return SERVICES.filter(([name]) => !only || name === only);
}

function ranges(q: CostQuery) {
  switch (q.period) {
    case "thisMonth":
      return { cur: days("2026-10-01", 29), cmp: days("2026-09-01", 29), granularity: "daily" as const };
    case "lastMonth":
      return { cur: days("2026-09-01", 30), cmp: days("2026-08-01", 31), granularity: "daily" as const };
    case "last30Days":
      return { cur: days("2026-09-30", 30), cmp: days("2026-08-31", 30), granularity: "daily" as const };
    case "last6Months":
      return { cur: ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"], cmp: null, granularity: "monthly" as const };
  }
}

const endOf = (d: string[]) => new Date(Date.parse(`${d[d.length - 1]}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function amounts(q: CostQuery, dayList: string[], monthly: boolean, growth: number): Map<string, number[]> {
  const s = scale(q) * growth;
  return new Map(services(q).map(([name, base], k) => [name, dayList.map((_, i) => base * s * wave(i, k) * (monthly ? 30 - (5 - i) * 1.5 : 1))]));
}

function overview(q: CostQuery): CostOverview {
  const r = ranges(q);
  const cur = amounts(q, r.cur, r.granularity === "monthly", 1);
  const totals = [...cur.entries()].map(([name, v]) => [name, v.reduce((a, b) => a + b, 0)] as const).sort((a, b) => b[1] - a[1]);
  const series = totals.slice(0, 5).map(([n]) => n);
  const buckets = r.cur.map((start, i) => {
    const all = [...cur.values()].reduce((a, v) => a + v[i], 0);
    const values = series.map((n) => cur.get(n)![i]);
    return { start, total: out(all), values: values.map(out), other: out(all - values.reduce((a, b) => a + b, 0)) };
  });
  const total = totals.reduce((a, [, v]) => a + v, 0);
  const cmpTotal = r.cmp ? [...amounts(q, r.cmp, false, 0.91).values()].flat().reduce((a, b) => a + b, 0) : null;
  return {
    accountId: ACCOUNT,
    unit: "USD",
    range: { start: r.cur[0], end: r.granularity === "monthly" ? "2026-10-30" : endOf(r.cur) },
    compareRange: r.cmp ? { start: r.cmp[0], end: endOf(r.cmp) } : null,
    granularity: r.granularity,
    total: out(total),
    compareTotal: cmpTotal === null ? null : out(cmpTotal),
    delta: cmpTotal === null ? null : out(total - cmpTotal),
    deltaPct: cmpTotal ? ((total - cmpTotal) / cmpTotal) * 100 : null,
    estimated: q.period === "thisMonth" || q.period === "last30Days" || q.period === "last6Months",
    forecast: q.period === "thisMonth" ? { mean: out((total / 29) * 31), low: out((total / 29) * 30.2), high: out((total / 29) * 31.9) } : null,
    forecastNote: null,
    series,
    buckets,
    fetchedAt: FETCHED,
    requests: 0,
  };
}

function breakdown(q: CostQuery): CostBreakdown {
  const r = ranges(q);
  const sum = (d: string[] | null, growth: number) => (d ? [...amounts(q, d, r.granularity === "monthly", growth).entries()].map(([n, v]) => [n, v.reduce((a, b) => a + b, 0)] as const) : []);
  const split = (pairs: (readonly [string, number])[], parts: [string, number][]) => {
    const all = pairs.reduce((a, [, v]) => a + v, 0);
    return parts.map(([k, share]) => [k, all * share] as const);
  };
  const by = (pairs: (readonly [string, number])[]) =>
    q.groupBy.kind === "service" ? pairs : split(pairs, q.groupBy.kind === "region" ? REGIONS : q.groupBy.kind === "usageType" ? USAGE : TAGS);
  const cur = by(sum(r.cur, 1));
  const cmp = r.cmp ? new Map(by(sum(r.cmp, 0.91))) : null;
  const total = cur.reduce((a, [, v]) => a + v, 0);
  const rows: BreakdownRow[] = [];
  let small = { count: 0, current: 0, previous: 0 };
  for (const [key, v] of [...cur].sort((a, b) => b[1] - a[1])) {
    const p = cmp?.get(key) ?? null;
    if (Math.abs(v) < 0.005 && Math.abs(p ?? 0) < 0.005) {
      small = { count: small.count + 1, current: small.current + v, previous: small.previous + (p ?? 0) };
      continue;
    }
    const label = q.groupBy.kind === "tag" ? key.slice(key.indexOf("$") + 1) || "(태그 없음)" : key;
    rows.push({ key, label, current: out(v), previous: p === null ? null : out(p), delta: p === null ? null : out(v - p), deltaPct: p ? ((v - p) / p) * 100 : null, share: total ? (v / total) * 100 : 0 });
  }
  return {
    unit: "USD",
    rows,
    small: small.count ? { count: small.count, current: out(small.current), previous: cmp ? out(small.previous) : null } : null,
    total: out(total),
    fetchedAt: FETCHED,
    requests: 0,
  };
}

export function costMock(cmd: string, a: Record<string, any>): unknown {
  switch (cmd) {
    case "cost_overview":
      return overview(a.query);
    case "cost_breakdown":
      return breakdown(a.query);
    case "cost_tag_keys":
      return ["env", "team"];
    case "cost_usage":
      return { yearMonth: "2026-10", requests: 17 };
    default:
      return null;
  }
}
