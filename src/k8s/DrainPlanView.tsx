import * as t from "./text";
import type { K8sDrainPlan } from "./types";

/** drain 미리보기: 옮길 Pod와 그 경고 표시, 건너뛸 Pod. */
export function DrainPlanView({ plan }: { plan: K8sDrainPlan }) {
  return (
    <>
      <h4>{t.DRAIN_PLAN_EVICT}</h4>
      {plan.evict.length === 0 ? (
        <p>{t.DRAIN_NO_PODS}</p>
      ) : (
        <table className="k8s-table" aria-label={t.DRAIN_PLAN_EVICT}>
          <thead>
            <tr>
              <th>{t.DRAIN_POD}</th>
              <th>{t.DRAIN_NOTE}</th>
            </tr>
          </thead>
          <tbody>
            {plan.evict.map((pod) => (
              <tr key={pod.uid || `${pod.namespace}/${pod.name}`}>
                <td className="mono">{pod.namespace}/{pod.name}</td>
                <td>
                  {pod.emptyDir && <span className="err">{t.DRAIN_FLAG_EMPTY_DIR} </span>}
                  {pod.unmanaged && <span className="err">{t.DRAIN_FLAG_UNMANAGED} </span>}
                  {pod.blockedBy !== null && <span className="err">{t.DRAIN_FLAG_BLOCKED(pod.blockedBy)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {plan.skipped.length > 0 && (
        <>
          <h4>{t.DRAIN_PLAN_SKIPPED}</h4>
          <table className="k8s-table" aria-label={t.DRAIN_PLAN_SKIPPED}>
            <tbody>
              {plan.skipped.map((pod) => (
                <tr key={`${pod.namespace}/${pod.name}`}>
                  <td className="mono">{pod.namespace}/{pod.name}</td>
                  <td>{t.DRAIN_SKIP_REASON[pod.reason]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
