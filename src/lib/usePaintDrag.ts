// 표 위에서 칸을 누른 채 끌어 칠하는 상태 기계. 할당 표(IAM)와 권한 표(PostgreSQL)가 함께 쓴다.
// 행과 열이 무엇인지는 모른다: 칸을 번호(행, 열)로 가리키고, 칸이 칠할 수 있는지·무엇으로 칠할지·칠하는 일은 부르는 쪽이 정한다.
import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { cellsBetween, posKey, type Pos } from "../iam/gridPos";

/**
 * 버튼을 누르는 순간 버튼이 스스로 초점을 가져간다. WebKit은 눌러도 버튼에 초점을 주지 않아서, 그대로 두면 누른 칸에서 키보드를 이어 쓸 수 없다.
 * 이어서 오는 mousedown의 기본 동작(초점 옮기기, 끌 때의 글자 선택)은 막는다. click은 그대로 온다.
 * 보조 버튼(오른쪽 버튼, Ctrl+클릭)은 브라우저에 맡기고 false를 돌려준다.
 */
export function takeFocus(e: PointerEvent<HTMLElement>): boolean {
  if (e.button !== 0 || e.ctrlKey) return false;
  e.preventDefault();
  e.currentTarget.focus({ preventScroll: true });
  return true;
}

/** 표의 모양: 칸의 자리(번호)는 행과 열이 그대로일 때만 같은 칸을 가리킨다 */
interface Layout<R, C> {
  rows: R[];
  columns: C[];
}

function sameBy<T>(a: T[], b: T[], id: (item: T) => string): boolean {
  return a === b || (a.length === b.length && a.every((item, i) => id(item) === id(b[i])));
}

export interface PaintDragOptions<R, C> {
  rows: R[];
  columns: C[];
  /** 행과 열을 가르는 값. 배열이 새것이어도 이 값이 그대로면 같은 모양이다(아래 sameLayout) */
  rowId: (row: R) => string;
  columnId: (column: C) => string;
  /**
   * columns[0]의 열 번호(칸의 data-pos와 같은 번호). 기본은 0이다.
   * 번호가 -1부터 시작하는 표(권한 표의 데이터베이스 열)는 -1을 준다.
   */
  firstColumn?: number;
  /** 칠할 수 있는 칸인지. 칠할 수 없는 칸은 지나가도 칠하지 않고, 누른 칸이면 이어서 오는 click을 press가 받는다 */
  editable: (row: R, column: C) => boolean;
  /** 이 칸을 누르면 칸이 가져야 할 상태(목표). 끌고 가는 내내 이 목표로 칠한다 */
  wanted: (row: R, column: C) => boolean;
  /** 칠할 수 있는 칸들(editable)을 목표 상태로 칠한다. 칸은 지나온 차례로 오고, 이미 그 상태인 칸도 올 수 있다 */
  paint: (cells: { row: R; column: C }[], want: boolean) => void;
  /** 끌어서 칠하지 않은 누름(click)이 하는 일 */
  press: (r: number, c: number, trigger: HTMLElement) => void;
  /** 칸을 누르는 순간 */
  onStart: () => void;
}

/**
 * 칸을 누른 채 끌어서 칠하기. 처음 칸이 정한 목표를 지나간 칸마다 적용한다.
 * 끌기는 창 어디서 놓아도, 포인터가 취소돼도, 창이 초점을 잃어도 끝난다.
 * 칠하는 일은 표의 DOM이 아니라 rows와 columns의 자료로 하므로 그려지지 않은 행도 칠한다.
 */
export function usePaintDrag<R, C>({ rows, columns, rowId, columnId, firstColumn = 0, editable, wanted, paint, press, onStart }: PaintDragOptions<R, C>) {
  /** 끌어서 칠하는 중이면 처음 칸이 정한 목표와, 마지막으로 칠한 자리 및 그때의 표 모양 */
  const painting = useRef<{ want: boolean; last: Pos; layout: Layout<R, C> } | null>(null);
  /** 방금 눌러서 이미 처리한 칸. 이어서 오는 click은 한 번 건너뛴다 */
  const handled = useRef<string | null>(null);

  useEffect(() => {
    const end = (e: Event) => {
      painting.current = null;
      if (e.type !== "pointerup") {
        handled.current = null;
        return;
      }
      // 누른 칸이 아닌 곳에서 놓았으면 click이 그 칸에 오지 않는다
      const onCell = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-pos]") : null;
      if (onCell?.dataset.pos !== handled.current) handled.current = null;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, []);

  /**
   * 같은 번호가 같은 행과 열을 가리키는지. 배열이 새것이어도 행과 열의 값(rowId, columnId)이 그대로면 같은 모양이다:
   * 칠하는 중에는 담긴 변경이 바뀔 때마다 열 배열이 새로 만들어지는데, 그때마다 마지막 자리를 잊으면 빨리 끌 때 사이 칸을 건너뛴다.
   */
  const sameLayout = (a: Layout<R, C>, b: Layout<R, C>) => sameBy(a.rows, b.rows, rowId) && sameBy(a.columns, b.columns, columnId);
  const columnAt = (c: number): C | undefined => columns[c - firstColumn];

  const down = (e: PointerEvent<HTMLElement>, r: number, c: number) => {
    if (!takeFocus(e)) return;
    onStart();
    const row = rows[r];
    const column = columnAt(c) as C;
    if (!editable(row, column)) {
      handled.current = null; // 칠할 수 없는 칸은 click에서 press가 맡는다
      return;
    }
    // 처음 칸이 정한 목표를 끌고 가는 내내 쓴다. 칸마다 다시 정하면 이미 목표인 칸이 뒤집힌다
    const want = wanted(row, column);
    painting.current = { want, last: { r, c }, layout: { rows, columns } };
    handled.current = posKey(r, c);
    paint([{ row, column }], want);
  };

  const enter = (e: PointerEvent<HTMLElement>, r: number, c: number) => {
    const current = painting.current;
    if (!current) return;
    if (e.pointerType === "mouse" && (e.buttons & 1) === 0) {
      painting.current = null; // 창 밖에서 놓쳐 버린 경우
      return;
    }
    // 빨리 끌면 브라우저는 사이 칸의 pointerenter를 건너뛴다. 마지막으로 칠한 칸에서 여기까지 곧은 선이 지나는 칸을 모두 칠한다.
    // 끌다가 행이나 열이 달라졌으면(개요를 다시 읽음, 필터) 마지막으로 칠한 자리의 번호는 이제 다른 칸을 가리킨다: 이을 선이 없으니 들어온 칸만 칠한다
    const layout = { rows, columns };
    const path = sameLayout(current.layout, layout) ? cellsBetween(current.last, { r, c }) : [{ r, c }];
    const cells = path.flatMap((p) => {
      const row = rows[p.r];
      const column = columnAt(p.c);
      return row !== undefined && column !== undefined && editable(row, column) ? [{ row, column }] : [];
    });
    current.last = { r, c };
    current.layout = layout;
    if (cells.length > 0) paint(cells, current.want);
  };

  const click = (e: MouseEvent<HTMLElement>, r: number, c: number) => {
    const done = handled.current === posKey(r, c);
    handled.current = null;
    if (!done) press(r, c, e.currentTarget);
  };

  /** 키보드가 움직이면 방금 누른 칸의 표시는 더 맞지 않는다 */
  const forget = () => {
    handled.current = null;
  };

  return { down, enter, click, forget };
}
