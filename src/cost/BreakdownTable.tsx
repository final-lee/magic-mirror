import { useMemo, useRef, useState } from "react";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyKeep } from "../lib/fuzzy";
import { amount, formatDelta, formatMoney, formatPct, formatShare } from "./format";
import { trendClass } from "./SummaryCards";
import { BREAKDOWN_EMPTY, BREAKDOWN_NO_MATCH, BREAKDOWN_LABEL, COL, DRILL_HINT, smallRows } from "./text";
import type { BreakdownRow, CostBreakdown } from "./types";

type SortKey = keyof typeof COL;

const SORT_VALUE: Record<SortKey, (r: BreakdownRow) => string | number | null> = {
  label: (r) => r.label,
  current: (r) => amount(r.current),
  previous: (r) => (r.previous === null ? null : amount(r.previous)),
  delta: (r) => (r.delta === null ? null : amount(r.delta)),
  deltaPct: (r) => r.deltaPct,
  share: (r) => r.share,
};

interface Props {
  breakdown: CostBreakdown;
  /** 비교 기간이 있나(최근 6개월은 없다). 없으면 비교 열을 숨긴다 */
  compare: boolean;
  /** 행을 눌러 내려갈 수 있나 */
  drillable: boolean;
  onDrill: (row: BreakdownRow) => void;
}

/** 항목별 이번 기간·비교 기간·증감·비중. 기본은 이번 기간 내림차순, 열 머리를 누르면 바꾼다. 작은 항목 줄은 늘 맨 아래다 */
export function BreakdownTable({ breakdown: b, compare, drillable, onDrill }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "current", dir: -1 });
  const cols: SortKey[] = compare ? ["label", "current", "previous", "delta", "deltaPct", "share"] : ["label", "current", "share"];

  // ⌘F: 이 항목 표 안에서만 찾는다(이름과 키). 평소에는 찾기 줄이 없다. 찾는 동안 작은 항목 모음 줄은 숨긴다
  const box = useRef<HTMLDivElement>(null);
  const find = useListFind(box, { enabled: b.rows.length > 0 });
  const searching = find.query.trim() !== "";
  const rows = useMemo(() => {
    const get = SORT_VALUE[sort.key];
    return [...fuzzyKeep(b.rows, find.query, (r) => [r.label, r.key])].sort((x, y) => {
      const p = get(x);
      const q = get(y);
      // 값이 없는 행은 방향과 상관없이 맨 아래
      if (p === null || q === null) return p === q ? 0 : p === null ? 1 : -1;
      const c = typeof p === "number" && typeof q === "number" ? p - q : String(p).localeCompare(String(q), "ko");
      return c * sort.dir;
    });
  }, [b.rows, sort, find.query]);

  // 이름은 오름차순, 금액·비율은 큰 것부터 시작한다
  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "label" ? 1 : -1 }));

  const cell = (r: BreakdownRow, key: SortKey) => {
    switch (key) {
      case "label":
        return r.label;
      case "current":
        return formatMoney(r.current, b.unit);
      case "previous":
        return r.previous === null ? "—" : formatMoney(r.previous, b.unit);
      case "delta":
        return r.delta === null ? "—" : <span className={trendClass(r.delta)}>{formatDelta(r.delta, b.unit)}</span>;
      case "deltaPct":
        return <span className={trendClass(r.delta)}>{formatPct(r.deltaPct)}</span>;
      case "share":
        return formatShare(r.share);
    }
  };

  const total = amount(b.total);
  // 0.005 미만인 항목을 접은 줄. 증감은 백엔드가 주지 않는다
  const small: Record<SortKey, string> | null = b.small && {
    label: smallRows(b.small.count),
    current: formatMoney(b.small.current, b.unit),
    previous: b.small.previous === null ? "—" : formatMoney(b.small.previous, b.unit),
    delta: "—",
    deltaPct: "—",
    share: formatShare(total > 0 ? (amount(b.small.current) / total) * 100 : 0),
  };
  return (
    <div className="cost-table" ref={box}>
      <ListFind find={find} count={rows.length} />
      <table aria-label={BREAKDOWN_LABEL}>
        <thead>
          <tr>
            {cols.map((key) => (
              <th
                key={key}
                scope="col"
                className={key === "label" ? undefined : "num"}
                aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                onClick={() => toggle(key)}
              >
                {COL[key]} {sort.key === key ? (sort.dir === 1 ? "▲" : "▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              className={drillable ? "drill" : undefined}
              title={drillable ? DRILL_HINT : undefined}
              tabIndex={drillable ? 0 : undefined}
              onClick={drillable ? () => onDrill(r) : undefined}
              onKeyDown={drillable ? (e) => e.key === "Enter" && onDrill(r) : undefined}
            >
              {cols.map((key) => (
                <td key={key} className={key === "label" ? "cost-label" : "num"} title={key === "label" ? r.key : undefined}>
                  {cell(r, key)}
                </td>
              ))}
            </tr>
          ))}
          {small && !searching && (
            <tr className="cost-small">
              {cols.map((key) => (
                <td key={key} className={key === "label" ? "cost-label" : "num"}>
                  {small[key]}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
      {b.rows.length === 0 && !b.small && <div className="empty small">{BREAKDOWN_EMPTY}</div>}
      {b.rows.length > 0 && rows.length === 0 && <div className="empty small">{BREAKDOWN_NO_MATCH}</div>}
    </div>
  );
}
