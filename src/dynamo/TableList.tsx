import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { Highlight } from "../components/Highlight";
import { ListFind, useListFind } from "../components/ListFind";
import { formatCount } from "../kv/format";
import { formatBytes } from "../lib/format";
import { tokenize } from "../lib/fuzzy";
import { billingShort, hasProblem, tableHealth, visibleTables } from "./group";
import * as t from "./text";
import type { DynamoTable } from "./types";

interface Props {
  tables: DynamoTable[];
  selected: string | null;
  onSelect: (name: string) => void;
  /** 이 목록이 보일 때만 ⌘F를 받는다 */
  active: boolean;
  problemOnly: boolean;
  onProblemOnly: (on: boolean) => void;
}

/** 왼쪽 테이블 목록: 이름, 과금, 아이템 수·크기, 스트림·복제본 표시, 건강 점. 이름 퍼지 찾기(⌘F)와 "문제 있는 테이블만" 거르기를 둔다 */
export function TableList({ tables, selected, onSelect, active, problemOnly, onProblemOnly }: Props) {
  const box = useRef<HTMLElement>(null);
  const find = useListFind(box, { enabled: active });
  const rows = useMemo(() => visibleTables(tables, { problemOnly, query: find.query }), [tables, problemOnly, find.query]);
  const problems = useMemo(() => tables.filter(hasProblem).length, [tables]);
  const tokens = useMemo(() => tokenize(find.query), [find.query]);
  const selectedAt = rows.findIndex((r) => r.name === selected);

  const selectedRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    selectedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (rows.length === 0) return;
    const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, selectedAt + 1) : Math.max(0, selectedAt < 0 ? 0 : selectedAt - 1);
    onSelect(rows[next].name);
  };

  return (
    <section className="ddb-list" ref={box} aria-label={t.LIST_LABEL}>
      <ListFind find={find} placeholder={t.FIND_PLACEHOLDER} count={rows.length} />
      <div className="ddb-list-tools">
        <button type="button" className="ddb-chip" aria-pressed={problemOnly} onClick={() => onProblemOnly(!problemOnly)}>
          {t.PROBLEM_ONLY}
          {problems > 0 && <span className="ddb-chip-n">{problems}</span>}
        </button>
        <span className="dim ddb-list-count">{t.tableCount(rows.length)}</span>
      </div>
      <div className="ddb-rows" role="listbox" aria-label={t.LIST_LABEL} tabIndex={0} onKeyDown={onKeyDown}>
        {rows.length === 0 && <div className="empty small">{tables.length === 0 ? t.NO_TABLES : t.NO_MATCH}</div>}
        {rows.map((table) => {
          const health = t.HEALTH[tableHealth(table)];
          const isSelected = table.name === selected;
          return (
            <div
              key={table.name}
              ref={isSelected ? selectedRow : undefined}
              role="option"
              aria-selected={isSelected}
              className={`ddb-row${isSelected ? " selected" : ""}`}
              onClick={() => onSelect(table.name)}
            >
              <span className={`dot ${health.dot}`} role="img" aria-label={health.label} title={health.label} />
              <span className="ddb-row-body">
                <span className="ddb-row-name">
                  <span className="mono ddb-row-title">
                    <Highlight text={table.name} tokens={tokens} />
                  </span>
                  {table.stream && <span className="iam-chip">{t.STREAM_BADGE}</span>}
                  {table.replicas.length > 0 && <span className="iam-chip">{t.replicaBadge(table.replicas.length)}</span>}
                  {table.status !== "ACTIVE" && !table.error && <span className="iam-chip conditional">{t.statusLabel(table.status)}</span>}
                </span>
                {table.error ? (
                  <span className="dim ddb-row-meta" title={table.error}>
                    {t.HEALTH.unknown.label}
                  </span>
                ) : (
                  <span className="dim ddb-row-meta" title={t.SIZE_TITLE}>
                    {`${billingShort(table)} · ${t.itemsAndSize(formatCount(table.itemCount), formatBytes(table.sizeBytes))}`}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
