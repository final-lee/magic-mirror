import { useMemo, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { Highlight } from "../components/Highlight";
import { fuzzyFilter, tokenize } from "../lib/fuzzy";
import { isFailed } from "./catalogData";
import { durationText, relTime } from "./catalogFormat";
import { useTokenGate } from "./catalogHooks";
import { OriginCell, PhaseCell } from "./catalogParts";
import {
  ARCHIVE_EMPTY,
  ARCHIVE_NO_MATCH,
  ARCHIVE_SEARCH,
  CAT_LOADING,
  COL_DURATION,
  COL_MESSAGE,
  COL_NAME,
  COL_NAMESPACE,
  COL_ORIGIN,
  COL_STARTED,
  COL_STATE,
} from "./catalogText";
import { useArchivedPages } from "./catalogQueries";
import { emptyQuery } from "./wfQuery";
import type { ArgoWfConn, WfRow, WfTarget } from "./types";

interface Props {
  conn: ArgoWfConn;
  live: boolean;
  namespace?: string | null;
  /** 열려 있는 보관 Workflow의 uid */
  selected: string | null;
  onOpen: (target: WfTarget) => void;
  onTokenError: (message: string) => void;
}

/** 시작이 최근인 것부터(시작하지 않은 것은 맨 위) */
const newest = (a: WfRow, b: WfRow) => (b.startedAt ? Date.parse(b.startedAt) : Infinity) - (a.startedAt ? Date.parse(a.startedAt) : Infinity) || 0;

/** 보관함(Argo Server의 archived-workflows). 열은 Workflows 목록과 같고, 서버에 아카이브가 없으면 안내만 보인다. */
export function ArchiveList({ conn, live, namespace = null, selected, onOpen, onTokenError }: Props) {
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [nameMode, setNameMode] = useState<"exact" | "prefix" | "contains">("contains");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const q = useArchivedPages(
    conn,
    {
      ...emptyQuery(namespace),
      labelSelector: label || null,
      name: name ? { mode: nameMode, value: name } : null,
      createdAfter: after ? new Date(after).toISOString() : null,
      finishedBefore: before ? new Date(before).toISOString() : null,
    },
    live,
  );
  useTokenGate([q.error], onTokenError);
  const [search, setSearch] = useState("");
  const sorted = useMemo(() => (q.data?.pages.flatMap((page) => page.rows) ?? []).sort(newest), [q.data]);
  const tokens = useMemo(() => tokenize(search), [search]);
  const rows = useMemo(() => fuzzyFilter(sorted, search, (w) => [w.name, w.namespace, w.cron, w.template, ...Object.values(w.labels)]), [sorted, search]);
  const now = Date.now();

  return (
    <div className="awc">
      {q.isError && <ErrorState error={q.error} profile={conn.ssoProfile ?? ""} compact onRetry={() => void q.refetch()} />}
      <div className="awc-bar">
        <h2 className="awc-title">보관함</h2>
        <input className="k8s-filter" aria-label={ARCHIVE_SEARCH} placeholder={ARCHIVE_SEARCH} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="awc-filters">
        <input aria-label="레이블 선택자" placeholder="레이블 (key=value)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <label>
          이름
          <select aria-label="이름 조건" value={nameMode} onChange={(e) => setNameMode(e.target.value as typeof nameMode)}>
            <option value="contains">포함</option>
            <option value="prefix">앞부분</option>
            <option value="exact">정확히</option>
          </select>
          <input aria-label="이름" placeholder="서버에서 거르기" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          만든 뒤 <input type="datetime-local" value={after} onChange={(e) => setAfter(e.target.value)} />
        </label>
        <label>
          끝나기 전 <input type="datetime-local" value={before} onChange={(e) => setBefore(e.target.value)} />
        </label>
      </div>
      <div className="awc-scroll">
        {q.isPending ? (
          <div className="empty">{CAT_LOADING}</div>
        ) : sorted.length === 0 ? (
          !q.isError && <div className="empty">{ARCHIVE_EMPTY}</div>
        ) : rows.length === 0 ? (
          <div className="empty">{ARCHIVE_NO_MATCH}</div>
        ) : (
          <table className="k8s-table awc-table" aria-label={ARCHIVE_SEARCH}>
            <thead>
              <tr>
                <th>{COL_NAME}</th>
                <th>{COL_NAMESPACE}</th>
                <th>{COL_STATE}</th>
                <th>{COL_ORIGIN}</th>
                <th>{COL_STARTED}</th>
                <th>{COL_DURATION}</th>
                <th>{COL_MESSAGE}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => {
                const on = selected === w.uid;
                const open = () => onOpen({ kind: "archived", uid: w.uid });
                return (
                  <tr
                    key={w.uid}
                    className={`awc-row${on ? " on" : ""}`}
                    tabIndex={0}
                    aria-selected={on}
                    onClick={open}
                    onKeyDown={(e) => e.key === "Enter" && open()}
                  >
                    <td className="mono k8s-wrap">
                      <Highlight text={w.name} tokens={tokens} />
                    </td>
                    <td className="mono">
                      <Highlight text={w.namespace} tokens={tokens} />
                    </td>
                    <td>
                      <PhaseCell row={w} />
                    </td>
                    <td>
                      <OriginCell row={w} />
                    </td>
                    <td title={w.startedAt ?? ""}>{relTime(w.startedAt, now)}</td>
                    <td>{durationText(w.startedAt, w.finishedAt, now)}</td>
                    <td className={isFailed(w.phase) ? "err awc-msg" : "awc-msg"} title={w.message ?? ""}>
                      {w.message}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {q.hasNextPage && (
        <button className="btn more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          더 보기
        </button>
      )}
    </div>
  );
}
