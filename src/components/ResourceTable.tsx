import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Column, Resource } from "../api/types";
import { compareValues } from "../lib/format";
import { fuzzyFilter, fuzzyKeep, tokenize } from "../lib/fuzzy";
import { Cell } from "./Cell";

interface Props {
  columns: Column[];
  items: Resource[];
  filter: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  /** 이 행이 보이게 스크롤한다(⌘K로 찾아 온 리소스). 보이게 한 뒤 onRevealed를 부른다 */
  revealId?: string | null;
  onRevealed?: () => void;
}

/** 필터가 보는 글: 이름, ID, 글로 된 열 값, 태그(key=value). 이름이 가장 앞선다 */
export function resourceSearchFields(r: Pick<Resource, "name" | "id" | "values" | "tags">, columns: Column[]): string[] {
  return [
    r.name,
    r.id,
    ...columns.filter((c) => c.kind === "text" || c.kind === "mono" || c.kind === "state").map((c) => r.values[c.key] ?? ""),
    ...Object.entries(r.tags).map(([k, v]) => `${k}=${v}`),
  ];
}

export function ResourceTable({ columns, items, filter, selectedId, onSelect, onOpen, revealId = null, onRevealed }: Props) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: columns[0]?.key ?? "", dir: 1 });
  // 필터가 있으면 잘 맞는 순서로 보인다. 사용자가 열 머리를 누르면 그 뒤로는 그 열 순서가 이긴다.
  const [userSorted, setUserSorted] = useState(false);
  const tokens = useMemo(() => tokenize(filter), [filter]);
  const byScore = tokens.length > 0 && !userSorted;
  const body = useRef<HTMLTableSectionElement>(null);

  // 열 순서로 먼저 늘어놓는다: 점수순일 때도 점수가 같으면 열 순서를 따른다
  const sorted = useMemo(() => [...items].sort((a, b) => compareValues(a.values[sort.key] ?? "", b.values[sort.key] ?? "") * sort.dir), [items, sort]);
  const rows = useMemo(() => (byScore ? fuzzyFilter : fuzzyKeep)(sorted, filter, (r) => resourceSearchFields(r, columns)), [sorted, filter, columns, byScore]);

  useEffect(() => {
    if (!revealId) return;
    const row = Array.from(body.current?.rows ?? []).find((tr) => tr.dataset.id === revealId);
    if (!row) return;
    row.scrollIntoView?.({ block: "nearest" });
    onRevealed?.();
  }, [revealId, rows, onRevealed]);

  const toggleSort = (key: string) => {
    setUserSorted(true);
    setSort((s) => (s.key === key && !byScore ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  };

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
              <th key={c.key} onClick={() => toggleSort(c.key)} title={byScore ? "잘 맞는 순서예요. 누르면 이 열로 정렬해요" : undefined}>
                {c.label} {!byScore && sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={body}>
          {rows.map((r) => (
            <tr
              key={r.id}
              data-id={r.id}
              className={r.id === selectedId ? "on" : undefined}
              aria-selected={r.id === selectedId}
              onClick={() => onSelect(r.id)}
              onDoubleClick={() => onOpen(r.id)}
            >
              {columns.map((c) => (
                <td key={c.key}>
                  <Cell kind={c.kind} value={r.values[c.key]} tokens={tokens} />
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
