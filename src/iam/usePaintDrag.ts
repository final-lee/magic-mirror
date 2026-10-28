import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { isEditable, isShown, type AssignmentTab, type Column } from "./assignments";
import { cellsBetween, posKey, type Pos } from "./gridPos";
import type { IamOverview, PrincipalSummary } from "./types";
import type { useAssignmentDraft } from "./useAssignmentDraft";

type Draft = Pick<ReturnType<typeof useAssignmentDraft>, "items" | "paint">;

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

interface Options {
  overview: IamOverview;
  tab: AssignmentTab;
  rows: PrincipalSummary[];
  columns: Column[];
  draft: Draft;
  /** 끌어서 칠하지 않은 누름(click)이 하는 일: 토글하거나, 그룹으로만 받은 칸이면 어디서 받는지 알려 준다 */
  press: (r: number, c: number, trigger: HTMLElement) => void;
  /** 칸을 누르는 순간 */
  onStart: () => void;
}

/**
 * 칸을 누른 채 끌어서 칠하기. 처음 칸이 정한 목표(붙이기 또는 떼기)를 지나간 칸마다 적용한다.
 * 끌기는 창 어디서 놓아도, 포인터가 취소돼도, 창이 초점을 잃어도 끝난다.
 * 칠하는 일은 표의 DOM이 아니라 rows와 columns의 자료로 하므로 그려지지 않은 행도 칠한다.
 */
export function usePaintDrag({ overview, tab, rows, columns, draft, press, onStart }: Options) {
  /** 끌어서 칠하는 중이면 처음 칸이 정한 목표와, 마지막으로 칠한 자리 */
  const painting = useRef<{ want: boolean; last: Pos } | null>(null);
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

  const down = (e: PointerEvent<HTMLButtonElement>, r: number, c: number) => {
    if (!takeFocus(e)) return;
    onStart();
    const row = rows[r];
    const column = columns[c].id;
    if (!isEditable(overview, tab, row, column)) {
      handled.current = null; // 그룹으로만 받은 칸은 click에서 안내를 연다
      return;
    }
    // 처음 칸이 정한 목표를 끌고 가는 내내 쓴다. 칸마다 다시 정하면 이미 목표인 칸이 뒤집힌다
    const want = !isShown(draft.items, overview, tab, row, column);
    painting.current = { want, last: { r, c } };
    handled.current = posKey(r, c);
    draft.paint(tab, [{ row, column }], want);
  };

  const enter = (e: PointerEvent<HTMLButtonElement>, r: number, c: number) => {
    const current = painting.current;
    if (!current) return;
    if (e.pointerType === "mouse" && (e.buttons & 1) === 0) {
      painting.current = null; // 창 밖에서 놓쳐 버린 경우
      return;
    }
    // 빨리 끌면 브라우저는 사이 칸의 pointerenter를 건너뛴다. 마지막으로 칠한 칸에서 여기까지 곧은 선이 지나는 칸을 모두 칠한다
    const cells = cellsBetween(current.last, { r, c }).flatMap((p) => (rows[p.r] && columns[p.c] ? [{ row: rows[p.r], column: columns[p.c].id }] : []));
    current.last = { r, c };
    if (cells.length > 0) draft.paint(tab, cells, current.want);
  };

  const click = (e: MouseEvent<HTMLButtonElement>, r: number, c: number) => {
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
