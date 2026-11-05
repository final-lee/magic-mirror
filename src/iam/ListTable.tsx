import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useToggleSelect } from "../hooks/useToggleSelect";

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
  /** 고른 행을 다시 누르거나 빈 곳을 누르면 선택을 푼다 */
  onClear: () => void;
  onOpen: (id: string) => void;
  empty: string;
  /** 행이 이미 검색 점수순이다: 사용자가 머리글을 누르기 전까지 다시 정렬하지 않는다 */
  ranked?: boolean;
  /** k9s식 이동 키: j·k는 아래·위 행, g·G는 맨 위·맨 아래 행(EKS 목록) */
  vimKeys?: boolean;
}

type Step = "next" | "prev" | "first" | "last";
const ARROW_STEP: Record<string, Step | undefined> = { ArrowDown: "next", ArrowUp: "prev" };
/** EKS 목록의 k9s식 이동 키 */
const VIM_STEP: Record<string, Step | undefined> = { j: "next", k: "prev", g: "first", G: "last" };

/** 기존 표의 행을 같은 키로 이동한다. 선택 가능한 표는 행의 기존 클릭 동작을 쓴다. */
export function vimTableKeys(e: KeyboardEvent<HTMLElement>, select = false) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement;
  if (target !== e.currentTarget && (select || !target.matches("tbody tr[tabindex='-1']"))) return;
  const step = ARROW_STEP[e.key] ?? VIM_STEP[e.key];
  if (!step) return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLTableRowElement>("tbody tr"));
  if (!rows.length) return;
  e.preventDefault();
  const i = rows.findIndex((row) => select ? row.getAttribute("aria-selected") === "true" : row === document.activeElement);
  const next = step === "first" ? 0 : step === "last" ? rows.length - 1 : step === "next" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
  if (next === i) return;
  if (select) rows[next].click();
  else rows[next].focus();
  rows[next].scrollIntoView?.({ block: "nearest" });
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "ko", { sensitivity: "base" });
}

/** 사용자·그룹·역할·정책 목록이 함께 쓰는 정렬·선택 가능한 표. 첫 열을 기준으로 처음 정렬한다. */
export function ListTable<T>({ label, rows, columns, rowKey, selectedId, onSelect, onClear, onOpen, empty, ranked, vimKeys }: Props<T>) {
  const toggle = useToggleSelect(selectedId, onSelect, onClear);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: columns[0].key, dir: 1 });
  const [sortedByUser, setSortedByUser] = useState(false);
  // 점수순으로 넘어온 행은 머리글을 누르기 전까지 그 순서 그대로 둔다(그동안 정렬 화살표는 숨긴다).
  const scoreOrder = !!ranked && !sortedByUser;
  const box = useRef<HTMLDivElement>(null);

  // 상세를 보고 돌아왔을 때나 ↑↓로 옮길 때 고른 행이 화면 밖에 있으면 보이는 곳까지 스크롤한다
  useEffect(() => {
    box.current?.querySelector('tr[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  const sorted = useMemo(() => {
    const get = columns.find((c) => c.key === sort.key)?.sort;
    if (scoreOrder || !get) return rows;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return compare(x, y) * sort.dir;
    });
  }, [rows, columns, sort, scoreOrder]);

  const toggleSort = (key: string) => {
    setSortedByUser(true);
    // 점수 순서에서 처음 누르면 화살표가 없었으니 오름차순부터 시작한다.
    setSort((s) => (!scoreOrder && s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as Element).closest('[role="dialog"], [role="alertdialog"]')) return;
    if (e.key === "Enter" && selectedId) {
      onOpen(selectedId);
      return;
    }
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    const step = ARROW_STEP[e.key] ?? (vimKeys && plain ? VIM_STEP[e.key] : undefined);
    if (!step) return;
    e.preventDefault();
    const i = sorted.findIndex((r) => rowKey(r) === selectedId);
    const next = step === "first" ? 0 : step === "last" ? sorted.length - 1 : step === "next" ? Math.min(sorted.length - 1, i + 1) : Math.max(0, i - 1);
    // 맨 끝에서 더 가려 하면 그대로 둔다(같은 행을 다시 고르면 토글하는 목록이 있다)
    if (sorted[next] && next !== i) onSelect(rowKey(sorted[next]));
  };

  return (
    <div className="tbl iam-list" tabIndex={0} onKeyDown={onKeyDown} onClick={toggle.blank} data-testid="iam-list" ref={box}>
      <table aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`${c.sort ? "" : "nosort"}${c.numeric ? " num" : ""}`}
                aria-sort={!scoreOrder && sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                onClick={c.sort ? () => toggleSort(c.key) : undefined}
              >
                {c.label} {!scoreOrder && sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const id = rowKey(r);
            return (
              <tr key={id} className={id === selectedId ? "on" : undefined} aria-selected={id === selectedId} onClick={(e) => toggle.row(id, e)}
                onDoubleClick={() => {
                  toggle.dblclick();
                  onOpen(id);
                }}
              >
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
