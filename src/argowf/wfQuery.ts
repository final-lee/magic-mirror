import type { InfiniteData } from "@tanstack/react-query";
import { type LabelOption, type LabelPick, parsePick, pickText } from "../argocd/argoFilter";
import { parseSelector, type Requirement } from "../k8s/selector";
import type { WfListQuery, WfPage, WfRow, WfWatchEvent } from "./types";

/** 한 페이지에 읽는 Workflow 수(Argo UI의 기본 한 번 읽기와 같은 규모) */
export const PAGE_SIZE = 200;

export const emptyQuery = (namespace: string | null): WfListQuery => ({
  namespace,
  labelSelector: null,
  name: null,
  createdAfter: null,
  finishedBefore: null,
  phases: [],
  limit: PAGE_SIZE,
  continueToken: null,
});

/** 저장해 둔 레이블 필터(`key=value`·`key`)를 칩으로 */
export const picksFromView = (labels: readonly string[] | undefined): LabelPick[] => (labels ?? []).map(parsePick).filter((p): p is LabelPick => p !== null);

/**
 * 레이블 칩을 쿠버네티스 선택자로: 키가 다르면 AND(쉼표), 같은 키의 값은 OR(`key in (a,b)`).
 * 같은 키에 "키만"이 섞이면 그 키가 있는 것 전부라서 `key`로 줄인다.
 */
export function labelSelectorOf(picks: readonly LabelPick[]): string | null {
  const byKey = new Map<string, LabelPick[]>();
  for (const p of picks) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
  const parts = [...byKey].map(([key, of]) => {
    if (of.some((p) => p.value === null)) return key;
    const values = [...new Set(of.map((p) => p.value as string))];
    return values.length === 1 ? `${key}=${values[0]}` : `${key} in (${values.join(",")})`;
  });
  return parts.length ? parts.join(",") : null;
}

function matchesRequirement(labels: Record<string, string>, r: Requirement): boolean {
  const has = Object.prototype.hasOwnProperty.call(labels, r.key);
  const value = labels[r.key];
  switch (r.op) {
    case "=":
      return has && value === r.values[0];
    case "!=":
      return !has || value !== r.values[0];
    case "in":
      return has && r.values.includes(value);
    case "notin":
      return !has || !r.values.includes(value);
    case "exists":
      return has;
    case "!exists":
      return !has;
  }
}

const time = (value: string | null) => {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * 행이 목록 조건에 맞나. 서버가 이미 거른 결과에도 쓰고(contains 이름처럼 서버가 못 거르는 것), 감시로 온 행을 목록에 넣을지 가를 때도 쓴다.
 * 해석하지 못하는 선택자는 거르지 않는다(서버가 오류로 알려 준다).
 */
export function matchesQuery(row: WfRow, q: WfListQuery): boolean {
  if (q.namespace !== null && row.namespace !== q.namespace) return false;
  const reqs = q.labelSelector ? parseSelector(q.labelSelector) : null;
  if (reqs && !reqs.every((r) => matchesRequirement(row.labels, r))) return false;
  if (q.name) {
    const { mode, value } = q.name;
    if (mode === "exact" ? row.name !== value : mode === "prefix" ? !row.name.startsWith(value) : !row.name.includes(value)) return false;
  }
  if (q.createdAfter) {
    const created = time(row.createdAt ?? row.startedAt);
    const bound = time(q.createdAfter);
    if (created !== null && bound !== null && created < bound) return false;
  }
  if (q.finishedBefore) {
    const finished = time(row.finishedAt);
    const bound = time(q.finishedBefore);
    if (bound !== null && (finished === null || finished >= bound)) return false;
  }
  return q.phases.length === 0 || q.phases.includes(row.phase);
}

export const rowKey = (r: Pick<WfRow, "uid" | "namespace" | "name">) => r.uid || `${r.namespace}/${r.name}`;

/** 모든 페이지의 행을 이어 붙인다(같은 행이 두 페이지에 걸쳐 오면 앞의 것만) */
export function flattenPages(data: InfiniteData<WfPage> | undefined): WfRow[] {
  const seen = new Set<string>();
  const rows: WfRow[] = [];
  for (const page of data?.pages ?? []) {
    for (const row of page.rows) {
      const key = rowKey(row);
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(row);
      }
    }
  }
  return rows;
}

/** 감시 이벤트를 받아 둔 페이지에 반영한다. 조건에 안 맞게 된 행은 뺀다. 새 행은 첫 페이지 앞에 붙는다 */
export function applyWatchEvent(
  data: InfiniteData<WfPage>,
  event: Extract<WfWatchEvent, { type: "upsert" | "delete" }>,
  query: WfListQuery,
): InfiniteData<WfPage> {
  const target = event.type === "upsert" ? event.row : { uid: event.uid, namespace: event.namespace, name: event.name };
  const same = (r: WfRow) => (target.uid && r.uid ? r.uid === target.uid : r.namespace === target.namespace && r.name === target.name);
  const keep = event.type === "upsert" && matchesQuery(event.row, query);
  const found = data.pages.some((page) => page.rows.some(same));
  const pages = data.pages.map((page, i) => {
    if (found) {
      const rows = keep && event.type === "upsert" ? page.rows.map((r) => (same(r) ? event.row : r)) : page.rows.filter((r) => !same(r));
      return { ...page, rows };
    }
    return keep && event.type === "upsert" && i === 0 ? { ...page, rows: [event.row, ...page.rows] } : page;
  });
  return { ...data, pages };
}

/** 레이블 필터 후보(`key`와 `key=value`). 개수는 counted 기준 */
export function wfLabelOptions(all: readonly WfRow[], counted: readonly WfRow[]): LabelOption[] {
  const n = new Map<string, number>();
  for (const r of counted) {
    for (const [k, v] of Object.entries(r.labels)) {
      n.set(k, (n.get(k) ?? 0) + 1);
      n.set(`${k}=${v}`, (n.get(`${k}=${v}`) ?? 0) + 1);
    }
  }
  const seen = new Map<string, LabelOption>();
  for (const r of all) {
    for (const [k, v] of Object.entries(r.labels)) {
      const picks: LabelPick[] =
        v === ""
          ? [{ key: k, value: null }]
          : [
              { key: k, value: null },
              { key: k, value: v },
            ];
      for (const pick of picks) {
        const text = pickText(pick);
        if (!seen.has(text)) seen.set(text, { pick, text, count: n.get(text) ?? 0 });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.pick.key.localeCompare(b.pick.key) || (a.pick.value ?? "").localeCompare(b.pick.value ?? ""));
}
