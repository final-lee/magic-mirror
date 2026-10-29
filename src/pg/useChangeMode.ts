import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { Pos } from "../lib/gridPos";
import { usePaintDrag } from "../lib/usePaintDrag";
import { brushItem, brushKey, brushView, databaseLevels, schemaLevels, type Brush, type BrushView, type Levels } from "./brush";
import type { PgDraftItem } from "./draft";
import type { PgDbPrivilegeRow, PgRoleSummary, PgSchemaCell } from "./types";
import type { PgDraft } from "./usePgDraft";

/** 데이터베이스 열의 열 번호. 스키마 열은 0부터 센다 */
export const DB_COL = -1;

/** 데이터베이스 보기를 칸과 데이터베이스 권한으로 바로 찾을 수 있게 정리한다. 보기에 없는 역할의 칸은 비어 있는 것으로 본다. */
export interface ViewIndex {
  /** 이름순 */
  schemas: string[];
  cell: (role: string, schema: string) => PgSchemaCell;
  database: (role: string) => PgDbPrivilegeRow;
}

/** 바꾸기 모드에서 표가 장바구니에 대해 쓰는 것 */
export type GridDraft = Pick<PgDraft, "items" | "toggle" | "paint" | "put" | "remove">;
/** 바꾸기 모드: 지금 칠할 권한과 칠한 변경을 담는 장바구니 */
export interface ChangeMode {
  brush: Brush;
  draft: GridDraft;
}
/** 끌어서 칠하는 열: 데이터베이스 열(schema가 null)과 스키마 열. id는 열을 가르는 값이다 */
export interface GridColumn {
  id: string;
  schema: string | null;
}

interface Args {
  rows: PgRoleSummary[];
  index: ViewIndex;
  /** 이름순 스키마 열 */
  schemas: string[];
  /** 바꾸기 모드이면 칠할 권한과 장바구니. 아니면 null */
  change: ChangeMode | null;
  /** 이 표가 보여 주는 데이터베이스. 칠한 변경은 이 데이터베이스의 것이다 */
  database: string;
  /** 지금 초점이 있는 칸(범위의 한 끝) */
  activePos: Pos | null;
}

/**
 * 권한 표의 바꾸기 모드: 칸의 모양과 할 일(viewFor), 누르기·끌어서 칠하기·범위 칠하기, 그리고 Space·Enter·Esc·Shift+화살표의 바꾸기 모드 동작.
 * 읽기 모드의 표(초점 이동, 스크롤, 상세)는 Grid가 맡는다.
 */
export function useChangeMode({ rows, index, schemas, change, database, activePos }: Args) {
  /** 바꾸기 모드의 범위: Shift+화살표를 시작한 칸. 초점이 있는 칸과 이루는 사각형이 범위다 */
  const [anchor, setAnchor] = useState<Pos | null>(null);
  /** 끌어서 칠하는 열: 데이터베이스 열이 먼저(번호 DB_COL)이고 스키마 열이 이어진다. 열의 번호는 칸의 data-pos와 같다 */
  const gridColumns = useMemo<GridColumn[]>(() => [{ id: "database", schema: null }, ...schemas.map((schema) => ({ id: `schema:${schema}`, schema }))], [schemas]);
  const columnAt = (c: number): GridColumn => gridColumns[c - DB_COL];
  /** 장바구니에 담긴 변경을 칸의 키로 찾는다 */
  const queued = useMemo(() => new Map((change?.draft.items ?? []).map((d) => [d.key, d])), [change?.draft.items]);

  /**
   * 바꾸기 모드에서 칸의 모양과 할 일. 칠할 권한이 닿지 않는 칸(스키마 권한을 칠하는데 데이터베이스 열의 칸 …)과 바꾸기 모드가 아니면 null이다.
   */
  const viewFor = (row: PgRoleSummary, column: GridColumn): BrushView | null => {
    if (!change) return null;
    const { brush } = change;
    let levels: Levels;
    if (column.schema === null) {
      if (brush.scope !== "database") return null;
      levels = databaseLevels(brush, index.database(row.name));
    } else {
      if (brush.scope !== "schema") return null;
      levels = schemaLevels(brush, index.cell(row.name, column.schema));
    }
    return brushView(brush, levels, row, queued.get(brushKey(brush, database, row.name, column.schema)));
  };

  /**
   * 바꾸기 모드에서 칸을 누른 것: 담을 수 있으면 담고(이미 담아 둔 변경이 있으면 거두고), 담을 수 없는 칸이면 아무 일도 하지 않는다.
   * 담아 둔 변경이 있는 칸은 다시 읽은 뒤 담을 수 없는 칸이 됐더라도 거둘 수 있다.
   */
  const pressCell = (r: number, c: number) => {
    if (!change) return;
    const column = columnAt(c);
    const v = viewFor(rows[r], column);
    if (!v || (!v.pending && !v.toggleable)) return;
    change.draft.toggle(brushItem(change.brush, database, rows[r].name, column.schema, !v.on));
  };

  /**
   * 칸들을 want(줄 것인가) 쪽으로 칠한다. 지금 보이는 상태가 이미 want인 칸은 그대로 두고, 아니면 담아 둔 반대쪽 변경을 거두고 필요하면 want 쪽 변경을 담는다.
   * 거두는 일을 먼저 해서 꽉 찬 장바구니에도 자리가 난다. 칠할 수 없는 칸은 건너뛴다.
   */
  const paintCells = (cells: { row: PgRoleSummary; column: GridColumn }[], want: boolean) => {
    if (!change) return;
    const take: string[] = [];
    const put: PgDraftItem[] = [];
    for (const { row, column } of cells) {
      const v = viewFor(row, column);
      if (!v || !v.toggleable || v.shown === want) continue;
      if (v.pending) take.push(v.pending.key);
      if (v.on !== want) put.push(brushItem(change.brush, database, row.name, column.schema, want));
    }
    take.forEach(change.draft.remove);
    if (put.length > 0) change.draft.paint(put);
  };

  const drag = usePaintDrag<PgRoleSummary, GridColumn>({
    rows,
    columns: gridColumns,
    firstColumn: DB_COL,
    rowId: (row) => row.name,
    columnId: (column) => column.id,
    editable: (row, column) => !!viewFor(row, column)?.toggleable,
    wanted: (row, column) => !viewFor(row, column)?.shown,
    paint: paintCells,
    press: pressCell,
    onStart: () => setAnchor(null),
  });

  // 보이는 행이나 열이 바뀌거나 바꾸기 모드가 꺼지면 번호로 가리키던 범위는 더는 맞지 않는다
  const changing = !!change;
  useEffect(() => {
    setAnchor(null);
  }, [rows, schemas, changing]);

  // 범위: 기준 칸과 지금 초점 칸(activePos)이 이루는 사각형. 한 칸이면 범위가 아니다
  const range =
    changing && anchor && activePos && !(anchor.r === activePos.r && anchor.c === activePos.c)
      ? { r1: Math.min(anchor.r, activePos.r), r2: Math.max(anchor.r, activePos.r), c1: Math.min(anchor.c, activePos.c), c2: Math.max(anchor.c, activePos.c) }
      : null;
  const inRange = (r: number, c: number) => !!range && r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;

  /** 범위에서 Space: 기준 칸을 누른 결과를 목표로 범위 전체를 칠한다 */
  const paintRange = () => {
    if (!range || !anchor) return;
    const base = viewFor(rows[anchor.r], columnAt(anchor.c));
    if (!base?.toggleable) return;
    const cells: { row: PgRoleSummary; column: GridColumn }[] = [];
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) cells.push({ row: rows[r], column: columnAt(c) });
    paintCells(cells, !base.shown);
  };

  /** Esc: 범위가 있으면 지우고 true. 없으면 false(그다음 Esc가 열린 상세를 닫는다) */
  const clearRange = (): boolean => {
    if (!anchor) return false;
    setAnchor(null);
    return true;
  };

  /**
   * 바꾸기 모드의 Space와 Enter. 처리했으면 true다(그 키는 이동이 아니다).
   * - Space는 담는 일이다(범위가 있으면 범위를 칠한다). 칠할 수 없는 칸에서도 막는다: 브라우저가 격자를 한 쪽 스크롤하지 않게.
   * - 버튼의 Enter는 담는 일(누름)이 아니라 상세를 여는 일이다. 데이터베이스 열의 칸은 열 상세가 없다.
   */
  const onKey = (e: KeyboardEvent, from: Pos, openCell: (role: string, schema: string) => void): boolean => {
    if (!change) return false;
    if (e.key === " ") {
      e.preventDefault();
      if (range) paintRange();
      else pressCell(from.r, from.c);
      return true;
    }
    if (e.key === "Enter") {
      if (from.c !== DB_COL) {
        e.preventDefault();
        openCell(rows[from.r].name, schemas[from.c]);
      }
      return true;
    }
    return false;
  };

  /** 이동 키를 누를 때: Shift+화살표는 범위를 넓히고(기준은 처음 Shift를 누른 칸), 그 밖의 이동은 범위를 지운다 */
  const onMove = (e: KeyboardEvent, from: Pos) => {
    if (change) setAnchor(e.shiftKey && e.key.startsWith("Arrow") ? (a) => a ?? from : null);
  };

  return { drag, viewFor, columnAt, inRange, clearRange, onKey, onMove };
}
