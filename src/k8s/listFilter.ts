import { rowState } from "./status";
import { kindKey } from "./targets";
import type { K8sKindRef, K8sRow } from "./types";

export type AgeFilter = "all" | "1h" | "1d" | "7d" | "over7d" | "over30d";
export const AGE_FILTERS: AgeFilter[] = ["all", "1h", "1d", "7d", "over7d", "over30d"];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** [최대 나이] 또는 [최소 나이]: 안쪽(within)은 이보다 어린 것, 넘음(over)은 이보다 나이 든 것 */
const AGE_BOUNDS: Record<Exclude<AgeFilter, "all">, { within?: number; over?: number }> = {
  "1h": { within: HOUR },
  "1d": { within: DAY },
  "7d": { within: 7 * DAY },
  over7d: { over: 7 * DAY },
  over30d: { over: 30 * DAY },
};

/** 종류별로 값 하나를 고르는 필터(행 값의 키). 값이 둘 이상일 때만 보인다 */
const VALUE_FILTERS: Record<string, string[]> = {
  "/v1/pods": ["node"],
  "/v1/nodes": ["group", "zone", "instanceType"],
  "/v1/services": ["type"],
  "/v1/secrets": ["type"],
  "/v1/persistentvolumeclaims": ["storageClass"],
  "/v1/persistentvolumes": ["storageClass"],
  "networking.k8s.io/v1/ingresses": ["class"],
};

export function valueFilterKeys(kind: K8sKindRef): string[] {
  return VALUE_FILTERS[kindKey(kind)] ?? [];
}

/** 재시작 수를 가진 종류(Pod)만 "재시작 있음"을 보인다 */
export function hasRestarts(kind: K8sKindRef): boolean {
  return kindKey(kind) === "/v1/pods";
}

export interface ListFilter {
  /** 고른 상태(rowState). 비었으면 모두 */
  states: string[];
  /** 값 필터: 키 → 고른 값 */
  values: Record<string, string>;
  age: AgeFilter;
  restarted: boolean;
  onlyProblems: boolean;
}

export const NO_FILTER: ListFilter = { states: [], values: {}, age: "all", restarted: false, onlyProblems: false };

export function isFiltered(f: ListFilter): boolean {
  return f.states.length > 0 || Object.keys(f.values).length > 0 || f.age !== "all" || f.restarted || f.onlyProblems;
}

function ageMatches(row: K8sRow, age: AgeFilter, now: number): boolean {
  if (age === "all") return true;
  if (!row.createdAt) return false;
  const ms = now - Date.parse(row.createdAt);
  const { within, over } = AGE_BOUNDS[age];
  return (within === undefined || ms < within) && (over === undefined || ms >= over);
}

export function matchesListFilter(row: K8sRow, f: ListFilter, now: number): boolean {
  if (f.onlyProblems && row.problems.length === 0) return false;
  if (f.restarted && !(Number(row.values.restarts) > 0)) return false;
  if (!ageMatches(row, f.age, now)) return false;
  if (f.states.length > 0) {
    const state = rowState(row);
    if (state === null || !f.states.includes(state)) return false;
  }
  return Object.entries(f.values).every(([key, value]) => row.values[key] === value);
}

/** 상태 칩: 지금 행에 있는 상태와 그 수 */
export function stateCounts(rows: K8sRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const s = rowState(r);
    if (s !== null) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}

/** 값 필터의 고를 거리: 지금 행에 있는 값(이름순) */
export function valueChoices(rows: K8sRow[], key: string): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = r.values[key];
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
