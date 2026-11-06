import { useMemo, useState } from "react";
import { ErrorState } from "../../components/ErrorState";
import { ArgoBadge } from "../argoParts";
import { LOADING } from "../text";
import type { AppDiffRow, ResRef } from "../types";
import { DiffBody } from "./DiffBody";
import { filterDiffRows } from "./helpers";
import { useAppDiff } from "./queries";
import {
  ARGO_NODE_OPEN, DIFF_CHANGED_ONLY, DIFF_LIST_LABEL, DIFF_NONE, DIFF_NO_CHANGES, DIFF_NO_MATCH, DIFF_OUT_OF_SYNC_ONLY, DIFF_UNCHANGED, diffStats, diffSummary, diffToggle,
} from "./text";
import { useTokenGuard } from "./useTokenGuard";

/** 처음부터 펼쳐 두는 리소스 수의 한계(이보다 많으면 모두 접어 두고 하나씩 펼친다) */
const OPEN_LIMIT = 3;

const rowKey = (r: AppDiffRow) => `${r.res.group}/${r.res.kind}/${r.res.namespace ?? ""}/${r.res.name}`;

interface Props {
  url: string;
  namespace: string;
  name: string;
  /** 앱의 resourceVersion(바뀌면 다시 읽는다) */
  version: string | null;
  /** 이 탭이 보일 때만 읽는다 */
  enabled: boolean;
  onOpen: (res: ResRef) => void;
  onTokenError: (message: string) => void;
}

/** 앱이 관리하는 리소스마다 정규화된 live와 적용 뒤 예상 상태(없으면 목표 상태)의 줄 단위 diff. 바뀐 것만, OutOfSync만 거를 수 있다. */
export function AppDiffTab({ url, namespace, name, version, enabled, onOpen, onTokenError }: Props) {
  const q = useAppDiff(url, namespace, name, version, enabled);
  useTokenGuard([q.error], onTokenError);
  const [changedOnly, setChangedOnly] = useState(true);
  const [outOfSyncOnly, setOutOfSyncOnly] = useState(false);
  // 사용자가 직접 펼치거나 접은 리소스. 안 건드린 것은 OPEN_LIMIT 규칙을 따른다
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const rows = q.data;
  const shown = useMemo(() => (rows ? filterDiffRows(rows, { changedOnly, outOfSyncOnly }) : []), [rows, changedOnly, outOfSyncOnly]);

  if (q.isError) return <ErrorState error={q.error} profile="" compact onRetry={() => void q.refetch()} />;
  if (!rows) return <div className="empty">{LOADING}</div>;

  const changed = rows.filter((r) => r.changed).length;
  const openByDefault = shown.length <= OPEN_LIMIT;
  const isOpen = (r: AppDiffRow) => toggled[rowKey(r)] ?? openByDefault;
  return (
    <div className="argo-diff-tab">
      <div className="k8s-list-bar">
        <label className="k8s-check">
          <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
          {DIFF_CHANGED_ONLY}
        </label>
        <label className="k8s-check">
          <input type="checkbox" checked={outOfSyncOnly} onChange={(e) => setOutOfSyncOnly(e.target.checked)} />
          {DIFF_OUT_OF_SYNC_ONLY}
        </label>
        <span className="dim">{diffSummary(changed, rows.length)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="dim">{DIFF_NONE}</p>
      ) : shown.length === 0 ? (
        <p className="dim">{changed === 0 && changedOnly && !outOfSyncOnly ? DIFF_NO_CHANGES : DIFF_NO_MATCH}</p>
      ) : (
        <div role="list" aria-label={DIFF_LIST_LABEL}>
          {shown.map((r) => (
            <div key={rowKey(r)} role="listitem" className="argo-diff-res">
              <div className="argo-diff-head">
                <button className="link argo-diff-toggle" aria-expanded={isOpen(r)} aria-label={diffToggle(r.res.name)} onClick={() => setToggled((t) => ({ ...t, [rowKey(r)]: !isOpen(r) }))}>
                  {isOpen(r) ? "▾" : "▸"}
                </button>
                <span className="dim">{r.res.kind}</span>
                <button className="link mono k8s-wrap" title={ARGO_NODE_OPEN} onClick={() => onOpen(r.res)}>
                  {r.res.name}
                </button>
                {r.res.namespace && <span className="dim">{r.res.namespace}</span>}
                <ArgoBadge status={r.syncStatus} />
                <ArgoBadge status={r.health} />
                <span className="dim mono k8s-push">{r.changed ? diffStats(r.diff.stats) : DIFF_UNCHANGED}</span>
              </div>
              {isOpen(r) && <DiffBody diff={r.diff} same={DIFF_UNCHANGED} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
