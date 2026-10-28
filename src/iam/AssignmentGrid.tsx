import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type UIEvent } from "react";
import { BadgeList } from "./Badges";
import { isActual, isEditable, isShown, policyCell, rowKey, type AssignmentTab, type Column } from "./assignments";
import { GridPopover } from "./GridPopover";
import { parsePos, posKey, type Pos } from "./gridPos";
import { KIND_LABEL } from "./labels";
import { SCOPE_LABEL } from "./PolicyList";
import { changeBlockReason } from "./protect";
import { policyRoute, principalRoute, type IamRoute } from "./route";
import type { IamOverview, PrincipalKind, PrincipalSummary } from "./types";
import type { useAssignmentDraft } from "./useAssignmentDraft";
import { takeFocus, usePaintDrag } from "./usePaintDrag";

/** 데이터 행의 높이. 고정이라서 보이는 행만 그릴 수 있다 */
export const ROW_H = 28;
/** 열 머리 행의 높이. 머리는 위에 붙어 있어서 본문의 첫 이만큼이 가려진다. 정책 이름이 두 줄까지 들어간다 */
const HEAD_H = 76;
/** 보이는 구간 위아래로 더 그리는 행 수 */
const OVERSCAN = 10;
/** 아직 크기를 못 쟀을 때(첫 그림, 레이아웃이 없는 환경) 쓰는 표 높이 */
const FALLBACK_VIEWPORT = 600;
const NAME_W = 240;
const CELL_W = 144;
const END_W = 136;
/** 머리 행과 머리 열이 가리는 만큼을 CSS(scroll-padding)도 알아야 해서 같은 값을 변수로 넘긴다 */
const SIZES = { "--asg-head": `${HEAD_H}px`, "--asg-name": `${NAME_W}px`, "--asg-end": `${END_W}px` } as CSSProperties;

const NO_ROWS = "보여줄 행이 없어요";
const NO_COLUMNS: Record<AssignmentTab, string> = { policies: "붙은 정책이 없어요. 열 추가로 정책을 더해 보세요", members: "그룹이 없어요" };

/**
 * 보이는 행 구간 [start, end). 한 줄씩 높이가 같다는 것이 전제다.
 * 걸쳐 있는 행도 보이는 것으로 치고, 위아래로 overscan행씩 더 그린다.
 */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan: number) {
  const top = Math.max(0, scrollTop);
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + Math.max(0, viewport)) / rowHeight);
  return { start: Math.max(0, Math.min(count, first - overscan)), end: Math.max(0, Math.min(count, last + overscan)) };
}

type Draft = Pick<ReturnType<typeof useAssignmentDraft>, "items" | "toggle" | "paint" | "remove">;

/** 그려지는 줄: 종류 머리이거나 데이터 행(r은 rows의 번호) */
type Line = { type: "head"; kind: PrincipalKind; count: number } | { type: "row"; r: number };

/** 칸 위에 떠 있는 작은 창: 그룹으로 받은 칸의 안내이거나 행 메뉴. 행은 번호가 아니라 ARN으로 가리킨다 */
type Pop = { type: "via"; at: string; groups: string[]; trigger: HTMLElement } | { type: "menu"; arn: string; trigger: HTMLElement };

interface CellView {
  state: string;
  glyph: string;
  tone: "on" | "off" | "via" | "add" | "del";
  /** ●에 ◐를 겹친다: 직접 붙고 그룹으로도 받는 칸 */
  overlay: boolean;
}

/** 칸의 모양과 읽어 줄 상태. 대기 중인 변경이 있으면 그것이 먼저다 */
function cellView(ov: IamOverview, tab: AssignmentTab, queued: ReadonlySet<string>, row: PrincipalSummary, column: string): CellView {
  const pending = queued.has(rowKey(tab, row, column));
  if (tab === "members") {
    const member = isActual(ov, tab, row, column);
    if (pending) return member ? { state: "뺄 예정", glyph: "－", tone: "del", overlay: false } : { state: "넣을 예정", glyph: "＋", tone: "add", overlay: false };
    return member ? { state: "속함", glyph: "●", tone: "on", overlay: false } : { state: "안 속함", glyph: "○", tone: "off", overlay: false };
  }
  const { direct, via } = policyCell(ov, row, column);
  const overlay = direct && via.length > 0;
  if (pending) return direct ? { state: "뗄 예정", glyph: "－", tone: "del", overlay } : { state: "붙일 예정", glyph: "＋", tone: "add", overlay };
  const groups = via.join(", ");
  if (direct) return { state: overlay ? `직접 붙음, ${groups} 그룹에서도 받음` : "직접 붙음", glyph: "●", tone: "on", overlay };
  if (via.length > 0) return { state: `${groups} 그룹에서 받음`, glyph: "◐", tone: "via", overlay: false };
  return { state: "없음", glyph: "○", tone: "off", overlay: false };
}

interface Props {
  overview: IamOverview;
  tab: AssignmentTab;
  /** 보여 줄 행. 같은 종류끼리 이어져 있다 */
  rows: PrincipalSummary[];
  columns: Column[];
  draft: Draft;
  /** 종류별 머리 줄을 둔다(정책 탭) */
  grouped: boolean;
  onOpen: (route: IamRoute) => void;
  /** 행 메뉴의 "다른 주체와 같게" */
  onMatch: (row: PrincipalSummary) => void;
}

/**
 * 할당 표: 주체 × 관리형 정책(정책 탭), 사용자 × 그룹(그룹 구성원 탭).
 * - 칸을 누르면 담고, 누른 채 끌면 지나간 칸을 처음 칸의 결과대로 칠한다. 빨리 끌어도 사이 칸을 건너뛰지 않는다.
 * - 키보드: 화살표 이동, Space 토글, Shift+화살표 범위, Esc 범위 지우기. 초점은 한 칸만 탭이 닿는다(roving tabindex).
 * - 행은 보이는 부분만 그린다(고정 행 높이). 머리 행과 머리 열은 고정한다.
 */
export function AssignmentGrid({ overview, tab, rows, columns, draft, grouped, onOpen, onMatch }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  const [topRow, setTopRow] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [active, setActive] = useState<Pos | null>(null);
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const [focusReq, setFocusReq] = useState<{ pos: Pos; n: number } | null>(null);

  const { lines, at } = useMemo(() => {
    const count: Record<PrincipalKind, number> = { user: 0, group: 0, role: 0 };
    rows.forEach((row) => count[row.kind]++);
    const lines: Line[] = [];
    const at: number[] = []; // 데이터 행 번호 → lines 번호
    let last: PrincipalKind | null = null;
    rows.forEach((row, r) => {
      if (grouped && row.kind !== last) {
        lines.push({ type: "head", kind: row.kind, count: count[row.kind] });
        last = row.kind;
      }
      at[r] = lines.length;
      lines.push({ type: "row", r });
    });
    return { lines, at };
  }, [rows, grouped]);
  const locks = useMemo(() => rows.map(changeBlockReason), [rows]);
  const queued = useMemo(() => new Set(draft.items.map((d) => d.key)), [draft.items]);
  const withEnd = tab === "policies";

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
  const view = viewport > 0 ? viewport : FALLBACK_VIEWPORT;
  // 줄이 줄어서 맨 위 행 번호가 줄 수를 넘었으면(필터) 스크롤 이벤트가 바로잡을 때까지 마지막 쪽을 그린다
  const { start, end } = visibleRange(Math.min(topRow, lines.length) * ROW_H, view, ROW_H, lines.length, OVERSCAN);
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

  // 초점이 갈 수 있는 자리: 머리와 꺼지지 않은 칸. 잠긴 행의 칸은 꺼져 있어서 건너뛴다
  const focusable = (p: Pos) => {
    if (p.r < -1 || p.c < -1 || p.r >= rows.length || p.c >= columns.length) return false;
    if (p.r < 0 && p.c < 0) return false;
    return p.r < 0 || p.c < 0 || !locks[p.r];
  };
  /** 탭이 처음 닿는 자리: 첫 칸. 칠 수 있는 칸이 없으면 첫 행의 머리나 첫 열의 머리 */
  const home = useMemo<Pos | null>(() => {
    const r = locks.findIndex((lock) => !lock);
    if (r >= 0 && columns.length > 0) return { r, c: 0 };
    if (rows.length > 0) return { r: 0, c: -1 };
    return columns.length > 0 ? { r: -1, c: 0 } : null;
  }, [locks, rows.length, columns.length]);
  // 초점이 있던 자리가 안 그려져 있으면(스크롤로 벗어남) 그려진 첫 행의 머리가 탭이 닿는 곳이 된다
  const firstDrawn = lines.slice(start, end).find((l): l is Extract<Line, { type: "row" }> => l.type === "row");
  const roving: Pos | null =
    active && focusable(active) && (active.r < 0 || drawn(active.r))
      ? active
      : home && (home.r < 0 || drawn(home.r))
        ? home
        : firstDrawn
          ? { r: firstDrawn.r, c: -1 }
          : columns.length > 0
            ? { r: -1, c: 0 }
            : null;
  const stop = (r: number, c: number) => (roving && roving.r === r && roving.c === c ? 0 : -1);

  // 초점을 옮겨야 할 때: 그 행을 그린 다음에 초점을 준다
  useLayoutEffect(() => {
    if (focusReq) scrollRef.current?.querySelector<HTMLElement>(`[data-pos="${posKey(focusReq.pos.r, focusReq.pos.c)}"]`)?.focus();
  }, [focusReq]);
  const goTo = (pos: Pos) => {
    setActive(pos);
    if (pos.r >= 0) reveal(at[pos.r]);
    setFocusReq((req) => ({ pos, n: (req?.n ?? 0) + 1 }));
  };

  // 보이는 행이 바뀌면(종류 칩, 필터, 개요 다시 읽기) 자리로 가리키던 범위와 떠 있는 창은 더는 맞지 않는다
  useEffect(() => {
    setAnchor(null);
    setPop(null);
  }, [rows]);

  const closePop = useCallback(() => setPop(null), []);

  const openRow = (r: number) => onOpen(principalRoute(rows[r].kind, rows[r].arn));
  const openColumn = (c: number) => {
    const column = columns[c];
    if (tab === "policies") {
      onOpen(policyRoute(overview.policies.find((p) => p.arn === column.id)?.id ?? column.id));
      return;
    }
    const group = overview.groups.find((g) => g.name === column.id);
    if (group) onOpen(principalRoute("group", group.arn));
  };
  const openHeader = (pos: Pos) => (pos.r >= 0 ? openRow(pos.r) : openColumn(pos.c));
  /** 그룹으로 받은 칸의 [그룹 행으로 가기]. 그 행이 안 보이면(종류 칩, 필터) 그룹 상세를 연다 */
  const goToGroup = (name: string) => {
    setPop(null);
    const group = overview.groups.find((g) => g.name === name);
    if (!group) return;
    const r = rows.findIndex((row) => row.arn === group.arn);
    if (r < 0) onOpen(principalRoute("group", group.arn));
    else goTo({ r, c: -1 });
  };

  /**
   * 칸 하나를 누른 것: 바꿀 수 있으면 토글, 그룹으로만 받은 칸이면 어디서 받는지 알려 준다.
   * 그런데 담아 둔 변경이 있는 칸이 개요를 다시 읽은 뒤 그룹으로만 받는 칸이 됐으면(담은 붙이기는 직접 붙은 것이 아니라서 남는다) 안내 대신 그 변경을 뺀다.
   */
  const press = (r: number, c: number, trigger: HTMLElement) => {
    if (locks[r]) return;
    const row = rows[r];
    const column = columns[c].id;
    if (isEditable(overview, tab, row, column)) {
      draft.toggle(tab, row, column);
      return;
    }
    const key = rowKey(tab, row, column);
    if (queued.has(key)) {
      draft.remove(key);
      return;
    }
    const groups = policyCell(overview, row, column).via;
    if (groups.length === 0) return;
    const at = posKey(r, c);
    setPop((p) => (p?.type === "via" && p.at === at ? null : { type: "via", at, groups, trigger }));
  };
  const drag = usePaintDrag({ overview, tab, rows, columns, draft, press, onStart: () => setAnchor(null) });

  // 범위: 기준 칸과 지금 초점 칸이 이루는 사각형. 한 칸이면 범위가 아니다
  const range = useMemo(() => {
    if (!anchor || !active || anchor.r < 0 || anchor.c < 0 || active.r < 0 || active.c < 0) return null;
    if (anchor.r >= rows.length || active.r >= rows.length || anchor.c >= columns.length || active.c >= columns.length) return null;
    if (anchor.r === active.r && anchor.c === active.c) return null;
    return { r1: Math.min(anchor.r, active.r), r2: Math.max(anchor.r, active.r), c1: Math.min(anchor.c, active.c), c2: Math.max(anchor.c, active.c) };
  }, [anchor, active, rows.length, columns.length]);
  const inRange = (r: number, c: number) => !!range && r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;

  /** 범위에서 Space: 기준 칸을 토글한 결과를 목표로 범위 전체에 칠하기와 같은 규칙을 적용한다 */
  const paintRange = () => {
    if (!range || !anchor) return;
    const base = rows[anchor.r];
    const baseColumn = columns[anchor.c].id;
    if (!isEditable(overview, tab, base, baseColumn)) return;
    const want = !isShown(draft.items, overview, tab, base, baseColumn);
    const cells: { row: PrincipalSummary; column: string }[] = [];
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) cells.push({ row: rows[r], column: columns[c].id });
    draft.paint(tab, cells, want);
  };

  /** 화살표가 가는 다음 자리. 갈 수 없는 자리는 건너뛰고, 끝이면 null */
  const step = (from: Pos, key: string): Pos | null => {
    const dr = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
    const dc = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
    for (let p = { r: from.r + dr, c: from.c + dc }; p.r >= -1 && p.r < rows.length && p.c >= -1 && p.c < columns.length; p = { r: p.r + dr, c: p.c + dc }) {
      if (focusable(p)) return p;
    }
    return null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-pos]");
    if (!el?.dataset.pos) return;
    const pos = parsePos(el.dataset.pos);
    const isCell = pos.r >= 0 && pos.c >= 0;
    drag.forget();
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const to = step(pos, e.key);
        if (!to) return;
        // Shift면 범위를 넓힌다. 머리가 끼면 범위가 아니다
        const extend = e.shiftKey && isCell && to.r >= 0 && to.c >= 0;
        setAnchor(extend ? (a) => a ?? pos : null);
        goTo(to);
        return;
      }
      case " ":
        if (!isCell) return; // 머리의 Space는 버튼 그대로 연다
        e.preventDefault();
        if (range) paintRange();
        else press(pos.r, pos.c, el);
        return;
      case "Enter":
        if (isCell) return; // 칸의 Enter는 버튼 그대로 누른다
        e.preventDefault();
        openHeader(pos);
        return;
      case "Escape":
        if (anchor) {
          e.preventDefault();
          setAnchor(null);
        }
        return;
    }
  };

  const onFocusAt = (r: number, c: number) => setActive((a) => (a && a.r === r && a.c === c ? a : { r, c }));

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    setTopRow(Math.floor(e.currentTarget.scrollTop / ROW_H));
    setPop(null);
  };

  const menuRow = pop?.type === "menu" ? rows.find((row) => row.arn === pop.arn) : undefined;
  const menuLock = menuRow ? changeBlockReason(menuRow) : null;
  const span = columns.length + (withEnd ? 2 : 1);
  const empty = rows.length === 0 ? NO_ROWS : columns.length === 0 ? NO_COLUMNS[tab] : null;
  const spacer = (key: string, height: number) => (
    <tr key={key} role="presentation" aria-hidden="true" className="asg-spacer" style={{ height }}>
      <td colSpan={span} />
    </tr>
  );

  return (
    <div className="asg-wrap">
      <div className="asg-scroll" ref={scrollRef} style={SIZES} onScroll={onScroll}>
        <table
          role="grid"
          aria-label="할당 표"
          aria-rowcount={lines.length + 1}
          aria-colcount={span}
          className="asg-table"
          style={{ width: NAME_W + columns.length * CELL_W + (withEnd ? END_W : 0) }}
          onKeyDown={onKeyDown}
        >
          <colgroup>
            <col style={{ width: NAME_W }} />
            {columns.map((c) => (
              <col key={c.id} style={{ width: CELL_W }} />
            ))}
            {withEnd && <col style={{ width: END_W }} />}
          </colgroup>
          <thead>
            <tr role="row" aria-rowindex={1} style={{ height: HEAD_H }}>
              <th role="columnheader" className="asg-corner">
                {tab === "policies" ? "주체" : "사용자"}
              </th>
              {columns.map((column, c) => (
                <th key={column.id} role="columnheader" scope="col" className="asg-colhead">
                  <button type="button" className="asg-name" data-pos={posKey(-1, c)} tabIndex={stop(-1, c)} title={column.name} onFocus={() => onFocusAt(-1, c)} onClick={() => openColumn(c)}>
                    <span className="asg-clamp">{column.name}</span>
                  </button>
                  <div className="asg-colmeta">
                    {column.scope && <span className="iam-chip">{SCOPE_LABEL[column.scope]}</span>}
                    {/* 범위 칸이 이미 알려 주는 AWS 관리형은 되풀이하지 않는다 */}
                    <BadgeList badges={column.badges} hide={["awsManaged"]} />
                  </div>
                </th>
              ))}
              {withEnd && (
                <th role="columnheader" scope="col" className="asg-end">
                  <span className="asg-sr">인라인·경계</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {start > 0 && spacer("before", start * ROW_H)}
            {lines.slice(start, end).map((line, k) => {
              const index = start + k;
              if (line.type === "head") {
                return (
                  <tr key={`head-${line.kind}`} role="row" aria-rowindex={index + 2} className="asg-group" style={{ height: ROW_H }}>
                    <th role="rowheader" className="asg-rowhead">
                      <span>{KIND_LABEL[line.kind]}</span> <span className="dim">{line.count}</span>
                    </th>
                    <td aria-hidden="true" colSpan={span - 1} />
                  </tr>
                );
              }
              const { r } = line;
              const row = rows[r];
              const lock = locks[r];
              const inline = Math.max(0, row.policyCount - (row.attached?.length ?? 0));
              return (
                <tr key={row.arn} role="row" aria-rowindex={index + 2} className={`asg-row${index % 2 ? " asg-even" : ""}${lock ? " asg-locked" : ""}`} style={{ height: ROW_H }}>
                  <th role="rowheader" scope="row" className="asg-rowhead">
                    <div className="asg-who">
                      <button type="button" className="asg-name" data-pos={posKey(r, -1)} tabIndex={stop(r, -1)} title={row.name} onFocus={() => onFocusAt(r, -1)} onClick={() => openRow(r)}>
                        {row.name}
                      </button>
                      <BadgeList badges={row.badges} />
                      <button
                        type="button"
                        className="asg-more"
                        aria-label={`${row.name} 행 메뉴`}
                        aria-haspopup="menu"
                        aria-expanded={pop?.type === "menu" && pop.arn === row.arn}
                        tabIndex={roving?.r === r ? 0 : -1}
                        onPointerDown={takeFocus}
                        onClick={(e) => {
                          const trigger = e.currentTarget;
                          setPop((p) => (p?.type === "menu" && p.arn === row.arn ? null : { type: "menu", arn: row.arn, trigger }));
                        }}
                      >
                        ⋯
                      </button>
                    </div>
                    {lock && (
                      <div className="asg-why" title={lock}>
                        {lock}
                      </div>
                    )}
                  </th>
                  {columns.map((column, c) => {
                    const v = cellView(overview, tab, queued, row, column.id);
                    const picked = inRange(r, c);
                    return (
                      <td key={column.id} role="gridcell" aria-selected={picked ? true : undefined} className={`asg-td${picked ? " asg-picked" : ""}`}>
                        <button
                          type="button"
                          className={`asg-cell asg-${v.tone}`}
                          data-pos={posKey(r, c)}
                          aria-label={`${row.name} · ${column.name}: ${v.state}`}
                          title={v.state}
                          disabled={!!lock}
                          tabIndex={stop(r, c)}
                          onFocus={() => onFocusAt(r, c)}
                          onPointerDown={(e) => drag.down(e, r, c)}
                          onPointerEnter={(e) => drag.enter(e, r, c)}
                          onClick={(e) => drag.click(e, r, c)}
                        >
                          <span aria-hidden="true">{v.glyph}</span>
                          {v.overlay && (
                            <span className="asg-ovl" aria-hidden="true">
                              ◐
                            </span>
                          )}
                        </button>
                      </td>
                    );
                  })}
                  {withEnd && (
                    <td role="gridcell" className="asg-end">
                      {(inline > 0 || row.boundary) && (
                        // 눌러도 주체 상세로 가는 것뿐이라서 탭 순서에는 두지 않는다. 키보드는 행 머리에서 Enter
                        <button type="button" className="asg-endbtn" tabIndex={-1} onClick={() => openRow(r)}>
                          {inline > 0 && <span className="iam-chip">{`인라인 ${inline}`}</span>}
                          {row.boundary && <span className="iam-chip boundary">경계</span>}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {end < lines.length && spacer("after", (lines.length - end) * ROW_H)}
          </tbody>
        </table>
        {empty && <div className="empty small">{empty}</div>}
      </div>
      {pop?.type === "via" && (
        <GridPopover role="dialog" label="받은 곳" trigger={pop.trigger} onClose={closePop}>
          <ul>
            {pop.groups.map((group, i) => (
              <li key={group}>
                <span id={`${popId}-${i}`}>{`${group} 그룹에서 받아요`}</span>
                <button type="button" className="btn small" aria-describedby={`${popId}-${i}`} onClick={() => goToGroup(group)}>
                  그룹 행으로 가기
                </button>
              </li>
            ))}
          </ul>
        </GridPopover>
      )}
      {pop?.type === "menu" && menuRow && (
        <GridPopover role="menu" label={`${menuRow.name} 행 메뉴`} trigger={pop.trigger} onClose={closePop}>
          <button
            type="button"
            role="menuitem"
            className="asg-menuitem"
            disabled={!!menuLock}
            title={menuLock ?? undefined}
            onClick={() => {
              setPop(null);
              onMatch(menuRow);
            }}
          >
            다른 주체와 같게
          </button>
        </GridPopover>
      )}
    </div>
  );
}
