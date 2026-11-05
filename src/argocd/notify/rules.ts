import { rowKey } from "../argoGroup";
import type { ArgoAppRow, ArgoEvent, ArgocdNotify } from "../types";

export const DEFAULT_NOTIFY: ArgocdNotify = { enabled: false, envs: [], outOfSyncMinutes: 30 };

/** 알릴 일 하나. 문구는 보내는 쪽(deliver)이 정한다 */
export type Notice =
  | { kind: "degraded"; namespace: string; app: string }
  | { kind: "operation"; namespace: string; app: string; phase: "Failed" | "Error"; message: string | null }
  | { kind: "outOfSync"; namespace: string; app: string; minutes: number };

/** 앱의 환경(목록 행에서 읽는다). 모르면 "unknown" */
export type EnvOf = (namespace: string, name: string) => string;

const OUT_OF_SYNC = "OutOfSync";
const MINUTE_MS = 60_000;
/** 같은 이벤트가 다시 와도 한 번만 알리려고 기억하는 최대 개수 */
const SEEN_MAX = 500;

/** 환경 필터: 비어 있으면 모든 환경 */
export const envAllowed = (config: ArgocdNotify, env: string) => config.envs.length === 0 || config.envs.includes(env);

/**
 * 알림을 낼지 정하는 상태. 앱 스트림의 이벤트와 목록 행 갱신을 차례로 먹이면 알릴 일이 나온다.
 * Degraded와 작업 실패는 이벤트마다 한 번, OutOfSync 지속은 OutOfSync가 이어지는 구간(에피소드)마다 한 번이다.
 */
export class NotifyState {
  /** 지금 OutOfSync인 앱과 그 시작 시각(ms) */
  private since = new Map<string, number>();
  /** 이미 알린 OutOfSync 에피소드(앱 + 시작 시각) */
  private fired = new Set<string>();
  private seen = new Set<string>();

  /** 기록된 이벤트(sync·health·operation). 알릴 일이면 돌려준다 */
  event(e: ArgoEvent, config: ArgocdNotify, envOf: EnvOf): Notice | null {
    const key = rowKey(e.namespace, e.app);
    const at = Date.parse(e.at);
    if (e.kind === "sync") {
      if (e.to === OUT_OF_SYNC && e.from !== OUT_OF_SYNC) this.since.set(key, Number.isNaN(at) ? Date.now() : at);
      else if (e.from === OUT_OF_SYNC && e.to !== OUT_OF_SYNC) this.since.delete(key);
      return null;
    }
    const id = `${e.at}|${key}|${e.kind}|${e.to ?? e.phase ?? ""}`;
    if (this.seen.has(id)) return null;
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    if (!config.enabled || !envAllowed(config, envOf(e.namespace, e.app))) return null;
    if (e.kind === "health" && e.to === "Degraded") return { kind: "degraded", namespace: e.namespace, app: e.app };
    if (e.kind === "operation" && (e.phase === "Failed" || e.phase === "Error")) return { kind: "operation", namespace: e.namespace, app: e.app, phase: e.phase, message: e.message };
    return null;
  }

  /** 목록 행 갱신. OutOfSync가 시작되면 그 시각(지금)부터 재고, 벗어나면 에피소드를 끝낸다 */
  row(row: ArgoAppRow, now: number) {
    const key = rowKey(row.namespace, row.name);
    if (row.values.sync === OUT_OF_SYNC) {
      if (!this.since.has(key)) this.since.set(key, now);
    } else {
      this.since.delete(key);
    }
  }

  /** 앱이 지워졌다 */
  remove(namespace: string, name: string) {
    this.since.delete(rowKey(namespace, name));
  }

  /** 기준 시간을 넘긴 OutOfSync 중 아직 알리지 않은 것. 에피소드마다 한 번만 나온다 */
  due(config: ArgocdNotify, now: number, envOf: EnvOf): Notice[] {
    if (!config.enabled) return [];
    const limit = Math.max(1, config.outOfSyncMinutes) * MINUTE_MS;
    const notices: Notice[] = [];
    for (const [key, started] of this.since) {
      const episode = `${key}@${started}`;
      if (now - started < limit || this.fired.has(episode)) continue;
      const [namespace, ...rest] = key.split("/");
      const app = rest.join("/");
      if (!envAllowed(config, envOf(namespace, app))) continue;
      this.fired.add(episode);
      notices.push({ kind: "outOfSync", namespace, app, minutes: Math.floor((now - started) / MINUTE_MS) });
    }
    // 끝난 에피소드의 기록은 버린다
    for (const episode of this.fired) {
      const [key, started] = [episode.slice(0, episode.lastIndexOf("@")), Number(episode.slice(episode.lastIndexOf("@") + 1))];
      if (this.since.get(key) !== started) this.fired.delete(episode);
    }
    return notices;
  }
}
