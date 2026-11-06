import { useCallback, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
import { ListFind, useListFind } from "../components/ListFind";
import { ListTable } from "../iam/ListTable";
import { columnsFor, type TrendOf } from "./columns";
import { ListFilterBar } from "./ListFilterBar";
import { matchesListFilter, NO_FILTER, stateCounts, type ListFilter } from "./listFilter";
import { matchesFilter, parseFilter } from "./selector";
import { kindKey } from "./targets";
import { BAD_SELECTOR, FILTER_PLACEHOLDER, LIST_EMPTY, LIST_NO_MATCH, LOADING, METRICS_UNAVAILABLE } from "./text";
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

/** 감시로 받은 행을 이름·레이블 셀렉터(⌘F로 여는 찾기 줄)와 필터 줄(상태·값·나이·재시작·이상)로 걸러 보여 준다 */
export function ObjectList({ kind, rows, status, showNamespace, selectedUid, onSelect, onClear, onOpen, now, usage, historyKey, host, active = true }: Props) {
  const find = useListFind(host, { enabled: active });
  const key = kindKey(kind);
  const [saved, setSaved] = useState<{ key: string; filter: ListFilter }>({ key, filter: NO_FILTER });
  // 종류가 바뀌면 그 종류에만 뜻이 있는 필터(상태·값·재시작)는 풀고 나이·이상만 이어 간다
  const listFilter = saved.key === key ? saved.filter : { ...NO_FILTER, age: saved.filter.age, onlyProblems: saved.filter.onlyProblems };
  const filter = parseFilter(find.query);
  const at = now ?? Date.now();
  const found = rows.filter((r) => matchesFilter(r, filter));
  const shown = found.filter((r) => matchesListFilter(r, listFilter, at));
  // 상태 칩의 수는 상태 말고 나머지 필터를 거친 행에서 센다
  const counts = stateCounts(found.filter((r) => matchesListFilter(r, { ...listFilter, states: [] }, at)));
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
      <ListFilterBar kind={kind} rows={found} stateCounts={counts} filter={listFilter} onChange={(next) => setSaved({ key, filter: next })} />
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
