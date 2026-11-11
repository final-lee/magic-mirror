import { fuzzyKeep } from "../lib/fuzzy";
import * as t from "./text";
import type { DynamoTable } from "./types";

/** 테이블 하나의 건강. unknown은 설명을 읽지 못한 테이블이다 */
export type Health = "fail" | "warn" | "ok" | "unknown";

export function tableHealth(table: DynamoTable): Health {
  if (table.error) return "unknown";
  if (table.findings.some((f) => f.level === "fail")) return "fail";
  if (table.findings.some((f) => f.level === "warn")) return "warn";
  return "ok";
}

/** "문제 있는 테이블만"에 드는 테이블: 실패·주의 진단이 있거나 읽지 못한 테이블(정보 수준은 문제가 아니다) */
export const hasProblem = (table: DynamoTable) => tableHealth(table) !== "ok";

/** 테이블이나 인덱스가 바뀌는 중인가(만드는 중·백필·갱신). 이때만 고른 테이블을 10초마다 다시 읽는다 */
export function needsFastRefresh(table: DynamoTable): boolean {
  if (table.error) return false;
  return table.status !== "ACTIVE" || table.indexes.some((i) => i.status !== "ACTIVE" || i.backfilling);
}

/** 목록을 다시 읽는 간격(탭이 보일 때만) */
export const OVERVIEW_REFRESH_MS = 60_000;
/** 바뀌는 중인 테이블을 다시 읽는 간격(탭이 보일 때만) */
export const TABLE_REFRESH_MS = 10_000;

/** 목록에 보이는 테이블: 이름 퍼지 찾기와 "문제 있는 테이블만"을 적용한다. 순서는 그대로다 */
export function visibleTables(tables: readonly DynamoTable[], opts: { problemOnly: boolean; query: string }): DynamoTable[] {
  const base = opts.problemOnly ? tables.filter(hasProblem) : tables;
  return fuzzyKeep(base, opts.query, (tbl) => [tbl.name]);
}

/** 목록 행의 과금 칸: `온디맨드` 또는 `R5 / W5` */
export function billingShort(table: DynamoTable): string {
  return table.billing.mode === "onDemand" ? t.ON_DEMAND : t.provisionedShort(table.billing.read, table.billing.write);
}
