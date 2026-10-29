// 장바구니(변경 여러 개를 한 번에 적용하려고 담아 두는 곳)의 순수 규칙: 변경의 키, 담기·빼기·칠하기, 데이터베이스 하나, 50개 한도.
// 상태를 들고 있는 일은 usePgDraft가 한다. 여기서는 받은 목록에서 새 목록을 만들 뿐이고, 바뀐 것이 없으면 받은 목록 그대로를 돌려준다.
import { changeSummary, sortPrivileges } from "./changeText";
import type { PgChange, PgGrantItem, PgGrantTarget, PgRoleSummary } from "./types";

/** 묶음 하나에 담을 수 있는 변경의 수(백엔드의 한도와 같다) */
export const MAX_DRAFT = 50;

export const FULL_NOTICE = `한 번에 ${MAX_DRAFT}개까지 담을 수 있어요`;
export const OTHER_DATABASE_NOTICE = "다른 데이터베이스의 변경이 담겨 있어요. 먼저 적용하거나 비워 주세요";
export const OVERLAP_NOTICE = "같은 대상의 변경이 이미 담겨 있어요. 먼저 그 변경을 거둬 주세요";
export const defaultsAddedNotice = (count: number) => `기본 권한 ${count}개를 담았어요`;

/** 장바구니 한 줄. key는 칸(이 변경이 바꾸는 것)을 가리키고, 같은 칸의 변경은 하나만 있다. label은 변경의 요약이다 */
export interface PgDraftItem {
  key: string;
  change: PgChange;
  label: string;
}

/**
 * 키의 한 조각. 키가 구분에 쓰는 문자(| : . , ;)와 빈 스키마를 뜻하는 *, 그리고 \ 앞에 \를 붙인다.
 * 보통의 이름은 그대로라서 키가 읽히고, 구분 문자가 든 이름 때문에 서로 다른 두 칸이 한 키가 되는 일이 없다.
 */
const part = (text: string) => text.replace(/[\\|:.,;*]/g, "\\$&");

export function targetKey(target: PgGrantTarget): string {
  switch (target.kind) {
    case "database":
    case "schema":
      return `${target.kind}:${part(target.name)}`;
    case "relation":
    case "sequence":
      return `${target.kind}:${part(target.schema)}.${part(target.name)}`;
    case "function":
      return `function:${part(target.schema)}.${part(target.name)}(${part(target.signature)})`;
    case "allTables":
    case "allSequences":
      return `${target.kind}:${part(target.schema)}`;
  }
}

/** 권한은 선언 순서로 적는다. 준 순서가 달라도 같은 칸의 키가 같아야 한다 */
const privilegesKey = (privileges: string[]) => sortPrivileges(privileges).map(part).join(",");
const itemKey = (item: PgGrantItem) => `${targetKey(item.target)}|${privilegesKey(item.privileges)}`;

/**
 * 변경이 가리키는 칸의 키. 줄지 뺄지(add)는 키에 없다: 같은 칸을 주는 변경과 빼는 변경은 같은 키라서 한 칸에 변경은 하나다.
 * 장바구니에 담지 않는 변경(역할 만들기, 비밀번호 재설정, 삭제, 세션 끊기)은 null이다.
 */
export function draftKey(change: PgChange): string | null {
  switch (change.kind) {
    case "grant":
      return `grant|${part(change.database)}|${part(change.grantee)}|${change.items.map(itemKey).join(";")}`;
    case "membership":
      return `membership|${part(change.group)}|${part(change.member)}|${change.admin}`;
    case "attributes":
      return `attributes|${part(change.role)}`;
    case "defaultPrivilege": {
      const schema = change.schema === null ? "*" : part(change.schema);
      return `default|${part(change.database)}|${part(change.creator)}|${schema}|${change.objectType}|${part(change.grantee)}|${privilegesKey(change.privileges)}`;
    }
    default:
      return null;
  }
}

/** 변경으로 장바구니 줄을 만든다. 장바구니에 담지 않는 변경이면 null */
export function draftItem(change: PgChange): PgDraftItem | null {
  const key = draftKey(change);
  return key === null ? null : { key, change, label: changeSummary(change) };
}

/** 변경이 실행되는 데이터베이스. 클러스터 전체에 걸리는 변경(구성원, 속성)은 어느 데이터베이스에서든 같아서 null이다 */
export function changeDatabase(change: PgChange): string | null {
  return change.kind === "grant" || change.kind === "defaultPrivilege" ? change.database : null;
}

/** 장바구니의 데이터베이스: 데이터베이스가 있는 변경이 담긴 데이터베이스. 그런 변경이 없으면 null이다 */
export function draftDatabase(items: PgDraftItem[]): string | null {
  for (const { change } of items) {
    const database = changeDatabase(change);
    if (database !== null) return database;
  }
  return null;
}

/** 한 번의 조작 결과 */
export interface DraftStep {
  items: PgDraftItem[];
  /** 꽉 차서 못 담은 것이 있다 */
  full: boolean;
  /** 담아 둔 다른 모양의 변경(한 객체 대 스키마의 모든 테이블·시퀀스)과 같은 대상·권한이 겹쳐서 못 담은 것이 있다 */
  overlap: boolean;
  /** 장바구니와 다른 데이터베이스의 변경이라서 못 담은 것이 있다 */
  elsewhere: boolean;
  /** 새로 담긴 줄의 수. 바꿔 놓은 줄은 세지 않는다 */
  added: number;
}

const start = (items: PgDraftItem[]): DraftStep => ({ items, full: false, overlap: false, elsewhere: false, added: 0 });

/** 속성이 지금 역할의 것과 같은 만료 시각인지. 같은 순간이면 적은 모양이 달라도 같다 */
function sameExpiry(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  return a !== null && b !== null && Date.parse(a) === Date.parse(b);
}

/** 바라는 속성이 개요에 있는 그 역할의 지금 속성과 같은지. 개요에 없는 역할은 견줄 것이 없어서 같지 않다 */
function sameAsNow(change: Extract<PgChange, { kind: "attributes" }>, roles: PgRoleSummary[]): boolean {
  const now = roles.find((role) => role.name === change.role)?.attributes;
  const { set } = change;
  return (
    !!now &&
    set.login === now.login &&
    set.createDb === now.createDb &&
    set.createRole === now.createRole &&
    set.inherit === now.inherit &&
    set.connectionLimit === now.connectionLimit &&
    sameExpiry(set.validUntil, now.validUntil)
  );
}

const bulkKind = (target: PgGrantTarget): "relation" | "sequence" | null => (target.kind === "allTables" ? "relation" : target.kind === "allSequences" ? "sequence" : null);

/**
 * 두 권한 변경이 모양이 다른데 펼치면 같은 대상(받는 역할, 객체, 권한)을 건드리는가: 객체 하나(relation, sequence)와 그 스키마의 모든 테이블·시퀀스(allTables, allSequences).
 * 백엔드는 펼친 뒤의 같은 대상을 한 묶음에 두 번 담지 못하게 막는다. 모양이 같은 변경(같은 대상)의 겹침은 putChangeItem이 권한을 걷어 내서 푼다.
 */
export function expandedOverlap(a: PgChange, b: PgChange): boolean {
  if (a.kind !== "grant" || b.kind !== "grant" || a.database !== b.database || a.grantee !== b.grantee) return false;
  const hits = (bulk: PgGrantItem, one: PgGrantItem) => {
    const kind = bulkKind(bulk.target);
    return kind !== null && one.target.kind === kind && "schema" in bulk.target && "schema" in one.target && bulk.target.schema === one.target.schema && bulk.privileges.some((p) => one.privileges.includes(p));
  };
  return a.items.some((x) => b.items.some((y) => hits(x, y) || hits(y, x)));
}

/** 새 줄을 맨 끝에 담는다. 먼저 겹침과 데이터베이스 규칙, 그다음 한도를 본다 */
function append(step: DraftStep, item: PgDraftItem): DraftStep {
  if (step.items.some((d) => expandedOverlap(d.change, item.change))) return { ...step, overlap: true };
  const database = changeDatabase(item.change);
  const current = draftDatabase(step.items);
  if (database !== null && current !== null && database !== current) return { ...step, elsewhere: true };
  if (step.items.length >= MAX_DRAFT) return { ...step, full: true };
  return { ...step, items: [...step.items, item], added: step.added + 1 };
}

const replaceAt = (items: PgDraftItem[], at: number, item: PgDraftItem) => items.map((d, i) => (i === at ? item : d));

/**
 * 줄 하나를 둔다(이미 있으면 그대로 둔다). 한 대상에 변경이 둘 되지 않도록 두 종류는 바꿔 놓는다:
 * - 속성: 역할마다 하나. 새 속성은 있던 것을 그 자리에서 바꾸고, 역할의 지금 속성과 같으면 있던 것을 빼고 아무것도 담지 않는다.
 * - 구성원: 같은 그룹·구성원 쌍에 ADMIN OPTION 값이 다른 줄이 있으면 그 자리에서 바꾼다.
 */
function put(step: DraftStep, item: PgDraftItem, roles: PgRoleSummary[]): DraftStep {
  const { items } = step;
  const { change } = item;
  const same = items.findIndex((d) => d.key === item.key);
  if (change.kind === "attributes") {
    if (sameAsNow(change, roles)) return same < 0 ? step : { ...step, items: items.filter((_, i) => i !== same) };
    if (same < 0) return append(step, item);
    return items[same].change === change ? step : { ...step, items: replaceAt(items, same, item) };
  }
  if (same >= 0) return step;
  if (change.kind === "membership") {
    const pair = items.findIndex((d) => d.change.kind === "membership" && d.change.group === change.group && d.change.member === change.member);
    if (pair >= 0) return { ...step, items: replaceAt(items, pair, item) };
  }
  return append(step, item);
}

/** 줄 여러 개를 차례로 둔다(칠하기, 기본 권한도 담기). 담긴 순서를 지키고, 이미 있는 키는 건너뛴다. 못 담은 것이 있으면 그 까닭을 알린다 */
export function putItems(items: PgDraftItem[], incoming: PgDraftItem[], roles: PgRoleSummary[]): DraftStep {
  return incoming.reduce((step, item) => put(step, item, roles), start(items));
}

/**
 * 눌러서 담기: 같은 키가 이미 담겨 있으면 뺀다. 속성은 뺄 수 없고 있던 것을 바꾼다(putItems의 규칙).
 * 뺀 줄이 있던 자리는 비므로 꽉 찬 장바구니에서도 뺄 수 있다.
 */
export function toggleItem(items: PgDraftItem[], item: PgDraftItem, roles: PgRoleSummary[]): DraftStep {
  const at = items.findIndex((d) => d.key === item.key);
  if (at >= 0 && item.change.kind !== "attributes") return start(items.filter((_, i) => i !== at));
  return putItems(items, [item], roles);
}

/** 적용을 마친 변경의 줄을 뺀다. 키가 같은 줄만 빠진다. 빠진 줄이 없으면 받은 목록 그대로를 돌려준다 */
export function removeApplied(items: PgDraftItem[], applied: PgChange[]): PgDraftItem[] {
  const keys = new Set(applied.map(draftKey).filter((key): key is string => key !== null));
  const left = items.filter((d) => !keys.has(d.key));
  return left.length === items.length ? items : left;
}

const without = (privileges: string[], taken: string[]) => privileges.filter((p) => !taken.includes(p));

/**
 * 담긴 변경에서 새 변경과 겹치는 권한(같은 데이터베이스, 받는 역할, 대상)을 뺀 변경. 겹침이 없으면 null(그대로 둔다).
 * 권한이 남지 않으면 undefined(변경 자체를 거둔다).
 */
function trimmed(queued: PgChange, change: PgChange): PgChange | null | undefined {
  if (queued.kind === "grant" && change.kind === "grant") {
    if (queued.database !== change.database || queued.grantee !== change.grantee) return null;
    let touched = false;
    const items = queued.items.flatMap((item) => {
      const taken = change.items.filter((c) => targetKey(c.target) === targetKey(item.target)).flatMap((c) => c.privileges);
      const left = without(item.privileges, taken);
      if (left.length !== item.privileges.length) touched = true;
      return left.length > 0 ? [{ ...item, privileges: left }] : [];
    });
    if (!touched) return null;
    return items.length > 0 ? { ...queued, items } : undefined;
  }
  if (queued.kind === "defaultPrivilege" && change.kind === "defaultPrivilege") {
    const same = queued.database === change.database && queued.creator === change.creator && queued.schema === change.schema && queued.objectType === change.objectType && queued.grantee === change.grantee;
    if (!same) return null;
    const left = without(queued.privileges, change.privileges);
    if (left.length === queued.privileges.length) return null;
    return left.length > 0 ? { ...queued, privileges: left } : undefined;
  }
  return null;
}

/**
 * 폼이 만든 변경 하나를 담는다. 권한을 주고 빼는 변경(grant, defaultPrivilege)은 같은 대상의 같은 권한이 장바구니에 둘 있지 않도록
 * 담긴 변경에서 겹치는 권한을 걷어 낸다(주는 쪽이든 빼는 쪽이든. 남는 권한이 없으면 그 변경을 거둔다. 남는 변경은 제자리에 있다).
 * 못 담는 경우(다른 모양과 겹침, 다른 데이터베이스, 꽉 참)는 장바구니를 하나도 바꾸지 않고 까닭만 알린다: 걷어 내는 일은 담길 것이 정해진 뒤에만 한다.
 * 속성과 구성원은 putItems의 규칙대로 둔다.
 */
export function putChangeItem(items: PgDraftItem[], change: PgChange, roles: PgRoleSummary[]): DraftStep {
  const item = draftItem(change);
  if (!item) return start(items);
  if (change.kind !== "grant" && change.kind !== "defaultPrivilege") return putItems(items, [item], roles);
  if (items.some((d) => d.key === item.key && JSON.stringify(d.change) === JSON.stringify(change))) return start(items);
  if (items.some((d) => expandedOverlap(d.change, change))) return { ...start(items), overlap: true };
  const database = changeDatabase(change);
  const current = draftDatabase(items);
  if (database !== null && current !== null && database !== current) return { ...start(items), elsewhere: true };
  const next = items.flatMap((queued): PgDraftItem[] => {
    const left = trimmed(queued.change, change);
    if (left === null) return [queued];
    const kept = left ? draftItem(left) : null;
    return kept ? [kept] : [];
  });
  if (next.length >= MAX_DRAFT) return { ...start(items), full: true };
  return { ...start([...next, item]), added: 1 };
}

/** 이 변경(의 권한 일부)을 빼는 변경이 담겨 있으면 그 줄. 버튼이 눌린 모양인지와 거둘 줄을 정한다 */
export function queuedRevoke(items: PgDraftItem[], change: PgChange): PgDraftItem | undefined {
  return items.find(({ change: q }) => {
    if (q.kind === "grant" && change.kind === "grant") {
      return !q.add && q.database === change.database && q.grantee === change.grantee && q.items.some((x) => change.items.some((y) => targetKey(x.target) === targetKey(y.target) && x.privileges.some((p) => y.privileges.includes(p))));
    }
    if (q.kind === "defaultPrivilege" && change.kind === "defaultPrivilege") {
      return !q.add && q.database === change.database && q.creator === change.creator && q.schema === change.schema && q.objectType === change.objectType && q.grantee === change.grantee && q.privileges.some((p) => change.privileges.includes(p));
    }
    return false;
  });
}

/**
 * 변경 여러 개를 차례로 담는다(기본 권한도 담기). 하나하나 putChangeItem의 규칙을 따른다: 겹치는 권한은 걷어 내고, 못 담는 것은 까닭만 알린다.
 * 담긴 순서를 지키고, 앞 변경이 담긴 장바구니 위에 다음 변경을 담는다.
 */
export function putChangeItems(items: PgDraftItem[], changes: PgChange[], roles: PgRoleSummary[]): DraftStep {
  return changes.reduce((step, change) => {
    const next = putChangeItem(step.items, change, roles);
    return { items: next.items, added: step.added + next.added, full: step.full || next.full, overlap: step.overlap || next.overlap, elsewhere: step.elsewhere || next.elsewhere };
  }, start(items));
}
