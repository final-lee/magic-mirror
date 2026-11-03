import { scoreFields } from "../lib/fuzzy";
import type { ArgoAppRow } from "./types";

/** 레이블 필터 한 개. value가 null이면 "그 키가 있는 앱" */
export interface LabelPick {
  key: string;
  value: string | null;
}

export const pickText = (p: LabelPick) => (p.value === null ? p.key : `${p.key}=${p.value}`);

/** `key=value` 또는 `key`. 키가 비면 null, 값이 비면(`key=`) 키만 */
export function parsePick(text: string): LabelPick | null {
  const eq = text.indexOf("=");
  const key = (eq < 0 ? text : text.slice(0, eq)).trim();
  const value = eq < 0 ? "" : text.slice(eq + 1).trim();
  return key === "" ? null : { key, value: value === "" ? null : value };
}

/** 같은 키의 필터끼리는 OR, 키가 다르면 AND */
export function labelMatch(picks: LabelPick[], r: ArgoAppRow): boolean {
  const byKey = new Map<string, LabelPick[]>();
  for (const p of picks) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
  return [...byKey].every(([key, of]) => of.some((p) => (p.value === null ? key in r.labels : r.labels[key] === p.value)));
}

/** 검색어 토큰(tokenize)이 모두 이름, 대상 네임스페이스, 레이블 값 중 어딘가에 퍼지로 맞으면 맞다. 순서는 건드리지 않는다(묶음·심각도 순서가 화면의 뜻이다) */
export const searchMatch = (tokens: readonly string[], r: ArgoAppRow): boolean =>
  scoreFields(tokens, [r.name, r.values.destNamespace, ...Object.values(r.labels)]) !== null;

export interface LabelOption {
  pick: LabelPick;
  text: string;
  count: number;
}

/**
 * 데이터에 있는 `key`와 `key=value` 후보(키 순, 키 단독이 그 값들 앞). 개수는 counted(다른 조건에 맞는 앱) 기준이라
 * 지금 조건에서 없는 후보는 0으로 남는다.
 */
export function labelOptions(all: ArgoAppRow[], counted: ArgoAppRow[]): LabelOption[] {
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
      // 값이 빈 레이블은 `key=`로 쓸 수 없어(= 키만) 키 단독 후보로만 센다
      const picks: LabelPick[] = v === "" ? [{ key: k, value: null }] : [{ key: k, value: null }, { key: k, value: v }];
      for (const pick of picks) {
        const text = pickText(pick);
        if (!seen.has(text)) seen.set(text, { pick, text, count: n.get(text) ?? 0 });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.pick.key.localeCompare(b.pick.key) || (a.pick.value ?? "").localeCompare(b.pick.value ?? ""));
}
