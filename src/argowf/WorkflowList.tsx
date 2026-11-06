import { useMemo, useRef, useState } from "react";
import { workflowActionTone } from "./tone";
import { useQueryClient } from "@tanstack/react-query";
import { ArgoLabelFilter } from "../argocd/ArgoLabelFilter";
import { ArgoMultiSelect } from "../argocd/ArgoMultiSelect";
import { desktop } from "../api/desktop";
import { errorMessage } from "../api/errors";
import { Highlight } from "../components/Highlight";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyKeep, tokenize } from "../lib/fuzzy";
import { useDebounced } from "../lib/useDebounced";
import { ActionDialog, needsTypedName } from "./ActionDialog";
import { argowfApi } from "./api";
import { failingCrons } from "./findings";
import { expandLink, linksFor } from "./links";
import { argowfKeys, isTokenError, useWorkflowPages } from "./queries";
import { emptyQuery, labelSelectorOf, matchesQuery, picksFromView, rowKey, wfLabelOptions } from "./wfQuery";
import type { LabelPick } from "../argocd/argoFilter";
import type { ArgoWfConn, ArgoWfInfo, ArgoWfViewState, CronRow, WfAction, WfBatchResult, WfListQuery, WfRow, WfTarget } from "./types";

const phases = ["Running", "Pending", "Succeeded", "Failed", "Error"];
const sources = (r: WfRow) => (r.cron || r.template ? [r.cron && `⏱ ${r.cron}`, r.template && `📄 ${r.template}`].filter((s): s is string => !!s) : ["직접"]);
const rank = (r: WfRow) => (["Running", "Pending"].includes(r.phase) ? 0 : ["Failed", "Error"].includes(r.phase) ? 1 : 2);
export const elapsed = (start: string | null, end: string | null, now: number) => {
  if (!start) return "—";
  const seconds = Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  return seconds < 60
    ? `${seconds}초`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}분`
      : `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`;
};
export const relative = (date: string | null, now: number) => (date ? `${elapsed(date, null, now)} 전` : "—");

type StringKey = "phases" | "namespaces" | "sources";
type NameMode = "exact" | "prefix" | "contains";

/** 한꺼번에 할 수 있는 동작(서버가 하나씩 불러 준다) */
const BATCH: { kind: WfAction["kind"]; label: string }[] = [
  { kind: "stop", label: "Stop" },
  { kind: "terminate", label: "Terminate" },
  { kind: "suspend", label: "Suspend" },
  { kind: "resume", label: "Resume" },
  { kind: "retry", label: "Retry" },
  { kind: "resubmit", label: "다시 제출" },
  { kind: "delete", label: "삭제" },
];
const DANGEROUS: WfAction["kind"][] = ["delete", "terminate", "stop"];

const iso = (local: string) => (local ? new Date(local).toISOString() : null);
const samePick = (a: LabelPick, b: LabelPick) => a.key === b.key && a.value === b.value;

export function WorkflowList({
  conn,
  live,
  namespace,
  info,
  identity,
  base,
  crons,
  saved,
  labelColumns,
  onSave,
  onLabelColumns,
  onOpen,
  onCreate,
  onFindings,
  onNotice,
  onTokenError,
}: {
  conn: ArgoWfConn;
  live: boolean;
  /** 효과 네임스페이스. null이면 모든 네임스페이스 */
  namespace: string | null;
  info: ArgoWfInfo;
  /** 세션 신원: [내 것만]은 creator가 이것과 같은 행 */
  identity: string;
  /** 거르지 않은 첫 페이지(요약 띠와 칩 개수의 바탕) */
  base: WfRow[];
  crons: CronRow[];
  saved: ArgoWfViewState | null;
  labelColumns: string[];
  onSave(v: ArgoWfViewState): void;
  onLabelColumns(keys: string[]): void;
  onOpen(t: WfTarget): void;
  /** 새 Workflow 편집기를 연다(없으면 버튼을 숨긴다) */
  onCreate?(): void;
  onFindings(): void;
  onNotice?(m: string): void;
  onTokenError(m: string): void;
}) {
  const qc = useQueryClient();
  const listRef = useRef<HTMLDivElement>(null);
  const find = useListFind(listRef);
  const search = find.query;
  const [name, setName] = useState("");
  const [nameMode, setNameMode] = useState<NameMode>("prefix");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [batch, setBatch] = useState<WfAction["kind"] | null>(null);
  const [restartSuccessful, setRestartSuccessful] = useState(false);
  const [memoized, setMemoized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [results, setResults] = useState<WfBatchResult[] | null>(null);
  const filters = {
    phases: saved?.phases ?? [],
    namespaces: saved?.namespaces ?? [],
    sources: saved?.sources ?? [],
    labels: saved?.labels ?? [],
    mine: saved?.mine ?? false,
  };
  const save = (patch: Partial<ArgoWfViewState>) => onSave({ ...filters, ...patch });
  const picks = picksFromView(filters.labels);
  const debouncedName = useDebounced(name.trim(), 400);
  const query: WfListQuery = useMemo(
    () => ({
      ...emptyQuery(namespace),
      labelSelector: labelSelectorOf(picksFromView(filters.labels)),
      name: debouncedName ? { mode: nameMode, value: debouncedName } : null,
      createdAfter: iso(after),
      finishedBefore: iso(before),
      phases: filters.phases,
    }),
    // filters는 매 렌더 새 객체라 안의 값으로 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [namespace, JSON.stringify(filters.labels), debouncedName, nameMode, after, before, JSON.stringify(filters.phases)],
  );
  const list = useWorkflowPages(conn, query, live, { watch: true });
  const now = Date.now();

  const recent = base.filter((r) => r.finishedAt && Date.parse(r.finishedAt) >= now - 86400000 && Date.parse(r.finishedAt) <= now);
  const success = recent.filter((r) => r.phase === "Succeeded").length;
  const failed = recent.filter((r) => r.phase === "Failed" || r.phase === "Error").length;

  const clientKeep = (r: WfRow) =>
    (!filters.namespaces.length || filters.namespaces.includes(r.namespace)) &&
    (!filters.sources.length || sources(r).some((s) => filters.sources.includes(s))) &&
    (!filters.mine || (r.creator !== null && r.creator === identity));
  // 칩 개수는 칩 선택을 뺀 기준: 읽어 둔 모든 행(조건에 맞는 목록 + 거르지 않은 첫 페이지)에서 센다
  const pool = useMemo(() => {
    const seen = new Set<string>();
    return [...list.rows, ...base].filter((r) => !seen.has(rowKey(r)) && !!seen.add(rowKey(r)));
  }, [list.rows, base]);
  const counted = fuzzyKeep(
    pool.filter((r) => matchesQuery(r, { ...query, phases: [] }) && clientKeep(r)),
    search,
    (r) => [r.name, r.namespace, r.cron, r.template, ...Object.values(r.labels)],
  );
  const visible = fuzzyKeep(
    list.rows.filter((r) => matchesQuery(r, query) && clientKeep(r)),
    search,
    (r) => [r.name, r.namespace, r.cron, r.template, ...Object.values(r.labels)],
  ).sort((a, b) => rank(a) - rank(b) || (Date.parse(b.startedAt ?? "") || 0) - (Date.parse(a.startedAt ?? "") || 0));

  const toggle = (key: StringKey, value: string) =>
    save({ [key]: filters[key].includes(value) ? filters[key].filter((v) => v !== value) : [...filters[key], value] });
  const addPick = (pick: LabelPick) => {
    if (!picks.some((p) => samePick(p, pick))) save({ labels: [...filters.labels, pick.value === null ? pick.key : `${pick.key}=${pick.value}`] });
  };
  const removePick = (pick: LabelPick) => save({ labels: filters.labels.filter((l) => l !== (pick.value === null ? pick.key : `${pick.key}=${pick.value}`)) });
  const options = (values: string[]) => [...new Set(values)].sort().map((value) => ({ value, text: value, count: values.filter((v) => v === value).length }));
  const tokens = tokenize(search);
  const labelKeys = [...new Set(pool.flatMap((r) => Object.keys(r.labels)))].filter((k) => !info.columns.some((c) => c.type === "label" && c.key === k)).sort();
  const extra = [
    ...info.columns.map((c) => ({ name: c.name, type: c.type, key: c.key })),
    ...labelColumns.map((k) => ({ name: k, type: "label" as const, key: k })),
  ];

  const chosen = visible.filter((r) => picked.has(rowKey(r)) && !r.archived);
  const selectable = visible.filter((r) => !r.archived);
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;
  const flip = (r: WfRow) =>
    setPicked((old) => {
      const next = new Set(old);
      if (next.has(rowKey(r))) next.delete(rowKey(r));
      else next.add(rowKey(r));
      return next;
    });
  const typedName = batch !== null && DANGEROUS.includes(batch) && chosen.some((r) => needsTypedName(r.namespace, r.name)) ? `선택한 ${chosen.length}개` : null;
  const openBatch = (kind: WfAction["kind"]) => {
    setBatch(kind);
    setFailure(null);
    setRestartSuccessful(false);
    setMemoized(false);
  };
  const runBatch = async () => {
    if (!batch) return;
    const action: WfAction =
      batch === "retry"
        ? { kind: "retry", restartSuccessful, nodeFieldSelector: null, parameters: [] }
        : batch === "resubmit"
          ? { kind: "resubmit", memoized, parameters: [] }
          : batch === "stop"
            ? { kind: "stop", nodeFieldSelector: null, message: null }
            : batch === "resume"
              ? { kind: "resume", nodeFieldSelector: null }
              : ({ kind: batch } as WfAction);
    setBusy(true);
    setFailure(null);
    try {
      const result = await argowfApi.batchAction(
        conn,
        chosen.map((r) => ({ namespace: r.namespace, name: r.name })),
        action,
      );
      setResults(result);
      setBatch(null);
      setPicked(new Set());
      void qc.invalidateQueries({ queryKey: argowfKeys.data(conn.url) });
      onNotice?.(`${result.filter((r) => r.ok).length}/${result.length}개를 ${BATCH.find((b) => b.kind === batch)?.label}했어요`);
    } catch (e) {
      setFailure(errorMessage(e));
      if (isTokenError(e)) onTokenError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="argowf-list">
      <div className="awc-bar">
        <h2 className="awc-title">Workflows</h2>
        <span className="awc-stat">
          Running <b>{base.filter((r) => r.phase === "Running").length}</b>
        </span>
        <span className="awc-stat">
          Pending <b>{base.filter((r) => r.phase === "Pending").length}</b>
        </span>
        <span className="awc-stat">
          24시간 성공 <b>{success}</b>
        </span>
        <span className={`awc-stat${failed ? " bad" : ""}`}>
          실패 <b>{failed}</b> ({success + failed ? Math.round((failed / (success + failed)) * 100) : 0}%)
        </span>
        <div className="awc-bar-end">
          {linksFor(info.links, "workflow-list").map((l) => (
            <button key={l.name} className="btn small tone-nav" onClick={() => void desktop.openUrl(expandLink(l, { "metadata.namespace": namespace ?? "" }))}>
              {l.name} ↗
            </button>
          ))}
          <button className="btn small tone-nav" onClick={onFindings}>
            연속 실패 Cron {failingCrons(crons, base).length}
          </button>
          {onCreate && (
            <button className="btn tone-primary small" onClick={onCreate}>
              새 Workflow
            </button>
          )}
        </div>
      </div>
      <div className="argowf-filters">
        {phases.map((phase) => (
          <button key={phase} className="btn small" aria-pressed={filters.phases.includes(phase)} onClick={() => toggle("phases", phase)}>
            {phase} {counted.filter((r) => r.phase === phase).length}
          </button>
        ))}
        <ArgoMultiSelect
          label="네임스페이스"
          options={options(pool.map((r) => r.namespace))}
          picked={new Set(filters.namespaces)}
          onToggle={(v) => toggle("namespaces", v)}
          onClear={() => save({ namespaces: [] })}
        />
        <ArgoMultiSelect
          label="원천"
          options={options(pool.flatMap(sources))}
          picked={new Set(filters.sources)}
          onToggle={(v) => toggle("sources", v)}
          onClear={() => save({ sources: [] })}
        />
        <button className="btn small" aria-pressed={filters.mine} title={`creator가 ${identity}인 것만`} onClick={() => save({ mine: !filters.mine })}>
          내 것만
        </button>
      </div>
      <div className="argowf-filters">
        <ArgoLabelFilter options={wfLabelOptions(pool, counted)} picks={picks} onAdd={addPick} onRemove={removePick} />
        <span>
          이름{" "}
          <select aria-label="이름 조건" value={nameMode} onChange={(e) => setNameMode(e.target.value as NameMode)}>
            <option value="exact">정확히</option>
            <option value="prefix">앞부분</option>
            <option value="contains">포함</option>
          </select>{" "}
          <input aria-label="이름 값" placeholder="서버에서 거르기" value={name} onChange={(e) => setName(e.target.value)} />
        </span>
        <label>
          만든 뒤 <input type="date" aria-label="만든 뒤" value={after} onChange={(e) => setAfter(e.target.value)} />
        </label>
        <label>
          끝나기 전 <input type="date" aria-label="끝나기 전" value={before} onChange={(e) => setBefore(e.target.value)} />
        </label>
        <span className="argowf-colpick">
          <button className="btn small tone-secondary" aria-expanded={columnsOpen} onClick={() => setColumnsOpen(!columnsOpen)}>
            열
          </button>
          {columnsOpen && (
            <div className="argowf-colpick-pop" role="group" aria-label="레이블 열">
              {labelKeys.length === 0 && <span className="dim">고를 레이블이 없어요</span>}
              {labelKeys.map((k) => (
                <label key={k}>
                  <input
                    type="checkbox"
                    checked={labelColumns.includes(k)}
                    onChange={() => onLabelColumns(labelColumns.includes(k) ? labelColumns.filter((c) => c !== k) : [...labelColumns, k])}
                  />{" "}
                  {k}
                </label>
              ))}
            </div>
          )}
        </span>
        {list.polling && <span className="dim">실시간 연결이 끊겨 5초마다 읽는 중</span>}
      </div>
      {chosen.length > 0 && (
        <div className="argowf-batch" role="toolbar" aria-label="선택한 Workflow 동작">
          <b>선택한 {chosen.length}개</b>
          {BATCH.map((b) => (
            <button key={b.kind} className={`btn small ${workflowActionTone(b.kind)}`} onClick={() => openBatch(b.kind)}>
              {b.label}
            </button>
          ))}
          <button className="btn plain small tone-secondary" onClick={() => setPicked(new Set())}>
            선택 해제
          </button>
        </div>
      )}
      {list.isError && !isTokenError(list.error) && <p className="err">{errorMessage(list.error)}</p>}
      <div className="argowf-table-wrap" ref={listRef}>
        <ListFind find={find} placeholder="Workflow 검색" count={visible.length} />
        <table className="argowf-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="모두 선택"
                  checked={allChosen}
                  onChange={() => setPicked(allChosen ? new Set() : new Set(selectable.map(rowKey)))}
                />
              </th>
              {["이름", "네임스페이스", "상태", "원천", "시작", "걸린 시간", "메시지"].map((s) => (
                <th key={s}>{s}</th>
              ))}
              {extra.map((c) => (
                <th key={`${c.type}/${c.key}`}>{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const key = rowKey(r);
              const estimate = r.phase === "Running" && r.estimatedDuration ? r.estimatedDuration : null;
              const seconds = r.startedAt ? Math.max(0, (now - Date.parse(r.startedAt)) / 1000) : 0;
              return (
                <tr key={key} onClick={() => onOpen(r.archived ? { kind: "archived", uid: r.uid } : { kind: "live", namespace: r.namespace, name: r.name })}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`${r.name} 선택`}
                      disabled={r.archived}
                      checked={picked.has(key) && !r.archived}
                      onChange={() => flip(r)}
                    />
                  </td>
                  <td className="mono">
                    <Highlight text={r.name} tokens={tokens} />
                  </td>
                  <td className="mono">
                    <Highlight text={r.namespace} tokens={tokens} />
                  </td>
                  <td>
                    <span className={`argowf-phase ${r.phase}`}>● {r.phase}</span> {r.progress}
                  </td>
                  <td>
                    <Highlight text={sources(r).join(" · ")} tokens={tokens} />
                  </td>
                  <td>{relative(r.startedAt, now)}</td>
                  <td>
                    {elapsed(r.startedAt, r.finishedAt, now)}
                    {estimate && (
                      <span
                        className="argowf-eta"
                        role="progressbar"
                        aria-label="예상 진행"
                        aria-valuenow={Math.min(100, Math.round((seconds / estimate) * 100))}
                        title={`예상 ${estimate}초`}
                      >
                        <i style={{ width: `${Math.min(100, (seconds / estimate) * 100)}%` }} />
                      </span>
                    )}
                  </td>
                  <td className={r.phase === "Failed" || r.phase === "Error" ? "err" : ""} title={r.message ?? ""}>
                    {r.message}
                  </td>
                  {extra.map((c) => {
                    const value = c.type === "label" ? r.labels[c.key] : r.annotations[c.key];
                    return (
                      <td key={`${c.type}/${c.key}`}>
                        {value !== undefined && c.type === "label" ? (
                          <button
                            className="argowf-label"
                            title={`${c.key}=${value} 필터 더하기`}
                            onClick={(e) => {
                              e.stopPropagation();
                              addPick({ key: c.key, value: value === "" ? null : value });
                            }}
                          >
                            {value || c.key}
                          </button>
                        ) : (
                          value
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && !list.isPending && <div className="empty">Workflow가 없어요</div>}
        {list.hasMore && (
          <button className="btn more tone-secondary" disabled={list.isFetchingMore} onClick={list.fetchMore}>
            더 보기
          </button>
        )}
      </div>
      {batch && (
        <ActionDialog
          title={`선택한 ${chosen.length}개 ${BATCH.find((b) => b.kind === batch)?.label}`}
          note={`${chosen.length}개 Workflow에 ${BATCH.find((b) => b.kind === batch)?.label} 동작을 하나씩 적용해요. 실패한 것이 있어도 나머지는 계속해요.`}
          confirmLabel="적용"
          tone={workflowActionTone(batch)}
          requireName={typedName}
          busy={busy}
          error={failure}
          onCancel={() => setBatch(null)}
          onConfirm={() => void runBatch()}
        >
          <ul className="argowf-batch-targets">
            {chosen.map((r) => (
              <li key={rowKey(r)}>
                {r.namespace}/{r.name}
              </li>
            ))}
          </ul>
          {batch === "retry" && (
            <label>
              <input type="checkbox" checked={restartSuccessful} onChange={(e) => setRestartSuccessful(e.target.checked)} /> 성공한 단계도 다시
            </label>
          )}
          {batch === "resubmit" && (
            <label>
              <input type="checkbox" checked={memoized} onChange={(e) => setMemoized(e.target.checked)} /> memoized
            </label>
          )}
        </ActionDialog>
      )}
      {results && (
        <div className="modal" onClick={(e) => e.target === e.currentTarget && setResults(null)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="일괄 동작 결과">
            <h3>일괄 동작 결과</h3>
            <table className="argowf-table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>결과</th>
                  <th>새 Workflow</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={`${r.namespace}/${r.name}`}>
                    <td>
                      {r.namespace}/{r.name}
                    </td>
                    <td className={r.ok ? "" : "err"}>{r.ok ? "성공" : (r.error ?? "실패")}</td>
                    <td>{r.created ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="foot">
              <button className="btn plain tone-ghost" onClick={() => setResults(null)}>
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
