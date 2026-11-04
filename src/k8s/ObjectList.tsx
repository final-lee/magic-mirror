import { useCallback, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
import { ListFind, useListFind } from "../components/ListFind";
import { ListTable } from "../iam/ListTable";
import { columnsFor, type TrendOf } from "./columns";
import { matchesFilter, parseFilter } from "./selector";
import { BAD_SELECTOR, FILTER_PLACEHOLDER, LIST_EMPTY, LIST_NO_MATCH, LOADING, METRICS_UNAVAILABLE, ONLY_PROBLEMS } from "./text";
import type { K8sKindRef, K8sRow } from "./types";
import { unavailableFor, usageKindOf, type UsageIndex } from "./usage";
import { nodeTrend, podTrend, subscribeUsage, usageVersion } from "./usageHistory";

interface Props {
  kind: K8sKindRef;
  rows: K8sRow[];
  status: "loading" | "ready" | "error";
  /** 모든 네임스페이스를 보는 중이면 네임스페이스 열을 보인다 */
  showNamespace: boolean;
  selectedUid: string | null;
  /** 클릭·↑/↓ 선택 */
  onSelect: (row: K8sRow) => void;
  /** 선택을 푼다(고른 행을 다시 누르거나 빈 곳) */
  onClear: () => void;
  /** 더블클릭·Enter. 없으면 onSelect */
  onOpen?: (row: K8sRow) => void;
  /** 나이 계산 기준(시험용). 없으면 그리는 시각 */
  now?: number;
  /** 사용량(metrics-server). 없으면 사용량 열도 안내도 없다 */
  usage?: UsageIndex | null;
  /** 앱이 모은 사용량 기록의 키(usageHistory.historyKey). 있으면 Pod·노드 비율 칸에 최근 추이 그래프를 둔다 */
  historyKey?: string | null;
  /** ⌘F를 받는 상자: 목록과 그 위에 뜨는 상세를 함께 감싼 곳(상세에 커서가 있어도 ⌘F는 이 목록으로 온다) */
  host: RefObject<HTMLElement>;
  /** 탭이 보이는 동안에만 ⌘F를 받는다 */
  active?: boolean;
}

/** 감시로 받은 행을 이름·레이블 셀렉터(⌘F로 여는 찾기 줄)·이상 여부로 걸러 보여 준다 */
export function ObjectList({ kind, rows, status, showNamespace, selectedUid, onSelect, onClear, onOpen, now, usage, historyKey, host, active = true }: Props) {
  const find = useListFind(host, { enabled: active });
  const [onlyProblems, setOnlyProblems] = useState(false);
  const filter = parseFilter(find.query);
  const shown = rows.filter((r) => matchesFilter(r, filter) && (!onlyProblems || r.problems.length > 0));
  const at = now ?? Date.now();
  // 새 기록이 들어올 때마다 다시 그려 추이 그래프를 늘린다
  const subscribe = useCallback((listener: () => void) => (historyKey ? subscribeUsage(historyKey, listener) : () => {}), [historyKey]);
  const version = useSyncExternalStore(subscribe, () => (historyKey ? usageVersion(historyKey) : 0));
  // version이 바뀌면(같은 키에 기록이 늘면) 새 함수로 열을 다시 만든다
  const usageKind = usageKindOf(kind);
  const trendOf = useMemo<TrendOf | null>(() => {
    if (!historyKey) return null;
    if (usageKind === "pod") return (r) => podTrend(historyKey, r.namespace ?? "", r.name);
    if (usageKind === "node") return (r) => nodeTrend(historyKey, r.name);
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version은 다시 만들 때를 알리는 값이다
  }, [historyKey, usageKind, version]);
  const columns = useMemo(() => columnsFor(kind, showNamespace, at, usage, trendOf), [kind, showNamespace, at, usage, trendOf]);
  const unavailable = usage ? unavailableFor(kind, usage) : null;
  const pick = (uid: string, then: (row: K8sRow) => void) => {
    const r = rows.find((x) => x.uid === uid);
    if (r) then(r);
  };
  return (
    <div className="k8s-list">
      <ListFind find={find} placeholder={FILTER_PLACEHOLDER} count={shown.length} />
      <div className="k8s-list-bar">
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
          onClear={onClear}
          onOpen={(uid) => pick(uid, onOpen ?? onSelect)}
          empty={rows.length === 0 ? LIST_EMPTY : LIST_NO_MATCH}
          vimKeys
        />
      )}
    </div>
  );
}
