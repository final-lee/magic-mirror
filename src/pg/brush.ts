// 권한 표의 바꾸기 모드: 한 번에 하나의 권한("칠할 권한")만 골라 칸을 누르거나 끌어서 담는다.
// 칠할 권한이 무슨 변경을 만들고(brushChange), 칸이 그 권한을 어떻게 가졌는지(Levels, baseState)와 어떻게 보이고 무엇을 하는지(brushView)를 정한다.
import { OWNER_HELD_TEXT, systemRoleText } from "./canChange";
import { draftItem, draftKey, type PgDraftItem } from "./draft";
import { INHERITED_ONLY_TEXT } from "./labels";
import type { PgChange, PgCoverage, PgDbPrivilegeRow, PgGrantTarget, PgSchemaCell } from "./types";

export type BrushId = "usage" | "create" | "read" | "write" | "connect" | "dbCreate" | "temp";
/** 스키마 칸에 칠하는 권한인지, 데이터베이스 열의 칸에 칠하는 권한인지 */
export type BrushScope = "schema" | "database";
export interface Brush {
  id: BrushId;
  label: string;
  scope: BrushScope;
}

/** 열 머리의 안내와 같은 이름, 같은 순서 */
export const BRUSHES: readonly Brush[] = [
  { id: "usage", label: "사용", scope: "schema" },
  { id: "create", label: "만들기", scope: "schema" },
  { id: "read", label: "읽기", scope: "schema" },
  { id: "write", label: "쓰기", scope: "schema" },
  { id: "connect", label: "CONNECT", scope: "database" },
  { id: "dbCreate", label: "CREATE", scope: "database" },
  { id: "temp", label: "TEMP", scope: "database" },
];

/** 바꾸기 모드를 처음 켜면 칠할 권한은 읽기다 */
export const DEFAULT_BRUSH: BrushId = "read";

const BY_ID = new Map(BRUSHES.map((b) => [b.id, b]));

export function brushOf(id: BrushId): Brush {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown brush: ${id}`);
  return found;
}

/** 칠할 권한마다 주고 빼는 대상과 권한. 읽기와 쓰기는 스키마의 모든 테이블에 준다(allTables) */
const GRANTS: Record<BrushId, { privileges: string[]; target: (database: string, schema: string) => PgGrantTarget }> = {
  usage: { privileges: ["USAGE"], target: (_database, schema) => ({ kind: "schema", name: schema }) },
  create: { privileges: ["CREATE"], target: (_database, schema) => ({ kind: "schema", name: schema }) },
  read: { privileges: ["SELECT"], target: (_database, schema) => ({ kind: "allTables", schema }) },
  write: { privileges: ["INSERT", "UPDATE", "DELETE"], target: (_database, schema) => ({ kind: "allTables", schema }) },
  connect: { privileges: ["CONNECT"], target: (database) => ({ kind: "database", name: database }) },
  dbCreate: { privileges: ["CREATE"], target: (database) => ({ kind: "database", name: database }) },
  temp: { privileges: ["TEMPORARY"], target: (database) => ({ kind: "database", name: database }) },
};

/**
 * 칸 하나를 이 권한으로 칠하는 변경: 역할(role)에게 주거나(add) 뺀다. 스키마 권한은 schema 칸의 것이고, 데이터베이스 권한은 schema를 보지 않는다.
 * 키(draftKey)는 줄지 뺄지를 보지 않아서, 같은 칸의 주는 변경과 빼는 변경은 같은 칸이다.
 */
export function brushChange(brush: Brush, database: string, role: string, schema: string | null, add: boolean): PgChange {
  if (brush.scope === "schema" && schema === null) throw new Error(`brush ${brush.id} needs the schema of the cell`);
  const { privileges, target } = GRANTS[brush.id];
  return { kind: "grant", database, grantee: role, add, items: [{ target: target(database, schema ?? ""), privileges: [...privileges] }] };
}

/** 칸의 키(draftKey). 이 칸에 담아 둔 변경을 찾는 데 쓴다. 줄지 뺄지는 키에 없다 */
export function brushKey(brush: Brush, database: string, role: string, schema: string | null): string {
  const key = draftKey(brushChange(brush, database, role, schema, true));
  if (key === null) throw new Error("a grant always has a key");
  return key;
}

/** 칸을 이 권한으로 칠하는 장바구니 줄 */
export function brushItem(brush: Brush, database: string, role: string, schema: string | null, add: boolean): PgDraftItem {
  const item = draftItem(brushChange(brush, database, role, schema, add));
  if (!item) throw new Error("a grant always has a key");
  return item;
}

/** 칸이 이 권한을 얼마나 가졌는지: 전부, 일부 테이블, 없음. 켜고 끄는 권한(사용·만들기·CONNECT …)은 전부와 없음뿐이다 */
export type Level = "all" | "some" | "none";

/**
 * 한 칸이 한 권한을 가진 정도를 출처별로 본 것.
 * shown: 보이는 값(모든 출처) · direct: 그 역할이 직접 받은 것만 · owned: 소유자라서 가진 것만. 그룹·PUBLIC·미리 정의된 역할에서 받은 것은 direct에도 owned에도 없다.
 */
export interface Levels {
  shown: Level;
  direct: Level;
  owned: Level;
}

const level = (value: boolean | PgCoverage): Level => (value === true ? "all" : value === false ? "none" : value);

/** 칠할 권한이 칸의 어느 값을 보는지 */
const SCHEMA_FIELD: Partial<Record<BrushId, "usage" | "create" | "read" | "write">> = { usage: "usage", create: "create", read: "read", write: "write" };
const DATABASE_FIELD: Partial<Record<BrushId, "connect" | "create" | "temp">> = { connect: "connect", dbCreate: "create", temp: "temp" };

/** 스키마 칸이 스키마 권한(사용·만들기·읽기·쓰기)을 가진 정도 */
export function schemaLevels(brush: Brush, cell: PgSchemaCell): Levels {
  const field = SCHEMA_FIELD[brush.id];
  if (!field) throw new Error(`brush ${brush.id} is not for a schema cell`);
  return { shown: level(cell[field]), direct: level(cell.direct[field]), owned: level(cell.owned[field]) };
}

/** 데이터베이스 열의 칸이 데이터베이스 권한(CONNECT·CREATE·TEMP)을 가진 정도 */
export function databaseLevels(brush: Brush, row: PgDbPrivilegeRow): Levels {
  const field = DATABASE_FIELD[brush.id];
  if (!field) throw new Error(`brush ${brush.id} is not for a database cell`);
  return { shown: level(row[field]), direct: level(row.direct[field]), owned: level(row.owned[field]) };
}

/**
 * 담아 둔 변경을 빼고 본 칸의 모양:
 * - on: 그 역할이 직접 전부 받았다(켜져 있다)
 * - owner: 직접 받지 않았고 소유자라서 전부 가졌다. 소유자의 권한은 이 표에서 바꾸지 않는다
 * - some: 일부 테이블만 직접 받았거나 일부만 소유한다. 전부로 채울 수 있다
 * - inherited: 보이기는 하는데 직접 받은 것도 소유한 것도 없다(그룹, PUBLIC, 미리 정의된 역할에서만 받음)
 * - off: 아무도 주지 않는다
 */
export type BaseState = "on" | "owner" | "some" | "inherited" | "off";

export function baseState({ shown, direct, owned }: Levels): BaseState {
  if (direct === "all") return "on";
  if (owned === "all") return "owner";
  if (direct === "some" || owned === "some") return "some";
  return shown === "none" ? "off" : "inherited";
}

export interface BrushView {
  base: BaseState;
  /** 그 역할이 직접 전부 받았는지. 누르면 이것을 뒤집는 변경을 담는다(켜져 있으면 빼고, 아니면 준다) */
  on: boolean;
  /** 이 칸에 담아 둔 변경 */
  pending: PgDraftItem | undefined;
  /** 지금 보이는 상태: 담아 둔 변경이 있으면 그 변경이 가는 쪽, 없으면 on */
  shown: boolean;
  /** 눌러서 담을 수 있는 칸인지. 담아 둔 변경을 거두는 것은 이와 상관없이 늘 된다 */
  toggleable: boolean;
  glyph: string;
  tone: "all" | "some" | "none" | "add" | "del";
  dim: boolean;
  title: string | undefined;
  /** 칸의 이름 뒷부분: 칠할 권한과 칸의 상태 */
  name: string;
}

const STATE_NAME: Record<BaseState, string> = { on: "직접 받음", owner: "소유자", some: "일부 테이블", inherited: INHERITED_ONLY_TEXT, off: "없음" };

/** 담아 둔 변경이 주는 변경인지. 이 칸의 변경은 늘 권한을 주거나 빼는 변경(grant)이다 */
const adds = (item: PgDraftItem) => item.change.kind === "grant" && item.change.add;

/**
 * 칸 하나가 바꾸기 모드에서 어떻게 보이고 무엇을 하는지.
 * 담아 둔 변경이 있으면 그 변경이 가는 쪽(＋ 또는 －)이 먼저 보인다. 변경이 가는 쪽은 변경이 정하고 칸의 지금 상태가 정하지 않는다:
 * 다시 읽은 뒤 칸이 바뀌어도 화면이 적용될 일과 다른 말을 하지 않는다.
 * 시스템 역할의 칸은 담을 수 없고, 그 까닭이 제목이다. 소유자와 그룹·PUBLIC에서만 받은 칸도 담을 수 없다.
 */
export function brushView(brush: Brush, levels: Levels, role: { name: string; system: boolean }, pending: PgDraftItem | undefined): BrushView {
  const base = baseState(levels);
  const on = base === "on";
  const toggleable = !role.system && (base === "on" || base === "some" || base === "off");
  const shown = pending ? adds(pending) : on;
  const title = role.system ? systemRoleText(role.name) : base === "owner" ? OWNER_HELD_TEXT : base === "inherited" ? INHERITED_ONLY_TEXT : undefined;
  const common = { base, on, pending, shown, toggleable, title };
  if (pending) {
    const give = adds(pending);
    return { ...common, glyph: give ? "＋" : "－", tone: give ? "add" : "del", dim: false, name: `${brush.label} ${give ? "줄 예정" : "뺄 예정"}` };
  }
  const partial = base === "some" || (base === "inherited" && levels.shown === "some");
  return {
    ...common,
    glyph: partial ? "◐" : base === "off" ? "○" : "●",
    tone: partial ? "some" : base === "off" ? "none" : "all",
    dim: role.system || base === "owner" || base === "inherited",
    name: `${brush.label} ${STATE_NAME[base]}`,
  };
}
