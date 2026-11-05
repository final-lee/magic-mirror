import { useMemo, useState } from "react";
import { ErrorState } from "../../components/ErrorState";
import { age } from "../../k8s/format";
import type { ArgoChange } from "../change/types";
import { ArgoBadge, shortRev } from "../argoParts";
import { RollbackForm } from "../ops/RollbackForm";
import { useArgoEvents } from "../queries";
import { ARGO_AUTOMATED_USER, ARGO_NO_HISTORY, H_ARGO_ID, H_MESSAGE, L_ARGO_INITIATED, L_ARGO_REVISIONS, LOADING } from "../text";
import type { ArgoEvent, ArgoHistoryEntry } from "../types";
import { DiffBody } from "./DiffBody";
import { localOperations, revisionPair } from "./helpers";
import { Sect } from "./parts";
import { useAppHistory, useManifestsDiff } from "./queries";
import { RevisionCell } from "./RevisionCell";
import {
  H_HIST_ELAPSED, H_HIST_PICK, H_HIST_RESULT, H_HIST_WHEN, HIST_CLEAR, HIST_COMPARE, HIST_COMPARE_HINT, HIST_LOCAL, HIST_LOCAL_NOTE, HIST_NO_LOCAL,
  HIST_NO_MANIFEST_DIFF, HIST_SERVER, elapsedText, histCompareTitle, histSelect,
} from "./text";
import { useTokenGuard } from "./useTokenGuard";
import { H_HIST_ROLLBACK, HIST_ROLLBACK, histRollbackLabel } from "../ops/text";

const who = (v: string | null) => (v === "automated" ? ARGO_AUTOMATED_USER : v);

/** 이력 탭에서 롤백을 시작하는 데 필요한 것(권한·앱 상태는 상세가 안다) */
export interface RollbackAccess {
  /** 권한이 있고 동기화가 진행 중이 아니다 */
  allowed: boolean;
  /** allowed가 false인 이유(툴팁) */
  reason: string | null;
  /** 앱의 자동 동기화가 켜져 있다 */
  autoSync: boolean;
  /** 폼을 마친 롤백 변경을 변경 시트로 넘긴다 */
  onChange: (change: ArgoChange) => void;
}

function ServerHistory({ entries, picked, onPick, at, rollback, onRollback }: { entries: ArgoHistoryEntry[]; picked: number[]; onPick: (id: number) => void; at: number; rollback: RollbackAccess | null; onRollback: (entry: ArgoHistoryEntry) => void }) {
  return (
    <table className="k8s-table" aria-label={HIST_SERVER}>
      <thead>
        <tr>
          <th>{H_HIST_PICK}</th>
          <th>{H_ARGO_ID}</th>
          <th>{L_ARGO_REVISIONS}</th>
          <th>{H_HIST_WHEN}</th>
          <th>{L_ARGO_INITIATED}</th>
          {rollback && <th>{H_HIST_ROLLBACK}</th>}
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id}>
            <td>
              <input type="checkbox" aria-label={histSelect(e.id)} checked={picked.includes(e.id)} onChange={() => onPick(e.id)} />
            </td>
            <td>{e.id}</td>
            <td>
              {e.revisions.map((r) => (
                <RevisionCell key={r.sourceIndex} info={r} at={at} />
              ))}
            </td>
            <td>{e.deployedAt && <span title={e.deployedAt}>{age(e.deployedAt, at)}</span>}</td>
            <td>{who(e.initiatedBy)}</td>
            {rollback && (
              <td>
                <button className="btn small tone-warn" aria-label={histRollbackLabel(e.id)} disabled={!rollback.allowed} title={rollback.reason ?? undefined} onClick={() => onRollback(e)}>
                  {HIST_ROLLBACK}
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LocalOperations({ events, at }: { events: ArgoEvent[]; at: number }) {
  if (events.length === 0) return <p className="dim">{HIST_NO_LOCAL}</p>;
  return (
    <table className="k8s-table" aria-label={HIST_LOCAL}>
      <thead>
        <tr>
          <th>{H_HIST_WHEN}</th>
          <th>{H_HIST_RESULT}</th>
          <th>{L_ARGO_REVISIONS}</th>
          <th>{L_ARGO_INITIATED}</th>
          <th>{H_HIST_ELAPSED}</th>
          <th>{H_MESSAGE}</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => {
          const started = e.startedAt ? Date.parse(e.startedAt) : NaN;
          const finished = e.finishedAt ? Date.parse(e.finishedAt) : NaN;
          return (
            <tr key={`${e.at}/${e.revision}/${e.phase}`}>
              <td title={e.at}>{age(e.at, at)}</td>
              <td>
                <ArgoBadge status={e.phase ?? e.to} />
              </td>
              <td className="mono">{e.revision ? shortRev(e.revision) : ""}</td>
              <td>{who(e.initiatedBy)}</td>
              <td>{Number.isNaN(started) || Number.isNaN(finished) ? "" : elapsedText(finished - started)}</td>
              <td className="k8s-wrap">{e.message}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface Props {
  url: string;
  namespace: string;
  name: string;
  /** 앱의 resourceVersion(새 배포가 있으면 바뀌어 다시 읽는다) */
  version: string | null;
  /** 이 탭이 보일 때만 읽는다 */
  enabled: boolean;
  now?: number;
  onTokenError: (message: string) => void;
  /** 롤백 버튼을 보일 때만 준다(권한이 없으면 allowed=false로 끈다). 없으면 롤백 열이 없다 */
  rollback?: RollbackAccess | null;
}

/**
 * 이력 탭: 서버가 남긴 배포 이력 전부(리비전 메타데이터·차트·OCI, Git 커밋 링크)와, 이 앱에서 본 로컬 작업 기록.
 * 이력 두 건을 고르면 두 리비전의 렌더 결과(manifest)를 비교한다.
 */
export function HistoryTab({ url, namespace, name, version, enabled, now, onTokenError, rollback = null }: Props) {
  const history = useAppHistory(url, namespace, name, version, enabled);
  const events = useArgoEvents(url, null);
  const [picked, setPicked] = useState<number[]>([]);
  const [rolling, setRolling] = useState<ArgoHistoryEntry | null>(null);
  const entries = history.data;
  const pair = entries ? revisionPair(entries, picked) : null;
  const compare = useManifestsDiff(
    url,
    namespace,
    name,
    pair ? pair.from.revisions.map((r) => r.revision) : null,
    pair ? pair.to.revisions.map((r) => r.revision) : null,
  );
  useTokenGuard([history.error, compare.error, events.error], onTokenError);
  const local = useMemo(() => localOperations(events.data ?? [], namespace, name), [events.data, namespace, name]);
  const at = now ?? Date.now();

  // 셋째를 고르면 가장 먼저 고른 것을 푼다
  const pick = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));

  return (
    <div>
      <Sect title={HIST_SERVER}>
        {history.isError ? (
          <ErrorState error={history.error} profile="" compact onRetry={() => void history.refetch()} />
        ) : !entries ? (
          <div className="empty">{LOADING}</div>
        ) : entries.length === 0 ? (
          <p className="dim">{ARGO_NO_HISTORY}</p>
        ) : (
          <>
            <div className="k8s-list-bar">
              <span className="dim">{HIST_COMPARE_HINT}</span>
              {picked.length > 0 && (
                <button className="btn small tone-secondary" onClick={() => setPicked([])}>
                  {HIST_CLEAR}
                </button>
              )}
            </div>
            <ServerHistory entries={entries} picked={picked} onPick={pick} at={at} rollback={rollback} onRollback={setRolling} />
          </>
        )}
      </Sect>
      {pair && (
        <Sect title={HIST_COMPARE}>
          <p className="mono">{histCompareTitle(pair.from.id, pair.to.id)}</p>
          {compare.isError ? (
            <ErrorState error={compare.error} profile="" compact onRetry={() => void compare.refetch()} />
          ) : compare.data ? (
            <DiffBody diff={compare.data} same={HIST_NO_MANIFEST_DIFF} />
          ) : (
            <div className="empty">{LOADING}</div>
          )}
        </Sect>
      )}
      <Sect title={HIST_LOCAL}>
        <p className="dim">{HIST_LOCAL_NOTE}</p>
        <LocalOperations events={local} at={at} />
      </Sect>
      {rolling && rollback && entries && (
        <RollbackForm
          url={url}
          namespace={namespace}
          name={name}
          entry={rolling}
          current={entries.reduce((a, b) => (b.id > a.id ? b : a))}
          autoSync={rollback.autoSync}
          now={now}
          onCancel={() => setRolling(null)}
          onPreview={(change) => {
            setRolling(null);
            rollback.onChange(change);
          }}
        />
      )}
    </div>
  );
}
