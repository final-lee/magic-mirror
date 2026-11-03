import { useMemo, useState } from "react";
import { ListTable } from "../iam/ListTable";
import { columnsFor } from "./columns";
import { matchesFilter, parseFilter } from "./selector";
import { BAD_SELECTOR, FILTER_PLACEHOLDER, LIST_EMPTY, LIST_NO_MATCH, LOADING, METRICS_UNAVAILABLE, ONLY_PROBLEMS } from "./text";
import type { K8sKindRef, K8sRow } from "./types";
import { unavailableFor, type UsageIndex } from "./usage";

interface Props {
  kind: K8sKindRef;
  rows: K8sRow[];
  status: "loading" | "ready" | "error";
  /** 모든 네임스페이스를 보는 중이면 네임스페이스 열을 보인다 */
  showNamespace: boolean;
  selectedUid: string | null;
  /** 클릭·↑/↓ 선택 */
  onSelect: (row: K8sRow) => void;
  /** 더블클릭·Enter. 없으면 onSelect */
  onOpen?: (row: K8sRow) => void;
  /** 나이 계산 기준(시험용). 없으면 그리는 시각 */
  now?: number;
  /** 사용량(metrics-server). 없으면 사용량 열도 안내도 없다 */
  usage?: UsageIndex | null;
}

/** 감시로 받은 행을 이름·레이블 셀렉터·이상 여부로 걸러 보여 준다 */
export function ObjectList({ kind, rows, status, showNamespace, selectedUid, onSelect, onOpen, now, usage }: Props) {
  const [query, setQuery] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const filter = parseFilter(query);
  const shown = rows.filter((r) => matchesFilter(r, filter) && (!onlyProblems || r.problems.length > 0));
  const at = now ?? Date.now();
  const columns = useMemo(() => columnsFor(kind, showNamespace, at, usage), [kind, showNamespace, at, usage]);
  const unavailable = usage ? unavailableFor(kind, usage) : null;
  const pick = (uid: string, then: (row: K8sRow) => void) => {
    const r = rows.find((x) => x.uid === uid);
    if (r) then(r);
  };
  return (
    <div className="k8s-list">
      <div className="k8s-list-bar">
        <input type="search" className="k8s-filter" aria-label={FILTER_PLACEHOLDER} placeholder={FILTER_PLACEHOLDER} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="k8s-check">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          {ONLY_PROBLEMS}
        </label>
      </div>
      {unavailable && <p className="dim k8s-hint">{METRICS_UNAVAILABLE[unavailable]}</p>}
      {filter.kind === "invalid" && <p className="err k8s-hint">{BAD_SELECTOR}</p>}
      {status === "loading" ? (
        <div className="empty">{LOADING}</div>
      ) : (
        <ListTable
          label={kind.kind}
          rows={shown}
          columns={columns}
          rowKey={(r) => r.uid}
          selectedId={selectedUid}
          onSelect={(uid) => pick(uid, onSelect)}
          onOpen={(uid) => pick(uid, onOpen ?? onSelect)}
          empty={rows.length === 0 ? LIST_EMPTY : LIST_NO_MATCH}
        />
      )}
    </div>
  );
}
