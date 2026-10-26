import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Column, Resource } from "../api/types";
import { Cell } from "../components/Cell";
import { compareValues } from "../lib/format";
import { nextSelection, type SelectionState } from "./selection";

const DRAG_THRESHOLD = 5;
const DESELECT_DELAY_MS = 300;
const NONE: SelectionState = { selected: [], anchor: null };

interface Props {
  columns: Column[];
  rows: Resource[];
  filter: string;
  selection: SelectionState;
  onSelectionChange: (s: SelectionState) => void;
  onOpen: (id: string) => void;
  onBack?: () => void;
  onDragStart?: (ids: string[], point: { clientX: number; clientY: number }) => void;
  emptyText?: string;
}

export function FileTable({ columns, rows, filter, selection, onSelectionChange, onOpen, onBack, onDragStart, emptyText }: Props) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: columns[0]?.key ?? "", dir: 1 });
  const press = useRef<{ id: string; x: number; y: number; started: boolean } | null>(null);

  const justDragged = useRef(false);
  const deselectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDeselect = () => {
    if (deselectTimer.current !== null) clearTimeout(deselectTimer.current);
    deselectTimer.current = null;
  };
  // 선택이 바뀌거나 언마운트되면 대기 중인 해제 타이머를 정리한다.
  useEffect(() => cancelDeselect, [selection]);

  useEffect(() => {
    const reset = () => {
      press.current = null;
    };
    window.addEventListener("pointerup", reset);
    return () => window.removeEventListener("pointerup", reset);
  }, []);

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = f ? rows.filter((r) => r.name.toLowerCase().includes(f)) : rows;
    return [...filtered].sort((a, b) => compareValues(a.values[sort.key] ?? "", b.values[sort.key] ?? "") * sort.dir);
  }, [rows, filter, sort]);
  const order = visible.map((r) => r.id);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      onBack?.();
      return;
    }
    if (e.key === "Enter") {
      if (selection.selected.length === 1) onOpen(selection.selected[0]);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const current = selection.anchor ? order.indexOf(selection.anchor) : -1;
    const next = e.key === "ArrowDown" ? Math.min(order.length - 1, current + 1) : Math.max(0, current - 1);
    if (order[next]) onSelectionChange({ selected: [order[next]], anchor: order[next] });
  };

  const onPointerDown = (id: string, e: PointerEvent) => {
    if (e.button !== 0) return;
    justDragged.current = false;
    cancelDeselect();
    press.current = { id, x: e.clientX, y: e.clientY, started: false };
  };

  const onPointerMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p || p.started || e.buttons !== 1) return;
    if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < DRAG_THRESHOLD * 2) return;
    p.started = true;
    justDragged.current = true;
    const visibleSel = selection.selected.filter((id) => order.includes(id));
    const ids = visibleSel.includes(p.id) ? visibleSel : [p.id];
    onDragStart?.(ids, { clientX: e.clientX, clientY: e.clientY });
  };

  return (
    <div
      className="tbl"
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="file-table"
      onPointerDown={(e) => {
        // 행 밖에서 누른 경우: 이전 드래그(다른 패널에 놓은 경우 포함)의 흔적을 지운다.
        if (!(e.target as Element).closest("tbody tr")) justDragged.current = false;
      }}
      onPointerUp={() => (press.current = null)}
      onClick={(e) => {
        const t = e.target as Element;
        if (t.closest("tbody tr") || t.closest("thead")) return;
        if (justDragged.current) {
          justDragged.current = false;
          return;
        }
        cancelDeselect();
        if (selection.selected.length > 0) onSelectionChange(NONE);
      }}
    >
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}
              >
                {c.label} {sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const on = selection.selected.includes(r.id);
            return (
              <tr
                key={r.id}
                className={on ? "on" : undefined}
                aria-selected={on}
                onClick={(e) => {
                  if (justDragged.current) {
                    justDragged.current = false;
                    return;
                  }
                  cancelDeselect();
                  if (!e.metaKey && !e.shiftKey && e.detail === 1 && selection.selected.length === 1 && selection.selected[0] === r.id) {
                    // 이미 선택된 행을 천천히 다시 클릭하면 해제한다. 더블클릭이면 dblclick에서 취소된다.
                    deselectTimer.current = setTimeout(() => {
                      deselectTimer.current = null;
                      onSelectionChange(NONE);
                    }, DESELECT_DELAY_MS);
                    return;
                  }
                  onSelectionChange(nextSelection(selection, r.id, order, { meta: e.metaKey, shift: e.shiftKey }));
                }}
                onDoubleClick={() => {
                  cancelDeselect();
                  onOpen(r.id);
                }}
                onPointerDown={(e) => onPointerDown(r.id, e)}
                onPointerMove={onPointerMove}
              >
                {columns.map((c) => (
                  <td key={c.key}>
                    <Cell kind={c.kind} value={r.values[c.key]} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {visible.length === 0 && <div className="empty small">{emptyText ?? "표시할 항목이 없어요"}</div>}
    </div>
  );
}
