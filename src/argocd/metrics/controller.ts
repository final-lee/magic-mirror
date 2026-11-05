import type { ComponentStatus, ControllerScrape, PromSeries } from "./types";

/** 읽기를 이어 붙여 보관하는 최대 개수(30초마다 읽으면 1시간) */
export const HISTORY_POINTS = 120;

export interface Bucket {
  le: number;
  count: number;
}

/**
 * 누적 히스토그램 버킷에서 q분위수(0~1). Prometheus의 histogram_quantile과 같은 규칙: 버킷 안은 선형 보간,
 * 값이 마지막 유한 버킷을 넘으면 그 버킷의 위 경계를 돌려준다. 관측이 없으면 null.
 */
export function quantile(q: number, buckets: Bucket[]): number | null {
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  const total = sorted.length ? sorted[sorted.length - 1].count : 0;
  if (!(total > 0) || sorted[sorted.length - 1].le !== Infinity) return null;
  const rank = Math.min(1, Math.max(0, q)) * total;
  const index = sorted.findIndex((b) => b.count >= rank);
  const bucket = sorted[index];
  if (bucket.le === Infinity) return index > 0 ? sorted[index - 1].le : null;
  const lower = index > 0 ? sorted[index - 1].le : Math.min(0, bucket.le);
  const before = index > 0 ? sorted[index - 1].count : 0;
  const width = bucket.count - before;
  return width <= 0 ? bucket.le : lower + ((bucket.le - lower) * (rank - before)) / width;
}

const leOf = (text: string) => (text === "+Inf" ? Infinity : Number(text));

/** 가족(`argocd_app_reconcile`)의 버킷을 모든 묶음에 걸쳐 le마다 더한다. delta를 고르면 앞 읽기 이후의 관측만(없으면 null) */
export function bucketsOf(series: PromSeries[], family: string, use: "value" | "delta", match: (s: PromSeries) => boolean = () => true): Bucket[] | null {
  const mine = series.filter((s) => s.name === `${family}_bucket` && match(s));
  if (mine.length === 0) return null;
  if (use === "delta" && mine.some((s) => s.delta === null)) return null;
  const sums = new Map<number, number>();
  for (const s of mine) {
    const le = leOf(s.labels.le ?? "");
    if (Number.isNaN(le)) continue;
    sums.set(le, (sums.get(le) ?? 0) + (use === "delta" ? (s.delta as number) : s.value));
  }
  return [...sums].map(([le, count]) => ({ le, count })).sort((a, b) => a.le - b.le);
}

export interface Latency {
  p50: number | null;
  p95: number | null;
  /** 앞 읽기가 없어 서버가 켜진 뒤 누적으로 낸 값인가 */
  cumulative: boolean;
}

/** 지난 읽기 이후의 분위수. 앞 읽기가 없는 첫 읽기만 누적으로 내고, 그 뒤에는 그 사이에 관측이 없으면 null */
export function latencyOf(series: PromSeries[], family: string, match?: (s: PromSeries) => boolean): Latency | null {
  const windowed = bucketsOf(series, family, "delta", match);
  const buckets = windowed ?? bucketsOf(series, family, "value", match);
  if (!buckets) return null;
  return { p50: quantile(0.5, buckets), p95: quantile(0.95, buckets), cumulative: windowed === null };
}

const sum = (series: PromSeries[], pick: (s: PromSeries) => number | null) => series.reduce<number | null>((acc, s) => {
  const v = pick(s);
  return v === null ? acc : (acc ?? 0) + v;
}, null);

export interface RatedCount {
  key: string;
  total: number;
  /** 분당 늘어난 횟수. 앞 읽기가 없으면 null */
  perMin: number | null;
}

export interface ClusterRow {
  server: string;
  name: string | null;
  version: string | null;
  /** 컨트롤러가 이 클러스터에 연결돼 있는가 */
  connected: boolean | null;
  objects: number | null;
  resources: number | null;
  cacheAgeSeconds: number | null;
  eventsPerMin: number | null;
}

export interface ControllerPoint {
  at: number;
  reconcile: Latency | null;
  syncByPhase: RatedCount[];
  gitLatency: Latency | null;
  gitRequests: RatedCount[];
  repoPending: number | null;
  clusters: ClusterRow[];
  queues: { component: string; name: string; depth: number }[];
  execPending: number | null;
  appsetErrors: { total: number; perMin: number | null } | null;
  components: ComponentStatus[];
}

/** 컴포넌트마다 앞 읽기와의 간격이 달라 분당 값은 시리즈의 컴포넌트 간격으로 센다 */
function perMinute(series: PromSeries[], intervals: Map<string, number | null>): number | null {
  const deltas = series.map((s) => ({ delta: s.delta, interval: intervals.get(s.component) ?? null }));
  if (deltas.length === 0 || deltas.some((d) => d.delta === null || d.interval === null)) return null;
  return deltas.reduce((acc, d) => acc + (d.delta as number) / ((d.interval as number) / 60_000), 0);
}

function ratedBy(series: PromSeries[], name: string, label: string, intervals: Map<string, number | null>): RatedCount[] {
  const groups = new Map<string, PromSeries[]>();
  for (const s of series.filter((x) => x.name === name)) {
    const key = s.labels[label] ?? "";
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups].map(([key, list]) => ({ key, total: list.reduce((a, s) => a + s.value, 0), perMin: perMinute(list, intervals) })).sort((a, b) => a.key.localeCompare(b.key));
}

/** 읽기 한 번을 화면에 쓸 값으로 */
export function pointOf(scrape: ControllerScrape): ControllerPoint {
  const { series } = scrape;
  const intervals = new Map(scrape.components.map((c) => [c.component, c.intervalMs]));
  const named = (name: string) => series.filter((s) => s.name === name);
  const byServer = (name: string) => new Map(named(name).map((s) => [s.labels.server ?? "", s]));
  const infos = named("argocd_cluster_info");
  const connection = byServer("argocd_cluster_connection_status");
  const objects = byServer("argocd_cluster_api_resource_objects");
  const resources = byServer("argocd_cluster_api_resources");
  const age = byServer("argocd_cluster_cache_age_seconds");
  const events = named("argocd_cluster_events_total");
  const servers = new Set([...infos.map((s) => s.labels.server ?? ""), ...connection.keys()]);
  const clusters = [...servers].filter((s) => s !== "").map((server): ClusterRow => {
    const info = infos.find((s) => s.labels.server === server);
    return {
      server,
      name: info?.labels.name ?? null,
      version: info?.labels.k8s_version ?? null,
      connected: connection.has(server) ? (connection.get(server) as PromSeries).value >= 1 : null,
      objects: objects.get(server)?.value ?? null,
      resources: resources.get(server)?.value ?? null,
      cacheAgeSeconds: age.get(server)?.value ?? null,
      eventsPerMin: perMinute(events.filter((s) => s.labels.server === server), intervals),
    };
  }).sort((a, b) => (a.name ?? a.server).localeCompare(b.name ?? b.server));
  const appsetErrors = named("controller_runtime_reconcile_errors_total").filter((s) => s.component === "appset-controller");
  return {
    at: scrape.at,
    reconcile: latencyOf(series.filter((s) => s.component === "controller"), "argocd_app_reconcile"),
    syncByPhase: ratedBy(series, "argocd_app_sync_total", "phase", intervals),
    gitLatency: latencyOf(series, "argocd_git_request_duration_seconds"),
    gitRequests: ratedBy(series, "argocd_git_request_total", "request_type", intervals),
    repoPending: sum(named("argocd_repo_pending_request_total"), (s) => s.value),
    clusters,
    queues: named("workqueue_depth").map((s) => ({ component: s.component, name: s.labels.name ?? "", depth: s.value })).sort((a, b) => a.component.localeCompare(b.component) || a.name.localeCompare(b.name)),
    execPending: sum(named("argocd_kubectl_exec_pending"), (s) => s.value),
    appsetErrors: appsetErrors.length ? { total: appsetErrors.reduce((a, s) => a + s.value, 0), perMin: perMinute(appsetErrors, intervals) } : null,
    components: scrape.components,
  };
}

/** 읽기를 이어 붙인다. 오래된 것은 HISTORY_POINTS를 넘으면 버린다 */
export function appendPoint(history: ControllerPoint[], point: ControllerPoint): ControllerPoint[] {
  return [...history, point].slice(-HISTORY_POINTS);
}
