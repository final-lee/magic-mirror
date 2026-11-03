import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { K8sError } from "../K8sError";
import { DETAIL_PCT } from "../lanes";
import type { K8sTarget } from "../types";
import { CellDetailPane } from "./CellDetailPane";
import { SubjectName } from "./paths";
import { useAccessMatrix } from "./queries";
import {
  CELLS, CELL_GLYPHS, CELL_LABELS, CELL_RULES, CLUSTER_WIDE, CLUSTER_WIDE_TITLE, COLUMNS_LIMIT, FILTER_LABEL, FILTER_PLACEHOLDER, KINDS_LABEL, KIND_LABELS, LEGEND_FULL,
  LEGEND_NONE, LEGEND_PARTIAL, LEGEND_TITLE, LOADING, MATRIX_LABEL, NAMESPACES_BUTTON, NAMESPACES_CLEAR, NAMESPACES_FIRST, NAMESPACES_LABEL, NAMESPACES_NONE, NAMESPACES_SEARCH, NEXT,
  NO_ROWS, PAGER_LABEL, PREV, SUBJECT_COLUMN, cellLabel, columnsLimited, pageText,
} from "./text";
import type { AccessView, Cell, MatrixQuery, Subject, SubjectKind } from "./types";

export const PAGE_SIZE = 25;
const KINDS: SubjectKind[] = ["iam", "user", "group", "serviceAccount"];
/** 처음에 열로 보이는 네임스페이스 수(고른 네임스페이스가 있으면 그것 하나) */
const INITIAL_NAMESPACES = 3;

interface Props {
  target: K8sTarget;
  context: string | null;
  ssoProfile: string;
  live: boolean;
  view: AccessView;
  /** TopBar에서 고른 네임스페이스(전체면 null). 처음 열에 넣는다 */
  namespace: string | null;
  /** 신원 화면에서 넘어올 때 채우는 이름 필터 */
  initialText?: string;
  onOpenIam?: (arn: string) => void;
}

const sameSubject = (a: Subject, b: Subject) => a.kind === b.kind && a.name === b.name && a.namespace === b.namespace;

/** 열에 보일 네임스페이스 고르기: 검색 상자와 확인 상자 목록. 열은 최대 COLUMNS_LIMIT개(클러스터 전체 열 포함) */
function ColumnPicker({ all, columns, onChange }: { all: string[]; columns: (string | null)[]; onChange: (next: (string | null)[]) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const shown = all.filter((n) => n.toLowerCase().includes(text.trim().toLowerCase())).slice(0, 200);
  const full = columns.length >= COLUMNS_LIMIT;
  const toggle = (ns: string | null) => onChange(columns.includes(ns) ? columns.filter((c) => c !== ns) : [...columns, ns]);
  return (
    <div className="acc-picker" ref={box}>
      <button className="btn small tone-secondary" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        {NAMESPACES_BUTTON(columns.filter((c) => c !== null).length)}
      </button>
      {open && (
        <div className="acc-pop" role="dialog" aria-label={NAMESPACES_LABEL}>
          <input aria-label={NAMESPACES_SEARCH} placeholder={NAMESPACES_SEARCH} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <label className="acc-check">
            <input type="checkbox" checked={columns.includes(null)} disabled={full && !columns.includes(null)} onChange={() => toggle(null)} />
            <span>{CLUSTER_WIDE}</span>
          </label>
          <div className="acc-pop-list">
            {shown.map((n) => (
              <label key={n} className="acc-check">
                <input type="checkbox" checked={columns.includes(n)} disabled={full && !columns.includes(n)} onChange={() => toggle(n)} />
                <span className="mono">{n}</span>
              </label>
            ))}
            {shown.length === 0 && <p className="dim">{NAMESPACES_NONE}</p>}
          </div>
          <div className="acc-pop-foot">
            <span className="dim">{columnsLimited(COLUMNS_LIMIT)}</span>
            <button className="btn small tone-ghost" onClick={() => onChange([null])}>
              {NAMESPACES_CLEAR}
            </button>
            <button className="btn small tone-ghost" onClick={() => onChange([null, ...all.slice(0, INITIAL_NAMESPACES)])}>
              {NAMESPACES_FIRST}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 주체 × 네임스페이스 권한 표. 칸 일곱 개는 모듈 문서(matrix.rs)와 CELL_RULES가 정의한다. 한 쪽(25행)씩 백엔드에서 계산해 읽는다. */
export function MatrixTab({ target, context, ssoProfile, live, view, namespace, initialText = "", onOpenIam }: Props) {
  const [kinds, setKinds] = useState<SubjectKind[]>([]);
  const [text, setText] = useState(initialText);
  useEffect(() => setText(initialText), [initialText]);
  const deferred = useDeferredValue(text);
  const [columns, setColumns] = useState<(string | null)[]>(() => [null, ...(namespace ? [namespace] : view.namespaces.slice(0, INITIAL_NAMESPACES))]);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<{ subject: Subject; cell: Cell; namespace: string | null } | null>(null);
  // 필터가 바뀌면 첫 쪽으로 돌아간다
  useEffect(() => setPage(0), [kinds, deferred, columns]);
  const query: MatrixQuery = useMemo(
    () => ({ kinds, text: deferred.trim(), namespaces: columns, offset: page * PAGE_SIZE, limit: PAGE_SIZE }),
    [kinds, deferred, columns, page],
  );
  const q = useAccessMatrix(target, context, ssoProfile, query, live);
  const data = q.data;
  const total = data?.total ?? 0;
  const mapping = selected?.subject.kind === "iam" ? view.mappings.find((m) => m.principalArn === selected.subject.name) : undefined;

  const toggleKind = (k: SubjectKind) => setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  const pick = (subject: Subject, cell: Cell, ns: string | null) =>
    setSelected((cur) => (cur && sameSubject(cur.subject, subject) && cur.cell === cell && cur.namespace === ns ? null : { subject, cell, namespace: ns }));
  // 표의 빈 곳을 누르면 선택을 푼다
  const blank = (e: React.MouseEvent) => {
    if (!(e.target as Element).closest("button")) setSelected(null);
  };

  return (
    <div className="acc-matrix-tab">
      <div className="acc-bar">
        <div className="asg-chips" role="group" aria-label={KINDS_LABEL}>
          {KINDS.map((k) => (
            <label key={k} className={`acc-chip${kinds.includes(k) ? " on" : ""}`}>
              <input type="checkbox" checked={kinds.includes(k)} onChange={() => toggleKind(k)} />
              {KIND_LABELS[k]}
            </label>
          ))}
        </div>
        <input className="acc-filter" aria-label={FILTER_LABEL} placeholder={FILTER_PLACEHOLDER} value={text} onChange={(e) => setText(e.target.value)} />
        <ColumnPicker all={view.namespaces} columns={columns} onChange={setColumns} />
        <details className="acc-legend">
          <summary>{LEGEND_TITLE}</summary>
          <ul>
            {CELLS.map((c) => (
              <li key={c}>
                <b className="acc-glyph">{CELL_GLYPHS[c]}</b> {CELL_LABELS[c]}: <span className="dim">{CELL_RULES[c]}</span>
              </li>
            ))}
            <li>
              <span className="acc-swatch lv2" /> {LEGEND_FULL} <span className="acc-swatch lv1" /> {LEGEND_PARTIAL} <span className="acc-swatch lv0" /> {LEGEND_NONE}
            </li>
          </ul>
        </details>
      </div>
      {q.isError && <K8sError error={q.error} target={target} ssoProfile={ssoProfile} compact />}
      <div className="acc-grid-wrap" onClick={blank}>
        {!data && !q.isError && <div className="empty">{LOADING}</div>}
        {data && (
          <table className="acc-grid" aria-label={MATRIX_LABEL}>
            <thead>
              <tr>
                <th scope="col" className="acc-corner">{SUBJECT_COLUMN}</th>
                {columns.map((ns) => (
                  <th key={ns ?? "·cluster"} scope="col" title={ns === null ? CLUSTER_WIDE_TITLE : ns}>
                    <span className="mono">{ns ?? CLUSTER_WIDE}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={`${row.subject.kind}|${row.subject.namespace}|${row.subject.name}`} className={selected && sameSubject(selected.subject, row.subject) ? "acc-sel" : undefined}>
                  <th scope="row" className="acc-rowhead">
                    <SubjectName subject={row.subject} label={row.label} />
                  </th>
                  {columns.map((ns, ci) => (
                    <td key={ns ?? "·cluster"}>
                      <span className="acc-cells">
                        {CELLS.map((cell, i) => {
                          const level = row.levels[ci]?.[i] ?? 0;
                          const on = selected !== null && sameSubject(selected.subject, row.subject) && selected.cell === cell && selected.namespace === ns;
                          return (
                            <button
                              key={cell}
                              className={`acc-cell lv${level}${cell === "escalate" ? " esc" : ""}${on ? " on" : ""}`}
                              aria-label={cellLabel(row.subject.name, ns ?? CLUSTER_WIDE, cell, level)}
                              aria-pressed={on}
                              title={cellLabel(row.subject.name, ns ?? CLUSTER_WIDE, cell, level)}
                              onClick={() => pick(row.subject, cell, ns)}
                            >
                              {CELL_GLYPHS[cell]}
                            </button>
                          );
                        })}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.rows.length === 0 && <div className="empty small">{NO_ROWS}</div>}
      </div>
      {data && total > PAGE_SIZE && (
        <div className="acc-pager" role="group" aria-label={PAGER_LABEL}>
          <button className="btn small tone-secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            {PREV}
          </button>
          <span className="dim">{pageText(page * PAGE_SIZE + 1, Math.min(total, (page + 1) * PAGE_SIZE), total)}</span>
          <button className="btn small tone-secondary" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>
            {NEXT}
          </button>
        </div>
      )}
      {selected && <CellDetailPane target={target} context={context} ssoProfile={ssoProfile} selected={selected} mapping={mapping} widthPct={DETAIL_PCT} onClose={() => setSelected(null)} onOpenIam={onOpenIam} />}
    </div>
  );
}
