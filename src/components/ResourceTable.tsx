import { useMemo, useState, type KeyboardEvent } from "react";
import type { Column, Resource } from "../api/types";
import { compareValues } from "../lib/format";
import { Cell } from "./Cell";

interface Props {
  columns: Column[];
  items: Resource[];
  filter: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}

export function ResourceTable({ columns, items, filter, selectedId, onSelect, onOpen }: Props) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: columns[0]?.key ?? "", dir: 1 });

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? items.filter((r) => r.name.toLowerCase().includes(f) || r.id.toLowerCase().includes(f))
      : items;
    return [...filtered].sort((a, b) => compareValues(a.values[sort.key] ?? "", b.values[sort.key] ?? "") * sort.dir);
  }, [items, filter, sort]);

  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && selectedId) {
      onOpen(selectedId);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.id === selectedId);
    const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    if (rows[next]) onSelect(rows[next].id);
  };

  return (
    <div className="tbl" tabIndex={0} onKeyDown={onKeyDown} data-testid="resource-table">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} onClick={() => toggleSort(c.key)}>
                {c.label} {sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className={r.id === selectedId ? "on" : undefined}
              aria-selected={r.id === selectedId}
              onClick={() => onSelect(r.id)}
              onDoubleClick={() => onOpen(r.id)}
            >
              {columns.map((c) => (
                <td key={c.key}>
                  <Cell kind={c.kind} value={r.values[c.key]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty small">표시할 리소스가 없어요</div>}
    </div>
  );
}
