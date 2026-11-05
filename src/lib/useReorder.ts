import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

/** 이만큼 움직여야 끌기로 본다(그 전에 놓으면 그냥 클릭) */
const THRESHOLD = 4;

/** `order`에서 from 자리를 빼 to 자리에 넣은 새 순서 */
export function moved<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** 저장한 순서(`saved`의 키 순서)대로 놓는다. 저장에 없는 항목은 원래 순서대로 뒤에 붙는다. */
export function ordered<T>(items: T[], key: (item: T) => string, saved: readonly string[] | undefined): T[] {
  if (!saved?.length) return items;
  const rank = new Map(saved.map((k, i) => [k, i]));
  const known = items.filter((item) => rank.has(key(item))).sort((a, b) => rank.get(key(a))! - rank.get(key(b))!);
  return [...known, ...items.filter((item) => !rank.has(key(item)))];
}

/**
 * 보이는 목록(`shown`, `ordered`로 놓은 키)에서 from을 to로 옮긴 뒤 저장할 순서.
 * 지금 보이지 않는 키(꺼 둔 서비스 등)는 저장된 자리에 그대로 둔다.
 */
export function savedAfterMove(saved: readonly string[] | undefined, shown: string[], from: number, to: number): string[] {
  const next = moved(shown, from, to);
  const base = saved ?? [];
  const all = [...base, ...shown.filter((k) => !base.includes(k))];
  const visible = new Set(shown);
  let i = 0;
  return all.map((k) => (visible.has(k) ? next[i++] : k));
}

export interface Reorder {
  /** 그릴 순서(원래 인덱스). 끄는 중이면 놓을 자리로 옮겨 보여 준다. */
  preview: number[];
  /** 끌리고 있는 항목의 원래 인덱스 */
  dragged: number | null;
  /** 항목 요소에 붙인다. 누른 자리에서 끌기가 시작된다. */
  itemProps: (index: number) => { ref: (el: HTMLElement | null) => void; onMouseDown: (e: ReactMouseEvent) => void };
  /** 끌기를 마친 직후의 click이면 true를 돌려주고 한 번만 막는다 */
  consumeClick: () => boolean;
}

/**
 * 세로 목록을 마우스로 끌어 순서를 바꾼다. 앱의 다른 끌기처럼 HTML5 drag 대신 마우스 이벤트를 쓴다.
 * 끄는 동안 `preview`가 바뀐 순서(원래 인덱스의 배열)이고, 놓으면 onMove(from, to)를 부른다.
 */
export function useReorder(count: number, onMove: (from: number, to: number) => void): Reorder {
  const items = useRef<(HTMLElement | null)[]>([]);
  const [drag, setDragState] = useState<{ from: number; to: number; started: boolean } | null>(null);
  const dragRef = useRef(drag);
  const setDrag = (next: typeof drag) => {
    dragRef.current = next;
    setDragState(next);
  };
  const start = useRef<{ index: number; y: number } | null>(null);
  // 끌고 난 뒤 같은 항목에서 생기는 click은 선택으로 치지 않는다
  const suppressClick = useRef(false);
  const moveRef = useRef(onMove);
  moveRef.current = onMove;

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const s = start.current;
      if (!s) return;
      if (Math.abs(e.clientY - s.y) < THRESHOLD) return;
      // 놓을 자리: 끄는 항목을 뺀 나머지 중 가운데가 포인터보다 위에 있는 개수
      let to = 0;
      items.current.forEach((el, i) => {
        if (i === s.index || !el) return;
        const r = el.getBoundingClientRect();
        if (r.top + r.height / 2 < e.clientY) to++;
      });
      setDrag({ from: s.index, to, started: true });
    };
    const up = () => {
      const d = dragRef.current;
      setDrag(null);
      start.current = null;
      if (d?.started) {
        suppressClick.current = true;
        if (d.from !== d.to) moveRef.current(d.from, d.to);
      }
    };
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      start.current = null;
      setDrag(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", cancel);
    };
  }, [dragging]);

  const indices = Array.from({ length: count }, (_, i) => i);
  return {
    preview: drag?.started ? moved(indices, drag.from, drag.to) : indices,
    dragged: drag?.started ? drag.from : null,
    itemProps: (index: number) => ({
      ref: (el: HTMLElement | null) => {
        items.current[index] = el;
      },
      onMouseDown: (e: ReactMouseEvent) => {
        if (e.button !== 0) return;
        // 누른 채 끄는 동안 글자가 선택되지 않게 한다. WKWebView는 접두사 없는 `user-select: none`을 무시한다.
        e.preventDefault();
        start.current = { index, y: e.clientY };
        suppressClick.current = false;
        setDrag({ from: index, to: index, started: false });
      },
    }),
    consumeClick: () => {
      const s = suppressClick.current;
      suppressClick.current = false;
      return s;
    },
  };
}
