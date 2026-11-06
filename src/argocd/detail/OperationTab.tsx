import { useEffect, useMemo, useState } from "react";
import { age } from "../../k8s/format";
import { ArgoBadge, shortRev } from "../argoParts";
import {
  ARGO_AUTOMATED_USER, ARGO_NO_OPERATION, H_MESSAGE, L_ARGO_FINISHED, L_ARGO_INITIATED, L_ARGO_MESSAGE, L_ARGO_PHASE, L_ARGO_REVISIONS, L_ARGO_STARTED, SEC_ARGO_OPERATION,
} from "../text";
import type { ArgoApp, ResRef } from "../types";
import { operationElapsedMs, operationRows } from "./helpers";
import { Kv, Sect } from "./parts";
import { useOperationWaves } from "./queries";
import {
  H_OP_HOOK, H_OP_KIND, H_OP_NAME, H_OP_PHASE, H_OP_STATUS, H_OP_WAVE, OP_DRY_RUN, OP_ELAPSED, OP_NO_RESULTS, OP_PRUNE, OP_RESULTS, OP_RETRY, OP_RUNNING_NOTE, OP_SYNC_OPTIONS,
  ARGO_NODE_OPEN, elapsedText, opRetry,
} from "./text";
import { useTokenGuard } from "./useTokenGuard";
import { TERMINATE, TERMINATE_NOTE } from "../ops/text";

const when = (iso: string | null, at: number) => (iso ? <span title={iso}>{age(iso, at)}</span> : null);

/** 진행 중인 동안 1초마다 지금 시각을 새로 읽는다(경과 시간용). 아니면 한 번만 읽는다. */
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

interface Props {
  url: string;
  app: ArgoApp;
  /** 테스트에서 시각을 고정한다 */
  now?: number;
  onOpen: (res: ResRef) => void;
  onTokenError: (message: string) => void;
  /** 진행 중인 작업을 멈추는 버튼(권한이 없으면 allowed=false로 끄고 reason을 툴팁에). 진행 중일 때만 보인다 */
  terminate: { allowed: boolean; reason: string | null; onTerminate: () => void };
}

/**
 * 최근 동기화 작업의 상태: 단계·메시지·경과·재시도·옵션과, 리소스별 결과(hook 단계와 sync wave 포함).
 * 앱이 바뀔 때마다 상세가 다시 읽히므로 진행 중인 작업이 그대로 따라온다. 결과는 단계 → wave 순서로 늘어놓는다.
 */
export function OperationTab({ url, app, now, onOpen, onTokenError, terminate }: Props) {
  const op = app.operation;
  const running = op?.phase === "Running";
  const clock = useClock(running && now === undefined);
  const at = now ?? clock;
  const hasResults = (op?.results.length ?? 0) > 0;
  const waves = useOperationWaves(url, app.namespace, app.name, op?.revisions ?? [], hasResults);
  useTokenGuard([waves.error], onTokenError);
  const rows = useMemo(() => operationRows(op?.results ?? [], waves.data), [op?.results, waves.data]);
  if (!op) return <p className="dim">{ARGO_NO_OPERATION}</p>;
  const elapsed = operationElapsedMs(op, at);
  const options = [op.dryRun ? OP_DRY_RUN : null, op.prune ? OP_PRUNE : null, ...op.syncOptions].filter((o): o is string => o !== null);
  return (
    <div>
      <Sect title={SEC_ARGO_OPERATION}>
        <dl className="kv">
          <Kv label={L_ARGO_PHASE}>
            <ArgoBadge status={op.phase} />
          </Kv>
          <Kv label={L_ARGO_MESSAGE}>{op.message && <span className="argo-pre k8s-wrap">{op.message}</span>}</Kv>
          <Kv label={L_ARGO_INITIATED}>{op.initiatedBy === "automated" ? ARGO_AUTOMATED_USER : op.initiatedBy}</Kv>
          <Kv label={L_ARGO_STARTED}>{when(op.startedAt, at)}</Kv>
          <Kv label={L_ARGO_FINISHED}>{when(op.finishedAt, at)}</Kv>
          <Kv label={OP_ELAPSED}>{elapsed === null ? null : elapsedText(elapsed)}</Kv>
          <Kv label={OP_RETRY}>{op.retryCount > 0 || op.retryLimit !== null ? opRetry(op.retryCount, op.retryLimit) : null}</Kv>
          <Kv label={L_ARGO_REVISIONS}>{op.revisions.length > 0 ? <span className="mono">{op.revisions.map(shortRev).join(", ")}</span> : null}</Kv>
          <Kv label={OP_SYNC_OPTIONS}>{options.length > 0 ? options.join(", ") : null}</Kv>
        </dl>
        {running && (
          <>
            <p className="dim">{OP_RUNNING_NOTE}</p>
            <p className="dim">{TERMINATE_NOTE}</p>
            <button className="btn small tone-caution" disabled={!terminate.allowed} title={terminate.reason ?? undefined} onClick={terminate.onTerminate}>
              {TERMINATE}
            </button>
          </>
        )}
      </Sect>
      <Sect title={OP_RESULTS}>
        {rows.length === 0 ? (
          <p className="dim">{OP_NO_RESULTS}</p>
        ) : (
          <table className="k8s-table" aria-label={OP_RESULTS}>
            <thead>
              <tr>
                <th>{H_OP_WAVE}</th>
                <th>{H_OP_PHASE}</th>
                <th>{H_OP_KIND}</th>
                <th>{H_OP_NAME}</th>
                <th>{H_OP_STATUS}</th>
                <th>{H_OP_HOOK}</th>
                <th>{H_MESSAGE}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, result: r, wave, hook }) => (
                <tr key={key}>
                  <td>{wave ?? "–"}</td>
                  <td>{r.syncPhase}</td>
                  <td>{r.kind}</td>
                  <td className="k8s-wrap">
                    <button className="link mono" title={ARGO_NODE_OPEN} onClick={() => onOpen({ group: r.group, version: r.version, kind: r.kind, namespace: r.namespace, name: r.name })}>
                      {r.name}
                    </button>
                    {r.namespace && <span className="dim"> {r.namespace}</span>}
                  </td>
                  <td>
                    <ArgoBadge status={r.status} />
                  </td>
                  <td>
                    {hook}
                    {r.hookPhase && (
                      <>
                        {hook && " "}
                        <ArgoBadge status={r.hookPhase} />
                      </>
                    )}
                  </td>
                  <td className="k8s-wrap">{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Sect>
    </div>
  );
}
