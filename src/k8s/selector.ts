import type { K8sRow } from "./types";

export type Requirement = { key: string; op: "=" | "!=" | "in" | "notin" | "exists" | "!exists"; values: string[] };
export type Filter = { kind: "none" } | { kind: "name"; text: string } | { kind: "selector"; reqs: Requirement[] } | { kind: "invalid" };

// 쿠버네티스 레이블 키(접두사/이름)와 값의 모양
const KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;
const SET = /^(\S+)\s+(in|notin)\s*\(([^()]*)\)$/;
const EQ = /^([^=!\s]+)\s*(==|=|!=)\s*(\S+)$/;
const NOT = /^!\s*(\S+)$/;

/** 괄호 밖의 쉼표로 나눈다 */
function split(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function requirement(t: string): Requirement | null {
  let m = SET.exec(t);
  if (m) {
    const values = m[3].split(",").map((v) => v.trim());
    if (values.some((v) => v === "" || !VALUE.test(v)) || !KEY.test(m[1])) return null;
    return { key: m[1], op: m[2] as "in" | "notin", values };
  }
  m = EQ.exec(t);
  if (m) {
    if (!KEY.test(m[1]) || !VALUE.test(m[3])) return null;
    return { key: m[1], op: m[2] === "!=" ? "!=" : "=", values: [m[3]] };
  }
  m = NOT.exec(t);
  if (m) return KEY.test(m[1]) ? { key: m[1], op: "!exists", values: [] } : null;
  return KEY.test(t) ? { key: t, op: "exists", values: [] } : null;
}

/** kubectl -l 과 같은 문법. 하나라도 틀리면 null */
export function parseSelector(s: string): Requirement[] | null {
  const reqs: Requirement[] = [];
  for (const t of split(s)) {
    const r = t === "" ? null : requirement(t);
    if (!r) return null;
    reqs.push(r);
  }
  return reqs;
}

export function parseFilter(input: string): Filter {
  const t = input.trim();
  if (t === "") return { kind: "none" };
  if (!/[=!(]/.test(t) && !/\s(in|notin)\s/.test(t)) return { kind: "name", text: t.toLowerCase() };
  const reqs = parseSelector(t);
  return reqs ? { kind: "selector", reqs } : { kind: "invalid" };
}

function matches(labels: Record<string, string>, r: Requirement): boolean {
  const has = Object.prototype.hasOwnProperty.call(labels, r.key);
  const v = labels[r.key];
  switch (r.op) {
    case "=":
      return has && v === r.values[0];
    case "!=":
      return !has || v !== r.values[0];
    case "in":
      return has && r.values.includes(v);
    case "notin":
      return !has || !r.values.includes(v);
    case "exists":
      return has;
    case "!exists":
      return !has;
  }
}

/** 해석하지 못한 필터는 거르지 않는다(화면이 오류를 따로 보여 준다) */
export function matchesFilter(row: K8sRow, f: Filter): boolean {
  if (f.kind === "name") return row.name.toLowerCase().includes(f.text);
  if (f.kind === "selector") return f.reqs.every((r) => matches(row.labels, r));
  return true;
}
