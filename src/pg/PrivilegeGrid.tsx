import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type UIEvent } from "react";
import { visibleRange } from "../iam/AssignmentGrid";
import { parsePos, posKey, type Pos } from "../iam/gridPos";
import { CellPanel } from "./CellPanel";
import { DatabaseScreen } from "./DatabaseScreen";
import { COVERAGE_LABEL, INHERITED_ONLY_TEXT, ROLE_KIND_LABEL, TRUNCATED_TEXT, collate, unusableText } from "./labels";
import { PgError } from "./PgError";
import { usePgDatabase } from "./queries";
import { RoleKinds, filterRoles, type RoleKindsValue } from "./RoleKinds";
import type { SchemaFocus } from "./route";
import type { PgCoverage, PgDatabaseView, PgDbPrivilegeRow, PgOverview, PgRoleKind, PgRoleSummary, PgSchemaCell, PgTarget } from "./types";

/** 데이터 행의 높이. 고정이라서 보이는 행만 그릴 수 있다 */
export const ROW_H = 28;
/** 열 머리 행의 높이: 스키마 이름과 그 아래 표시 안내 */
export const HEAD_H = 46;
/** 보이는 구간 위아래로 더 그리는 행 수 */
const OVERSCAN = 10;
/** 아직 크기를 못 쟀을 때(첫 그림, 레이아웃이 없는 환경) 쓰는 표 높이 */
const FALLBACK_VIEWPORT = 600;
const NAME_W = 200;
const DB_W = 176;
const CELL_W = 188;
/** 머리 행과 머리 열이 가리는 만큼을 CSS(scroll-padding)도 알아야 해서 같은 값을 변수로 넘긴다 */
const SIZES = { "--pg-head": `${HEAD_H}px`, "--pg-name": `${NAME_W}px` } as CSSProperties;

/** 상세를 여는 칸: 역할과 스키마의 이름으로 가리킨다(번호가 아니라서 역할을 거르거나 다시 읽어도 같은 칸이다) */
interface CellKey {
  role: string;
  schema: string;
}
/** 초점이 갈 수 있는 칸: 스키마 칸이거나, schema가 null이면 그 역할의 데이터베이스 열 칸(읽기만 한다) */
interface GridKey {
  role: string;
  schema: string | null;
}
/** 데이터베이스 열의 열 번호. 스키마 열은 0부터 센다 */
const DB_COL = -1;
/**
 * 표에게 이 칸으로 초점을 돌려 달라는 부탁. n이 올라야 같은 칸을 또 부탁할 수 있다.
 * open이면 초점을 준 뒤 그 칸의 상세도 연다(상세가 마지막에 초점을 가져가서, 칸을 눌렀을 때와 같다).
 */
type FocusReq = CellKey & { n: number; open?: boolean };

/** 그려지는 줄: 종류 머리이거나 데이터 행(r은 rows의 번호) */
type Line = { type: "head"; kind: PgRoleKind; count: number } | { type: "row"; r: number };

const emptyCell = (role: string, schema: string): PgSchemaCell => ({ role, schema, usage: false, create: false, read: "none", write: "none", inheritedOnly: false, unusable: null });

/** 표의 행: 사용자 먼저, 그다음 그룹. 종류 안에서는 이름순. 거르는 규칙은 역할 목록과 같다. */
function shownRows(roles: PgRoleSummary[], kinds: RoleKindsValue, filter: string): PgRoleSummary[] {
  const shown = filterRoles(roles, kinds, filter);
  const ofKind = (kind: PgRoleKind) => shown.filter((r) => r.kind === kind).sort((a, b) => collate(a.name, b.name));
  return [...ofKind("user"), ...ofKind("group")];
}

/**
 * 점검이 부탁한 대로 열 때의 첫 모습. 항목이 역할도 가리키고 그 역할의 행이 있으면 그 칸을 열어 달라고 하고(스키마가 이 데이터베이스에 없으면 표가 알아서 거른다),
 * 아니면 가리킨 스키마의 열 머리에 표시를 하고 첫 행의 그 열 칸으로 초점을 보내 달라고 한다.
 */
function openedFrom(pick: SchemaFocus | null, rows: PgRoleSummary[]): { marked: string | null; focusReq: FocusReq | null } {
  if (!pick?.schema) return { marked: null, focusReq: null };
  if (pick.role !== null && rows.some((r) => r.name === pick.role)) return { marked: null, focusReq: { role: pick.role, schema: pick.schema, n: 1, open: true } };
  return { marked: pick.schema, focusReq: rows.length > 0 ? { role: rows[0].name, schema: pick.schema, n: 1 } : null };
}

/** 데이터베이스 보기를 칸과 데이터베이스 권한으로 바로 찾을 수 있게 정리한다. 보기에 없는 역할의 칸은 비어 있는 것으로 본다. */
interface ViewIndex {
  /** 이름순 */
  schemas: string[];
  cell: (role: string, schema: string) => PgSchemaCell;
  database: (role: string) => PgDbPrivilegeRow;
}

function indexOf(view: PgDatabaseView): ViewIndex {
  const cells = new Map<string, Map<string, PgSchemaCell>>();
  for (const c of view.cells) {
    let bySchema = cells.get(c.role);
    if (!bySchema) cells.set(c.role, (bySchema = new Map()));
    bySchema.set(c.schema, c);
  }
  const databases = new Map(view.dbPrivileges.map((p) => [p.role, p]));
  return {
    schemas: view.schemas.map((s) => s.name).sort(collate),
    cell: (role, schema) => cells.get(role)?.get(schema) ?? emptyCell(role, schema),
    database: (role) => databases.get(role) ?? { role, connect: false, create: false, temp: false },
  };
}

const yesNo = (on: boolean) => (on ? "o" : "x");
const flag = (on: boolean) => ({ glyph: on ? "●" : "○", tone: on ? "all" : "none" });
const coverage = (c: PgCoverage) => ({ glyph: c === "all" ? "●" : c === "some" ? "◐" : "○", tone: c });

const cellName = (c: PgSchemaCell) => `${c.role} · ${c.schema}: 사용 ${yesNo(c.usage)}, 만들기 ${yesNo(c.create)}, 읽기 ${COVERAGE_LABEL[c.read]}, 쓰기 ${COVERAGE_LABEL[c.write]}`;
const databaseName = (p: PgDbPrivilegeRow) => `${p.role} · 데이터베이스: CONNECT ${yesNo(p.connect)}, CREATE ${yesNo(p.create)}, TEMP ${yesNo(p.temp)}`;
/** 칸에 마우스를 올리면 보이는 설명: 흐린 이유와 못 쓰는 이유 */
const cellNote = (c: PgSchemaCell) => [c.inheritedOnly ? INHERITED_ONLY_TEXT : null, c.unusable ? unusableText(c.unusable) : null].filter(Boolean).join(" · ") || undefined;

function Mark({ glyph, tone }: { glyph: string; tone: string }) {
  return (
    <span className={`pg-mark pg-${tone}`} aria-hidden="true">
      {glyph}
    </span>
  );
}

interface Props {
  target: PgTarget;
  overview: PgOverview;
  /** 이 탭에서 고른 데이터베이스(PgTab이 들고 있다). 없거나 연결할 수 없으면 대상의 기본 데이터베이스 */
  database: string | undefined;
  onDatabase: (database: string) => void;
  /** 툴바 필터. 역할 이름에 적용한다 */
  filter: string;
  /** 종류 칩과 시스템 역할 토글의 상태. 역할 목록과 같은 것을 쓴다(탭이 들고 있다) */
  kinds: RoleKindsValue;
  onKinds: (next: RoleKindsValue) => void;
  /**
   * 점검 항목이 이 표를 열면서 부탁한 것(스키마를 고르고, 항목이 역할도 가리키면 그 칸을 연다). 고른 데이터베이스가 부탁의 데이터베이스일 때
   * 표가 처음 그려지면서 한 번 쓰고 onPickUsed로 알린다. 알리면 부른 쪽이 비운다(비우지 않으면 데이터베이스를 바꿨다 돌아올 때 다시 쓴다).
   */
  pick?: SchemaFocus | null;
  onPickUsed?: () => void;
}

/**
 * 권한 표(데이터베이스 하나): 역할 × 스키마. 칸 하나는 그 스키마의 사용·만들기와 그 스키마 테이블의 읽기·쓰기를 보이고,
 * 누르면 오른쪽에 그 칸의 객체별 권한과 출처(CellPanel)가 나온다. 이 단계에서 칸은 읽기만 한다.
 * 데이터베이스 선택은 표 위에 있고, 종류 칩과 필터는 역할 목록과 같다.
 */
export function PrivilegeGrid({ target, overview, database, onDatabase, filter, kinds, onKinds, pick = null, onPickUsed }: Props) {
  return (
    <DatabaseScreen overview={overview} database={database} onDatabase={onDatabase} bar={<RoleKinds value={kinds} onChange={onKinds} />}>
      {(db) => (
        <DatabasePrivileges
          target={target}
          overview={overview}
          database={db}
          filter={filter}
          kinds={kinds}
          pick={pick && pick.database === db ? pick : null}
          onPickUsed={onPickUsed}
        />
      )}
    </DatabaseScreen>
  );
}

interface BodyProps {
  target: PgTarget;
  overview: PgOverview;
  database: string;
  filter: string;
  kinds: RoleKindsValue;
  /** 이 데이터베이스에 대한 점검의 부탁. 없으면 null */
  pick: SchemaFocus | null;
  onPickUsed?: () => void;
}

function DatabasePrivileges({ target, overview, database, filter, kinds, pick, onPickUsed }: BodyProps) {
  const q = usePgDatabase(target, database);
  const view = q.data;
  const [selected, setSelected] = useState<CellKey | null>(null);
  // 점검에서 열렸으면 첫 모습을 부탁에서 정한다(openedFrom). 처음 그려질 때만 정하고, 그 뒤로는 사용자가 정한다.
  const [start] = useState(() => openedFrom(pick, shownRows(overview.roles, kinds, filter)));
  const [marked, setMarked] = useState<string | null>(start.marked);
  const [focusReq, setFocusReq] = useState<FocusReq | null>(start.focusReq);
  // 부탁은 한 번만 쓰고 알린다(strict mode가 효과를 두 번 돌려도 한 번이다)
  const told = useRef(false);
  useEffect(() => {
    if (!pick || told.current) return;
    told.current = true;
    onPickUsed?.();
  }, [pick, onPickUsed]);

  const rows = useMemo(() => shownRows(overview.roles, kinds, filter), [overview.roles, kinds, filter]);
  const index = useMemo(() => (view ? indexOf(view) : null), [view]);

  // 상세는 지금 표에 보이는 칸에게만 둔다: 그 역할의 행(필터, 칩)과 그 스키마의 열(다시 읽기)이 있어야 한다.
  // 없어지면 고른 칸도 버린다. 남겨 두면 행이나 열이 돌아왔을 때 상세가 저절로 다시 열리고 초점까지 가져간다.
  const summary = selected ? rows.find((r) => r.name === selected.role) : undefined;
  const open = selected && summary && index?.schemas.includes(selected.schema) ? selected : null;
  const gone = !!selected && !open && !!index;
  useEffect(() => {
    if (gone) setSelected(null);
  }, [gone]);

  if (!view || !index) return q.isError ? <PgError error={q.error} target={target} /> : <div className="empty">불러오는 중…</div>;

  const dismiss = () => setSelected(null); // 표에서 누른 Esc: 초점은 사용자가 있는 칸에 그대로 둔다
  const close = () => {
    // 상세 안에서 누른 Esc와 [닫기]: 상세가 닫힌 다음에 초점을 상세를 연 칸으로 돌려 달라고 표에게 부탁한다
    if (selected) setFocusReq((req) => ({ ...selected, n: (req?.n ?? 0) + 1 }));
    setSelected(null);
  };
  const empty = rows.length === 0 ? (overview.roles.length === 0 ? "역할이 없어요" : "조건에 맞는 역할이 없어요") : index.schemas.length === 0 ? "스키마가 없어요" : null;

  return (
    <>
      {q.isError && <PgError compact error={q.error} target={target} />}
      {view.truncated && <div className="notice">{TRUNCATED_TEXT}</div>}
      <div className="pg-split">
        <Grid
          rows={rows}
          index={index}
          empty={empty}
          selected={open}
          marked={marked}
          focusReq={focusReq}
          onOpen={(key) => {
            setMarked(null);
            setSelected(key);
          }}
          onDismiss={dismiss}
        />
        {open && summary && (
          <CellPanel
            target={target}
            database={database}
            role={open.role}
            schema={open.schema}
            unusable={index.cell(open.role, open.schema).unusable}
            bypassRls={summary.attributes.bypassRls}
            onClose={close}
          />
        )}
      </div>
    </>
  );
}

interface GridProps {
  /** 보일 역할: 사용자 먼저, 그다음 그룹 */
  rows: PgRoleSummary[];
  index: ViewIndex;
  /** 행이나 열이 없을 때 표 아래에 보일 말 */
  empty: string | null;
  /** 상세가 열려 있는 칸 */
  selected: CellKey | null;
  /** 점검이 가리킨 스키마. 그 열의 머리에 표시를 한다 */
  marked: string | null;
  focusReq: FocusReq | null;
  onOpen: (key: CellKey) => void;
  /** 표에서 누른 Esc가 열린 상세를 닫는다 */
  onDismiss: () => void;
}

/**
 * 표 자체. 키보드(ARIA 격자 패턴): 화살표로 칸을 옮기고(데이터베이스 열의 칸도 읽기만 하는 칸으로 닿는다), Enter(스키마 칸은 버튼이다)로 상세를 연다.
 * PageUp/PageDown은 보이는 한 쪽만큼, Home/End는 행의 처음과 끝(데이터베이스 열과 마지막 스키마)으로, ⌘·Ctrl+Home/End는 표의 첫 칸과 끝 칸으로 옮긴다.
 * Esc는 열린 상세를 닫는다. 초점은 한 칸만 탭이 닿는다(roving tabindex). 행은 보이는 부분만 그린다(고정 행 높이). 머리 행과 머리 열은 고정한다.
 */
function Grid({ rows, index, empty, selected, marked, focusReq, onOpen, onDismiss }: GridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const [topRow, setTopRow] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [active, setActive] = useState<GridKey | null>(null);
  /** 그려진 다음에 초점을 줄 칸 */
  const [pending, setPending] = useState<{ pos: Pos; n: number } | null>(null);
  const { schemas } = index;

  const { lines, at } = useMemo(() => {
    const count: Record<PgRoleKind, number> = { user: 0, group: 0 };
    rows.forEach((row) => count[row.kind]++);
    const lines: Line[] = [];
    const at: number[] = []; // 데이터 행 번호 → lines 번호
    let last: PgRoleKind | null = null;
    rows.forEach((row, r) => {
      if (row.kind !== last) {
        lines.push({ type: "head", kind: row.kind, count: count[row.kind] });
        last = row.kind;
      }
      at[r] = lines.length;
      lines.push({ type: "row", r });
    });
    return { lines, at };
  }, [rows]);
  const rowOf = useMemo(() => new Map(rows.map((row, r) => [row.name, r])), [rows]);
  const columnOf = useMemo(() => new Map(schemas.map((schema, c) => [schema, c])), [schemas]);

  // 보이는 구간
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const height = viewport > 0 ? viewport : FALLBACK_VIEWPORT;
  // 줄이 줄어서 맨 위 행 번호가 줄 수를 넘었으면(필터) 스크롤 이벤트가 바로잡을 때까지 마지막 쪽을 그린다
  const { start, end } = visibleRange(Math.min(topRow, lines.length) * ROW_H, height, ROW_H, lines.length, OVERSCAN);
  const drawn = (r: number) => at[r] >= start && at[r] < end;

  /** 줄 번호의 행이 머리 행에 가리지 않게 스크롤한다 */
  const reveal = (line: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const body = (el.clientHeight > 0 ? el.clientHeight : FALLBACK_VIEWPORT) - HEAD_H; // 머리 아래로 보이는 높이
    const top = line * ROW_H;
    let next = el.scrollTop;
    if (top < next) next = top;
    else if (top + ROW_H > next + body) next = top + ROW_H - body;
    if (next !== el.scrollTop) el.scrollTop = next;
    setTopRow(Math.floor(next / ROW_H));
  };

  const focusable = (p: Pos) => p.r >= 0 && p.r < rows.length && p.c >= DB_COL && p.c < schemas.length;
  const posOf = (key: GridKey | null): Pos | null => {
    const r = key ? rowOf.get(key.role) : undefined;
    const c = key ? (key.schema === null ? DB_COL : columnOf.get(key.schema)) : undefined;
    return r === undefined || c === undefined ? null : { r, c };
  };
  const keyOf = (pos: Pos): GridKey => ({ role: rows[pos.r].name, schema: pos.c === DB_COL ? null : schemas[pos.c] });

  // 탭이 닿는 칸: 마지막으로 초점이 갔거나 누른 칸. 없거나 안 그려져 있으면(스크롤로 벗어남) 첫 스키마 칸
  // (스키마가 없으면 데이터베이스 열의 첫 칸), 그것도 안 그려져 있으면 그려진 첫 행의 같은 칸
  const homeCol = schemas.length > 0 ? 0 : DB_COL;
  const activePos = posOf(active);
  const firstDrawn = lines.slice(start, end).find((l): l is Extract<Line, { type: "row" }> => l.type === "row");
  const roving: Pos | null =
    activePos && drawn(activePos.r)
      ? activePos
      : rows.length > 0 && drawn(0)
        ? { r: 0, c: homeCol }
        : firstDrawn
          ? { r: firstDrawn.r, c: homeCol }
          : null;
  const stop = (r: number, c: number) => (roving && roving.r === r && roving.c === c ? 0 : -1);

  // 초점을 옮겨야 할 때: 그 행을 그린 다음에 초점을 준다
  useLayoutEffect(() => {
    if (pending) scrollRef.current?.querySelector<HTMLElement>(`[data-pos="${posKey(pending.pos.r, pending.pos.c)}"]`)?.focus();
  }, [pending]);
  const goTo = (pos: Pos) => {
    setActive(keyOf(pos));
    reveal(at[pos.r]);
    setPending((p) => ({ pos, n: (p?.n ?? 0) + 1 }));
  };

  // 상세를 닫으면서 칸으로 초점을 돌려 달라고 부탁받았을 때. 부탁 하나에 한 번만 한다.
  const handled = useRef(0);
  useLayoutEffect(() => {
    if (!focusReq || focusReq.n === handled.current) return;
    handled.current = focusReq.n;
    const pos = posOf(focusReq);
    if (!pos) return;
    goTo(pos);
    if (focusReq.open) onOpen({ role: focusReq.role, schema: focusReq.schema });
  });

  const press = (key: CellKey) => {
    setActive(key); // 브라우저가 버튼에 초점을 주지 않아도(Safari) 탭이 닿는 칸은 누른 칸이다
    onOpen(key);
  };

  // 한 쪽 = 머리 행 아래로 지금 보이는 줄 수(종류 머리도 한 줄이다). 아주 작아도 한 줄은 움직인다.
  const pageLines = Math.max(1, Math.floor((height - HEAD_H) / ROW_H));
  /** 한 쪽 아래(dir 1)나 위(-1)의 행. 맨 끝을 넘으면 끝 행이고, 도착한 줄이 종류 머리면 가는 방향의 다음 행이다. */
  const pageRow = (r: number, dir: 1 | -1) => {
    const line = Math.min(Math.max(at[r] + dir * pageLines, 0), lines.length - 1);
    if (dir === 1) {
      for (let i = 0; i < rows.length; i++) if (at[i] >= line) return i;
      return rows.length - 1;
    }
    for (let i = rows.length - 1; i >= 0; i--) if (at[i] <= line) return i;
    return 0;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    if (e.altKey) return;
    // ⌘나 Ctrl과 함께 누른 키는 앱의 것이다(⌘C, ⌘F, ⌘[ …). 격자의 모서리로 가는 ⌘·Ctrl+Home/End만 받는다.
    const corner = (e.metaKey || e.ctrlKey) && (e.key === "Home" || e.key === "End");
    if ((e.metaKey || e.ctrlKey) && !corner) return;
    if (e.key === "Escape") {
      if (selected) {
        e.preventDefault();
        onDismiss();
      }
      return;
    }
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-pos]");
    if (!el?.dataset.pos) return;
    const from = parsePos(el.dataset.pos);
    if (e.key === " ") {
      // 데이터베이스 열의 칸은 읽기만 하는 칸이라 Space로 할 일이 없다. 그냥 두면 브라우저가 격자를 한 쪽 스크롤해서 초점이 있는 행이 사라질 수 있다.
      // 스키마 칸은 버튼이라 Space가 눌림이다. 막지 않는다.
      if (from.c === DB_COL) e.preventDefault();
      return;
    }
    const lastRow = rows.length - 1;
    const lastCol = schemas.length - 1; // 스키마가 없으면 데이터베이스 열(DB_COL)
    let to: Pos;
    switch (e.key) {
      case "ArrowDown":
        to = { r: from.r + 1, c: from.c };
        break;
      case "ArrowUp":
        to = { r: from.r - 1, c: from.c };
        break;
      case "ArrowRight":
        to = { r: from.r, c: from.c + 1 };
        break;
      case "ArrowLeft":
        to = { r: from.r, c: from.c - 1 };
        break;
      case "PageDown":
        to = { r: pageRow(from.r, 1), c: from.c };
        break;
      case "PageUp":
        to = { r: pageRow(from.r, -1), c: from.c };
        break;
      case "Home":
        to = { r: corner ? 0 : from.r, c: DB_COL };
        break;
      case "End":
        to = { r: corner ? lastRow : from.r, c: lastCol };
        break;
      default:
        return; // Enter는 버튼이 눌린 것으로 받는다. 데이터베이스 열의 칸은 버튼이 아니라서 아무 일도 없다
    }
    // 브라우저도 이 키들로 스크롤하므로(맨 끝에서도) 막는다
    e.preventDefault();
    if (focusable(to)) goTo(to);
  };

  const onFocusAt = (key: GridKey) => setActive((a) => (a && a.role === key.role && a.schema === key.schema ? a : key));
  const onScroll = (e: UIEvent<HTMLDivElement>) => setTopRow(Math.floor(e.currentTarget.scrollTop / ROW_H));

  const span = schemas.length + 2;
  const spacer = (key: string, h: number) => (
    <tr key={key} role="presentation" aria-hidden="true" className="pg-spacer" style={{ height: h }}>
      <td colSpan={span} />
    </tr>
  );

  return (
    <div className="pg-grid">
      <div className="pg-scroll" ref={scrollRef} style={SIZES} onScroll={onScroll}>
        <table
          role="grid"
          aria-label="권한 표"
          aria-rowcount={lines.length + 1}
          aria-colcount={span}
          className="pg-table"
          style={{ width: NAME_W + DB_W + schemas.length * CELL_W }}
          onKeyDown={onKeyDown}
        >
          <colgroup>
            <col style={{ width: NAME_W }} />
            <col style={{ width: DB_W }} />
            {schemas.map((schema) => (
              <col key={schema} style={{ width: CELL_W }} />
            ))}
          </colgroup>
          <thead>
            <tr role="row" aria-rowindex={1} style={{ height: HEAD_H }}>
              <th role="columnheader" scope="col" className="pg-corner">
                <div className="pg-colname">역할</div>
              </th>
              <th role="columnheader" scope="col" className="pg-colhead">
                <div className="pg-colname">데이터베이스</div>
                {/* 칸의 표시가 무엇인지 눈으로 보는 사람을 위한 안내. 칸마다 이름이 있어서 읽어 주는 도구에는 되풀이하지 않는다 */}
                <div className="pg-legend pg-legend-db" aria-hidden="true">
                  <span>CONNECT</span>
                  <span>CREATE</span>
                  <span>TEMP</span>
                </div>
              </th>
              {schemas.map((schema) => (
                <th key={schema} role="columnheader" scope="col" className="pg-colhead" aria-selected={marked === schema ? true : undefined}>
                  <div className="pg-colname" title={schema}>
                    {schema}
                  </div>
                  <div className="pg-legend" aria-hidden="true">
                    <span>사용</span>
                    <span>만들기</span>
                    <span>읽기</span>
                    <span>쓰기</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* 행의 키는 "row:", 종류 머리의 키는 "head:"를 앞에 붙인다. 역할 이름이 "head-user"여도 종류 머리와 키가 겹치지 않는다 */}
            {start > 0 && spacer("before", start * ROW_H)}
            {lines.slice(start, end).map((line, k) => {
              const lineNo = start + k;
              if (line.type === "head") {
                return (
                  <tr key={`head:${line.kind}`} role="row" aria-rowindex={lineNo + 2} className="pg-group" style={{ height: ROW_H }}>
                    <th role="rowheader" className="pg-rowhead">
                      <span>{ROLE_KIND_LABEL[line.kind]}</span> <span className="dim">{line.count}</span>
                    </th>
                    <td aria-hidden="true" colSpan={span - 1} />
                  </tr>
                );
              }
              const { r } = line;
              const row = rows[r];
              const db = index.database(row.name);
              return (
                <tr key={`row:${row.name}`} role="row" aria-rowindex={lineNo + 2} className={`pg-row${lineNo % 2 ? " pg-even" : ""}`} style={{ height: ROW_H }}>
                  <th role="rowheader" scope="row" className="pg-rowhead" title={row.name}>
                    {row.name}
                  </th>
                  <td
                    role="gridcell"
                    className="pg-td pg-dbcell"
                    data-pos={posKey(r, DB_COL)}
                    aria-label={databaseName(db)}
                    tabIndex={stop(r, DB_COL)}
                    onFocus={() => onFocusAt({ role: row.name, schema: null })}
                  >
                    <div className="pg-marks">
                      <Mark {...flag(db.connect)} />
                      <Mark {...flag(db.create)} />
                      <Mark {...flag(db.temp)} />
                    </div>
                  </td>
                  {schemas.map((schema, c) => {
                    const cell = index.cell(row.name, schema);
                    const key = { role: row.name, schema };
                    const picked = selected?.role === row.name && selected.schema === schema;
                    const whyId = `${uid}-${posKey(r, c)}`;
                    return (
                      <td key={schema} role="gridcell" aria-selected={picked ? true : undefined} className={`pg-td${picked ? " pg-picked" : ""}`}>
                        <button
                          type="button"
                          className={`pg-cell${cell.inheritedOnly ? " pg-dimmed" : ""}${cell.unusable ? " pg-unusable" : ""}`}
                          data-pos={posKey(r, c)}
                          aria-label={cellName(cell)}
                          aria-describedby={cell.unusable ? whyId : undefined}
                          title={cellNote(cell)}
                          tabIndex={stop(r, c)}
                          onFocus={() => onFocusAt(key)}
                          onClick={() => press(key)}
                        >
                          <Mark {...flag(cell.usage)} />
                          <Mark {...flag(cell.create)} />
                          <Mark {...coverage(cell.read)} />
                          <Mark {...coverage(cell.write)} />
                          {cell.unusable && (
                            <>
                              {/* 키보드로 이 칸에 왔을 때만 보이는 짧은 이유(CSS의 :focus-visible). 칸 크기를 넘지 않게 표시 자리를 덮는다 */}
                              <span className="pg-hint" aria-hidden="true">
                                {cell.unusable}
                              </span>
                              <span className="pg-warn-mark" aria-hidden="true">
                                ⚠
                              </span>
                            </>
                          )}
                        </button>
                        {/* ⚠를 보지 못하는 사람에게는 이유를 칸의 설명으로 읽어 준다(이름은 그대로 둔다) */}
                        {cell.unusable && (
                          <span id={whyId} className="sr-only">
                            {unusableText(cell.unusable)}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {end < lines.length && spacer("after", (lines.length - end) * ROW_H)}
          </tbody>
        </table>
        {empty && <div className="empty small">{empty}</div>}
      </div>
    </div>
  );
}
