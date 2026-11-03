import type { AppError } from "../../api/types";
import { can } from "../can";
import { SERVICE_ACCOUNTS } from "../kinds";
import type { K8sChange, K8sRules, ObjectRef } from "../types";
import { AWS_RESOURCE_LABELS, CHECKS, CHECK_BY_ID, SUBJECT_KIND_LABELS, fixDenied } from "./text";
import type { Category, CheckId, Finding, FindingTarget, Fix, SecurityChecksSetting, SecurityGap, SecurityReport, SecuritySection, Severity } from "./types";

/** 큰 값일수록 심각하다 */
export const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

/** 설정이 비어 있으면 모든 항목을 켜고 시스템 네임스페이스는 뺀다 */
export const DEFAULT_SETTING: SecurityChecksSetting = { disabled: [], includeSystem: false };

export const isEnabled = (s: SecurityChecksSetting, id: CheckId) => !s.disabled.includes(id);

/** 켜진 항목의 문제만 보인다. 시스템 네임스페이스(`system`)의 문제는 포함을 켰을 때만 보인다. */
export function visibleFindings(findings: Finding[], s: SecurityChecksSetting): Finding[] {
  return findings.filter((f) => isEnabled(s, f.check) && (s.includeSystem || !f.system));
}

/** 켜진 항목 중 시스템 네임스페이스라서 숨긴 문제 수 */
export function hiddenSystemCount(findings: Finding[], s: SecurityChecksSetting): number {
  return s.includeSystem ? 0 : findings.filter((f) => isEnabled(s, f.check) && f.system).length;
}

export interface Counts {
  total: number;
  severity: Record<Severity, number>;
  category: Record<Category, number>;
}

export function countFindings(list: Finding[]): Counts {
  const counts: Counts = { total: list.length, severity: { high: 0, medium: 0, low: 0 }, category: { cluster: 0, permissions: 0, workloads: 0 } };
  for (const f of list) {
    counts.severity[f.severity] += 1;
    counts.category[CHECK_BY_ID[f.check].category] += 1;
  }
  return counts;
}

/** 대상을 사람이 읽는 글로: `Deployment dev/web`, `사용자 alice`, `노드그룹 ng-a` */
export function targetLabel(t: FindingTarget): string {
  switch (t.type) {
    case "object":
      return t.namespace ? `${t.kind.kind} ${t.namespace}/${t.name}` : `${t.kind.kind} ${t.name}`;
    case "subject": {
      const s = t.subject;
      const name = s.kind === "serviceAccount" ? `${s.namespace ?? ""}/${s.name}` : s.name;
      return `${SUBJECT_KIND_LABELS[s.kind]} ${name}`;
    }
    case "aws":
      return `${AWS_RESOURCE_LABELS[t.resource] ?? t.resource} ${t.name}`;
  }
}

export interface FindingFilter {
  query: string;
  severity: Severity | null;
  category: Category | null;
}

export const NO_FILTER: FindingFilter = { query: "", severity: null, category: null };

export function filterFindings(list: Finding[], f: FindingFilter): Finding[] {
  const needle = f.query.trim().toLowerCase();
  return list.filter((x) => {
    if (f.severity && x.severity !== f.severity) return false;
    if (f.category && CHECK_BY_ID[x.check].category !== f.category) return false;
    if (needle === "") return true;
    return [CHECK_BY_ID[x.check].title, x.message, targetLabel(x.target), x.namespace ?? ""].some((v) => v.toLowerCase().includes(needle));
  });
}

export interface FindingGroup {
  check: CheckId;
  /** 묶음 안에서 가장 심각한 것 */
  severity: Severity;
  findings: Finding[];
}

const CHECK_ORDER = new Map(CHECKS.map((c, i) => [c.id, i]));

/** 점검 항목별로 묶는다. 가장 심각한 묶음이 먼저, 같으면 점검 항목 순서. */
export function groupByCheck(list: Finding[]): FindingGroup[] {
  const groups = new Map<CheckId, FindingGroup>();
  for (const f of list) {
    const g = groups.get(f.check);
    if (!g) groups.set(f.check, { check: f.check, severity: f.severity, findings: [f] });
    else {
      g.findings.push(f);
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[g.severity]) g.severity = f.severity;
    }
  }
  return [...groups.values()].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (CHECK_ORDER.get(a.check) ?? 0) - (CHECK_ORDER.get(b.check) ?? 0));
}

/** 이 항목을 켜거나 끈 설정 */
export function withCheck(s: SecurityChecksSetting, id: CheckId, on: boolean): SecurityChecksSetting {
  const rest = s.disabled.filter((d) => d !== id);
  return { ...s, disabled: on ? rest : [...rest, id] };
}

/** 여러 항목을 한꺼번에 켜거나 끈 설정(알 수 없는 이름은 그대로 둔다) */
export function withChecks(s: SecurityChecksSetting, ids: CheckId[], on: boolean): SecurityChecksSetting {
  const set = new Set<string>(ids);
  const rest = s.disabled.filter((d) => !set.has(d));
  return { ...s, disabled: on ? rest : [...rest, ...ids] };
}

export const withIncludeSystem = (s: SecurityChecksSetting, includeSystem: boolean): SecurityChecksSetting => ({ ...s, includeSystem });

/** 고치기 변경: 바꾸는 필드만 담은 부분 객체를 server-side apply한다. 충돌은 미리보기가 알려 준다(강제 적용하지 않는다). */
export function fixChange(fix: Fix): K8sChange {
  return { kind: fix.kind, namespace: fix.namespace, name: fix.name, type: "apply", object: fix.object, force: false };
}

/**
 * 고치기 단추를 끌 이유. 규칙을 아직 읽는 중이면 켜 두고(서버가 판단한다), 확실히 거부된 것만 끈다.
 * 객체를 고치는 server-side apply는 patch로 나간다.
 */
export function fixBlock(fix: Fix, rules: K8sRules | undefined): string | undefined {
  if (!rules) return undefined;
  return can(rules, { verb: "patch", group: fix.kind.group, resource: fix.kind.plural }) === "no" ? fixDenied("patch", fix.kind.plural) : undefined;
}

export type TargetLink = { type: "object"; ref: ObjectRef; label: "object" | "serviceAccount" } | { type: "iam"; arn: string } | { type: "access" };

/** 대상으로 가는 길: 워크로드 화면, IAM, 접근 화면 */
export function targetLinks(f: Finding): TargetLink[] {
  const t = f.target;
  if (t.type === "object") return [{ type: "object", ref: { kind: t.kind, namespace: t.namespace, name: t.name }, label: "object" }];
  if (t.type === "aws") return [];
  const s = t.subject;
  if (s.kind === "iam") return [{ type: "iam", arn: s.name }, { type: "access" }];
  if (s.kind === "serviceAccount") return [{ type: "object", ref: { kind: SERVICE_ACCOUNTS, namespace: s.namespace, name: s.name }, label: "serviceAccount" }, { type: "access" }];
  return [{ type: "access" }];
}

/** 켜져 있는데 읽지 못해 점검하지 못한 항목의 이름 */
export function skippedTitles(report: SecurityReport, s: SecurityChecksSetting): string[] {
  return report.skipped.filter((id) => isEnabled(s, id)).map((id) => CHECK_BY_ID[id].title);
}

export interface GapGroup {
  sections: SecuritySection[];
  error: AppError;
}

/** 같은 이유로 못 읽은 부분은 한 줄로 묶는다. 목록이 잘린 것(partial)은 오류가 아니니 따로 센다. */
export function groupGaps(gaps: SecurityGap[]): { errors: GapGroup[]; partial: SecuritySection[] } {
  const errors = new Map<string, GapGroup>();
  const partial: SecuritySection[] = [];
  for (const g of gaps) {
    if (g.partial) {
      if (!partial.includes(g.section)) partial.push(g.section);
      continue;
    }
    const key = JSON.stringify(g.error);
    const found = errors.get(key);
    if (!found) errors.set(key, { sections: [g.section], error: g.error });
    else if (!found.sections.includes(g.section)) found.sections.push(g.section);
  }
  return { errors: [...errors.values()], partial };
}
