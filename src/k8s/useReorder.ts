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

/**
 * 세로 목록을 마우스로 끌어 순서를 바꾼다. 앱의 다른 끌기처럼 HTML5 drag 대신 마우스 이벤트를 쓴다.
 * 끄는 동안 `preview`가 바뀐 순서(원래 인덱스의 배열)이고, 놓으면 onMove(from, to)를 부른다.
 */
export function useReorder(count: number, onMove: (from: number, to: number) => void) {
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
    /** 그릴 순서(원래 인덱스). 끄는 중이면 놓을 자리로 옮겨 보여 준다. */
    preview: drag?.started ? moved(indices, drag.from, drag.to) : indices,
    /** 끌리고 있는 항목의 원래 인덱스 */
    dragged: drag?.started ? drag.from : null,
    itemProps: (index: number) => ({
      ref: (el: HTMLElement | null) => {
        items.current[index] = el;
      },
      onMouseDown: (e: ReactMouseEvent) => {
        if (e.button !== 0) return;
        start.current = { index, y: e.clientY };
        suppressClick.current = false;
        setDrag({ from: index, to: index, started: false });
      },
    }),
    /** 끌기를 마친 직후의 click이면 true를 돌려주고 한 번만 막는다 */
    consumeClick: () => {
      const s = suppressClick.current;
      suppressClick.current = false;
      return s;
    },
  };
}
