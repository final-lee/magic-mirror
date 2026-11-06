import { rowKey } from "../argoGroup";
import type { ArgoEvent } from "../types";
import type { DeployRecord } from "./types";

export const DAY_MS = 86_400_000;
export type WindowDays = 7 | 30 | 90;
export const WINDOWS: WindowDays[] = [7, 30, 90];

/** 끝난 배포(작업) 하나. app은 `namespace/name` */
export interface Deploy {
  app: string;
  /** 끝난 시각(ms) */
  at: number;
  ok: boolean;
  /** 시작부터 끝까지(ms). 시작 시각을 모르면 null */
  durationMs: number | null;
  revision: string | null;
}

/** 건강이 Degraded가 된 뒤 Healthy로 돌아오기까지. end가 null이면 아직 Degraded */
export interface Incident {
  app: string;
  start: number;
  end: number | null;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** 오름차순으로 정렬된 값의 p분위수(0~1). 순위 사이는 선형 보간. 비었으면 null */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

const sortedOf = (values: number[]) => [...values].sort((a, b) => a - b);

/**
 * 로컬 이벤트의 끝난 작업과 서버 이력을 한 목록으로 모은다.
 * 같은 앱에서 같은 초에 끝난 것은 한 배포다(서버 이력의 deployedAt이 작업의 finishedAt과 같다). 두 쪽의 리비전이 모두 있고 다르면 다른 배포로 본다.
 * 이벤트가 먼저(실패를 알고 있다), 소요 시간이 비면 이력의 값을 채운다.
 */
export function deploysOf(events: ArgoEvent[], history: DeployRecord[]): Deploy[] {
  const merged = new Map<string, Deploy[]>();
  const add = (deploy: Deploy) => {
    const slot = `${deploy.app}|${Math.floor(deploy.at / 1000)}`;
    const list = merged.get(slot) ?? [];
    const same = list.find((d) => d.revision === null || deploy.revision === null || d.revision === deploy.revision);
    if (same) {
      same.durationMs ??= deploy.durationMs;
      same.revision ??= deploy.revision;
    } else {
      list.push(deploy);
      merged.set(slot, list);
    }
  };
  for (const e of events) {
    if (e.kind !== "operation" || !["Succeeded", "Failed", "Error"].includes(e.phase ?? "")) continue;
    const finished = ms(e.finishedAt) ?? ms(e.at);
    if (finished === null) continue;
    const started = ms(e.startedAt);
    add({ app: rowKey(e.namespace, e.app), at: finished, ok: e.phase === "Succeeded", durationMs: started === null ? null : Math.max(0, finished - started), revision: e.revision });
  }
  for (const h of history) {
    const finished = ms(h.deployedAt);
    if (finished === null) continue;
    const started = ms(h.startedAt);
    add({ app: rowKey(h.namespace, h.app), at: finished, ok: true, durationMs: started === null ? null : Math.max(0, finished - started), revision: h.revision });
  }
  return [...merged.values()].flat().sort((a, b) => a.at - b.at);
}

/** 건강 이벤트에서 복구 구간을 뽑는다: Degraded가 되면 시작, 그 뒤 처음 Healthy가 되면 끝(사이에 Progressing 등을 거쳐도 이어진다) */
export function incidentsOf(events: ArgoEvent[]): Incident[] {
  const health = events.filter((e) => e.kind === "health").map((e) => ({ e, at: ms(e.at) })).filter((x): x is { e: ArgoEvent; at: number } => x.at !== null).sort((a, b) => a.at - b.at);
  const open = new Map<string, Incident>();
  const all: Incident[] = [];
  for (const { e, at } of health) {
    const app = rowKey(e.namespace, e.app);
    const current = open.get(app);
    if (e.to === "Degraded" && !current) {
      const incident = { app, start: at, end: null };
      open.set(app, incident);
      all.push(incident);
    } else if (e.to === "Healthy" && current) {
      current.end = at;
      open.delete(app);
    }
  }
  return all;
}

export interface DoraStats {
  deployments: number;
  /** 관측한 기간(일)에 걸친 하루 평균 배포 수. 기록이 없으면 null */
  perDay: number | null;
  failures: number;
  /** 실패 / 전체. 로컬 기록이 없던 기간의 작업은 빼고 센다. 기록이 시작된 뒤 끝난 작업이 없으면 null */
  failureRate: number | null;
  /** 복구 시간 중앙값(ms)과 복구 횟수 */
  restoreMedianMs: number | null;
  restores: number;
  openIncidents: number;
  syncP50Ms: number | null;
  syncP95Ms: number | null;
  syncSamples: number;
}

/** 이 기간(윈도우)의 지표. coverageStart는 로컬 기록이 시작된 시각(ms)이고 없으면 null */
export function computeStats(deploys: Deploy[], incidents: Incident[], days: WindowDays, now: number, coverageStart: number | null, firstDeploy: number | null): DoraStats {
  const from = now - days * DAY_MS;
  const inWindow = deploys.filter((d) => d.at >= from && d.at <= now);
  const ok = inWindow.filter((d) => d.ok);
  const observedFrom = [coverageStart, firstDeploy].filter((t): t is number => t !== null).reduce<number | null>((a, t) => (a === null ? t : Math.min(a, t)), null);
  const spanDays = observedFrom === null ? null : Math.min(days, Math.max(1, (now - observedFrom) / DAY_MS));
  // 실패는 로컬 기록으로만 알 수 있어서, 기록이 시작된 뒤의 작업으로만 비율을 낸다(서버 이력은 성공만 있어 실패율을 낮춰 보이게 한다)
  const recorded = coverageStart === null ? [] : inWindow.filter((d) => d.at >= coverageStart);
  const failures = recorded.filter((d) => !d.ok).length;
  const restored = incidents.filter((i) => i.end !== null && i.end >= from && i.end <= now).map((i) => (i.end as number) - i.start);
  const syncs = sortedOf(inWindow.filter((d) => d.durationMs !== null).map((d) => d.durationMs as number));
  return {
    deployments: ok.length,
    perDay: spanDays === null ? null : ok.length / spanDays,
    failures,
    failureRate: recorded.length === 0 ? null : failures / recorded.length,
    restoreMedianMs: percentile(sortedOf(restored), 0.5),
    restores: restored.length,
    openIncidents: incidents.filter((i) => i.end === null && i.start <= now).length,
    syncP50Ms: percentile(syncs, 0.5),
    syncP95Ms: percentile(syncs, 0.95),
    syncSamples: syncs.length,
  };
}

export type DoraGroup = "env" | "project" | "app";

export interface DoraRow {
  key: string;
  stats: DoraStats;
}

/** 앱 키(`namespace/name`)가 속한 묶음(환경·프로젝트). 목록에 없는 앱(지워졌다)은 null이라 "알 수 없음"에 모인다 */
export type GroupOf = (app: string) => string | null;

/** 묶음별 지표. 배포가 많은 묶음이 위로 */
export function groupStats(deploys: Deploy[], incidents: Incident[], group: DoraGroup, groupOf: GroupOf, days: WindowDays, now: number, coverageStart: number | null): DoraRow[] {
  const keyOf = (app: string) => (group === "app" ? app : groupOf(app) ?? "");
  const keys = new Set<string>([...deploys.map((d) => keyOf(d.app)), ...incidents.map((i) => keyOf(i.app))]);
  const rows = [...keys].map((key) => {
    const mine = deploys.filter((d) => keyOf(d.app) === key);
    const firstDeploy = mine.length ? mine[0].at : null;
    return { key, stats: computeStats(mine, incidents.filter((i) => keyOf(i.app) === key), days, now, coverageStart, firstDeploy) };
  });
  return rows.sort((a, b) => b.stats.deployments - a.stats.deployments || a.key.localeCompare(b.key));
}

/** 로컬 기록이 시작된 시각: 가장 이른 이벤트(앱이 켜져 있어야 기록된다). 기록이 없으면 null */
export function coverageStartOf(events: ArgoEvent[]): number | null {
  return events.reduce<number | null>((first, e) => {
    const t = ms(e.at);
    return t === null ? first : first === null ? t : Math.min(first, t);
  }, null);
}
