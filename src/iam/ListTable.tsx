import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface ListColumn<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  /** 있으면 머리글을 눌러 정렬할 수 있다. null은 방향과 상관없이 맨 아래로 간다. */
  sort?: (row: T) => string | number | null;
  numeric?: boolean;
}

interface Props<T> {
  label: string;
  rows: T[];
  columns: ListColumn<T>[];
  rowKey: (row: T) => string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  empty: string;
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "ko", { sensitivity: "base" });
}

/** 사용자·그룹·역할·정책 목록이 함께 쓰는 정렬·선택 가능한 표. 첫 열을 기준으로 처음 정렬한다. */
export function ListTable<T>({ label, rows, columns, rowKey, selectedId, onSelect, onOpen, empty }: Props<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: columns[0].key, dir: 1 });
  const box = useRef<HTMLDivElement>(null);

  // 상세를 보고 돌아왔을 때나 ↑↓로 옮길 때 고른 행이 화면 밖에 있으면 보이는 곳까지 스크롤한다
  useEffect(() => {
    box.current?.querySelector('tr[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  const sorted = useMemo(() => {
    const get = columns.find((c) => c.key === sort.key)?.sort;
    if (!get) return rows;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return compare(x, y) * sort.dir;
    });
  }, [rows, columns, sort]);

  const toggleSort = (key: string) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && selectedId) {
      onOpen(selectedId);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = sorted.findIndex((r) => rowKey(r) === selectedId);
    const next = e.key === "ArrowDown" ? Math.min(sorted.length - 1, i + 1) : Math.max(0, i - 1);
    if (sorted[next]) onSelect(rowKey(sorted[next]));
  };

  return (
    <div className="tbl iam-list" tabIndex={0} onKeyDown={onKeyDown} data-testid="iam-list" ref={box}>
      <table aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`${c.sort ? "" : "nosort"}${c.numeric ? " num" : ""}`}
                aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                onClick={c.sort ? () => toggleSort(c.key) : undefined}
              >
                {c.label} {sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const id = rowKey(r);
            return (
              <tr key={id} className={id === selectedId ? "on" : undefined} aria-selected={id === selectedId} onClick={() => onSelect(id)} onDoubleClick={() => onOpen(id)}>
                {columns.map((c) => (
                  <td key={c.key} className={c.numeric ? "num" : undefined}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && <div className="empty small">{empty}</div>}
    </div>
  );
}
