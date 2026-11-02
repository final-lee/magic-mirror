// 분해 표에서 내려가기·올라가기. 행을 누르면 그 항목으로 필터를 걸고 다음 기준으로 내려간다:
// 서비스 → 사용 유형, 리전 → 서비스, 태그 값 → 서비스. 사용 유형에서는 더 내려가지 않는다.
import type { CostDimension, CostFilter, CostGroupBy } from "./types";

export interface Crumb {
  filter: CostFilter;
  /** 이동 경로에 보일 이름(행의 label) */
  label: string;
  /** 내려가기 전에 보던 기준. 이 경로를 누르면 그 기준으로 돌아간다 */
  group: CostGroupBy;
}

export interface DrillState {
  group: CostGroupBy;
  crumbs: Crumb[];
}

export const ROOT: DrillState = { group: { kind: "service" }, crumbs: [] };

const DIMENSION: Record<"service" | "region" | "usageType", CostDimension> = { service: "SERVICE", region: "REGION", usageType: "USAGE_TYPE" };

export function nextGroup(g: CostGroupBy): CostGroupBy | null {
  switch (g.kind) {
    case "service":
      return { kind: "usageType" };
    case "region":
    case "tag":
      return { kind: "service" };
    case "usageType":
      return null;
  }
}

/** 태그 기준의 행 키는 `"<키>$<값>"`이다. 값만 꺼낸다(값에 `$`가 있어도 첫 `$` 뒤 전부) */
export function tagValue(rowKey: string): string {
  const i = rowKey.indexOf("$");
  return i < 0 ? rowKey : rowKey.slice(i + 1);
}

export function filterFor(g: CostGroupBy, rowKey: string): CostFilter {
  return g.kind === "tag" ? { tag: g.key, value: tagValue(rowKey) } : { dimension: DIMENSION[g.kind], value: rowKey };
}

const sameTarget = (a: CostFilter, b: CostFilter) =>
  "dimension" in a ? "dimension" in b && a.dimension === b.dimension : "tag" in b && a.tag === b.tag;

/** 이 기준의 행을 눌러 내려갈 수 있나. 같은 차원(같은 태그 키)에 이미 필터가 있으면 AND로 빈 결과가 되므로 막는다 */
export function canDrill(s: DrillState): boolean {
  if (!nextGroup(s.group)) return false;
  const probe = filterFor(s.group, "");
  return !s.crumbs.some((c) => sameTarget(c.filter, probe));
}

export function drill(s: DrillState, row: { key: string; label: string }): DrillState {
  const next = nextGroup(s.group);
  if (!next || !canDrill(s)) return s;
  return { group: next, crumbs: [...s.crumbs, { filter: filterFor(s.group, row.key), label: row.label, group: s.group }] };
}

/** 경로의 i번째(0 = 전체)로 올라간다: 그 앞의 필터만 남기고, 그 자리에서 보던 기준으로 돌아간다 */
export function up(s: DrillState, i: number): DrillState {
  if (i >= s.crumbs.length) return s;
  return { group: s.crumbs[i].group, crumbs: s.crumbs.slice(0, i) };
}

export const filtersOf = (s: DrillState): CostFilter[] => s.crumbs.map((c) => c.filter);
