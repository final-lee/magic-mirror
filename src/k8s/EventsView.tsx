import { useMemo, useState } from "react";
import { age } from "./format";
import { K8sError } from "./K8sError";
import { EVENTS } from "./kinds";
import { H_COUNT, H_KIND, H_MESSAGE, H_OBJECT, H_REASON, H_TIME, LOADING, NAV_EVENTS, NO_EVENTS, WARNINGS_ONLY } from "./text";
import type { K8sTarget } from "./types";
import { useK8sWatch } from "./useK8sWatch";

interface Props {
  target: K8sTarget;
  context: string;
  sessionEpoch: number;
  ssoProfile: string;
  live: boolean;
  /** null이면 모든 네임스페이스 */
  namespace: string | null;
  now?: number;
}

/** 네임스페이스(또는 클러스터 전체)의 이벤트를 감시해 최근 것부터 보여 준다 */
export function EventsView({ target, context, sessionEpoch, ssoProfile, live, namespace, now }: Props) {
  const w = useK8sWatch(target, context, sessionEpoch, ssoProfile, EVENTS, namespace, live);
  const [warningsOnly, setWarningsOnly] = useState(false);
  const rows = useMemo(
    () => w.rows.filter((r) => !warningsOnly || r.values.type === "Warning").sort((a, b) => (b.values.lastSeen ?? "").localeCompare(a.values.lastSeen ?? "")),
    [w.rows, warningsOnly],
  );
  const at = now ?? Date.now();
  return (
    <div className="k8s-events">
      {w.error && <K8sError error={w.error} target={target} ssoProfile={ssoProfile} compact />}
      <div className="k8s-list-bar">
        <label className="k8s-check">
          <input type="checkbox" checked={warningsOnly} onChange={(e) => setWarningsOnly(e.target.checked)} />
          {WARNINGS_ONLY}
        </label>
      </div>
      {w.status === "loading" ? (
        <div className="empty">{LOADING}</div>
      ) : rows.length === 0 && !w.error ? (
        <div className="empty">{NO_EVENTS}</div>
      ) : (
        <table className="k8s-table" aria-label={NAV_EVENTS}>
          <thead>
            <tr><th>{H_TIME}</th><th>{H_KIND}</th><th>{H_REASON}</th><th>{H_OBJECT}</th><th>{H_MESSAGE}</th><th>{H_COUNT}</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.uid} className={r.values.type === "Warning" ? "k8s-warn" : undefined}>
                <td title={r.values.lastSeen ?? ""}>{age(r.values.lastSeen ?? null, at)}</td>
                <td>{r.values.type ?? ""}</td>
                <td>{r.values.reason ?? ""}</td>
                <td className="mono">{namespace === null && r.namespace ? `${r.namespace}/${r.values.object ?? ""}` : r.values.object ?? ""}</td>
                <td>{r.values.message ?? ""}</td>
                <td>{r.values.count ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
