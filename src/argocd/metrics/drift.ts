import type { ArgoAppRow, ArgoEvent } from "../types";
import { rowKey } from "../argoGroup";

export interface DriftApp {
  row: ArgoAppRow;
  /** OutOfSync가 된 시각(ms). 로컬 기록에 그 전환이 없으면 null */
  since: number | null;
  /** OutOfSync가 이어진 시간(ms). since를 모르면 기록이 시작된 뒤로 최소 이만큼(없으면 0) */
  durationMs: number;
  /** since를 모르는 앱이라 durationMs가 "적어도 이만큼"인가 */
  atLeast: boolean;
}

const time = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * 지금 OutOfSync인 앱을 오래된 순으로. 오래됨은 마지막 sync 상태 전환(OutOfSync가 된 때)부터 잰다.
 * 로컬 기록에 그 전환이 없는 앱은 기록이 시작된 뒤로 이어졌다고만 알 수 있어서 "적어도"로 두고 같은 줄에 세운다.
 */
export function outOfSyncRanking(rows: ArgoAppRow[], events: ArgoEvent[], now: number, coverageStart: number | null): DriftApp[] {
  const lastSyncChange = new Map<string, ArgoEvent & { ms: number }>();
  for (const e of events) {
    const ms = time(e.at);
    if (e.kind !== "sync" || ms === null) continue;
    const key = rowKey(e.namespace, e.app);
    const seen = lastSyncChange.get(key);
    if (!seen || ms >= seen.ms) lastSyncChange.set(key, { ...e, ms });
  }
  return rows
    .filter((r) => r.values.sync === "OutOfSync")
    .map((row): DriftApp => {
      const last = lastSyncChange.get(rowKey(row.namespace, row.name));
      if (last?.to === "OutOfSync") return { row, since: last.ms, durationMs: Math.max(0, now - last.ms), atLeast: false };
      return { row, since: null, durationMs: coverageStart === null ? 0 : Math.max(0, now - coverageStart), atLeast: true };
    })
    .sort((a, b) => b.durationMs - a.durationMs || a.row.name.localeCompare(b.row.name));
}

/** 시점별 OutOfSync 앱 수. count가 null이면 그 시점은 로컬 기록이 시작되기 전이라 알 수 없다 */
export interface TrendPoint {
  at: number;
  count: number | null;
}

/** sync 전환 하나가 OutOfSync 수에 미치는 변화 */
const change = (e: ArgoEvent) => (e.to === "OutOfSync" && e.from !== "OutOfSync" ? 1 : e.from === "OutOfSync" && e.to !== "OutOfSync" ? -1 : 0);

/** 지금 수에서 거꾸로 전환을 되돌려 `days`일 동안 `steps`칸의 추이를 만든다(칸 끝 시각마다 한 점, 마지막 점이 지금) */
export function outOfSyncTrend(events: ArgoEvent[], current: number, now: number, days: number, steps: number, coverageStart: number | null): TrendPoint[] {
  const syncs = events.filter((e) => e.kind === "sync").map((e) => ({ ms: time(e.at), delta: change(e) })).filter((e): e is { ms: number; delta: number } => e.ms !== null && e.delta !== 0);
  const span = days * 86_400_000;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const at = now - span + (span * i) / steps;
    const later = syncs.filter((e) => e.ms > at && e.ms <= now).reduce((sum, e) => sum + e.delta, 0);
    return { at, count: coverageStart === null || at < coverageStart ? null : Math.max(0, current - later) };
  });
}

export interface PolicyGaps {
  /** 자동 sync가 꺼진 앱 */
  autoSyncOff: ArgoAppRow[];
  /** 자동 sync는 켜졌는데 selfHeal이 꺼진 앱 */
  selfHealOff: ArgoAppRow[];
  /** 자동 sync는 켜졌는데 prune이 꺼진 앱 */
  pruneOff: ArgoAppRow[];
}

/** 자동 sync 정책이 비어 있는 앱. 칸을 모르는 행(값이 없다)은 판단하지 않는다 */
export function policyGaps(rows: ArgoAppRow[]): PolicyGaps {
  const byName = (a: ArgoAppRow, b: ArgoAppRow) => a.name.localeCompare(b.name);
  const auto = rows.filter((r) => r.values.autoSync === "true");
  return {
    autoSyncOff: rows.filter((r) => r.values.autoSync === "false").sort(byName),
    selfHealOff: auto.filter((r) => r.values.selfHeal === "false").sort(byName),
    pruneOff: auto.filter((r) => r.values.autoPrune === "false").sort(byName),
  };
}
