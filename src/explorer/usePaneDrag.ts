import { useCallback, useEffect, useRef, useState } from "react";

export type Pane = "local" | "s3";

export interface DragState {
  from: Pane;
  ids: string[];
  x: number;
  y: number;
  over: Pane | null;
}

export function paneAt(x: number, y: number): Pane | null {
  const el = document.elementFromPoint(x, y);
  const pane = el?.closest("[data-pane]")?.getAttribute("data-pane");
  return pane === "local" || pane === "s3" ? pane : null;
}

export function usePaneDrag(onDrop: (from: Pane, to: Pane, ids: string[]) => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  const update = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const start = useCallback((from: Pane, ids: string[], point: { clientX: number; clientY: number }) => {
    update({ from, ids, x: point.clientX, y: point.clientY, over: null });
  }, []);

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (d) update({ ...d, x: e.clientX, y: e.clientY, over: paneAt(e.clientX, e.clientY) });
    };
    const up = (e: MouseEvent) => {
      const d = dragRef.current;
      update(null);
      const to = paneAt(e.clientX, e.clientY);
      if (d && to && to !== d.from) dropRef.current(d.from, to, d.ids);
    };
    const cancel = () => update(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragging]);

  return { drag, start };
}
