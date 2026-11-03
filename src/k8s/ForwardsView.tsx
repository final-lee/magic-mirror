import { ErrorState } from "../components/ErrorState";
import { ForwardActions, forwardState, useCloseForward } from "./ForwardActions";
import { useK8sForwards } from "./forwards";
import { forwardAddress } from "./streams";
import { targetKey } from "./targets";
import { FORWARDS_EMPTY, H_FORWARD_LOCAL, H_FORWARD_POD, H_FORWARD_STATE, H_FORWARD_TARGET, LOADING, NAV_FORWARDS, forwardTarget } from "./text";
import type { K8sTarget } from "./types";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
}

/** 이 클러스터에서 열린 port-forward 목록. 브라우저로 열고, 주소를 복사하고, 끝낸다. */
export function ForwardsView({ target, ssoProfile }: Props) {
  const forwards = useK8sForwards(true);
  const { close, error: closeError, clearError } = useCloseForward();
  const mine = (forwards.data ?? []).filter((f) => targetKey(f.target) === targetKey(target));

  if (forwards.isError) return <ErrorState error={forwards.error} profile={ssoProfile} compact onRetry={() => void forwards.refetch()} />;
  if (!forwards.data) return <div className="empty">{LOADING}</div>;
  return (
    <div className="k8s-forwards">
      {closeError !== null && <ErrorState error={closeError} profile={ssoProfile} compact onRetry={clearError} />}
      {mine.length === 0 ? (
        <div className="empty">{FORWARDS_EMPTY}</div>
      ) : (
        <table className="k8s-table" aria-label={NAV_FORWARDS}>
          <thead>
            <tr><th>{H_FORWARD_TARGET}</th><th>{H_FORWARD_LOCAL}</th><th>{H_FORWARD_POD}</th><th>{H_FORWARD_STATE}</th><th /></tr>
          </thead>
          <tbody>
            {mine.map((f) => (
              <tr key={f.id} className={f.error || f.pod === null ? "k8s-warn" : undefined}>
                <td className="mono">{forwardTarget(f)}</td>
                <td className="mono">{forwardAddress(f)}</td>
                <td className="mono">{f.pod ?? ""}</td>
                <td>{forwardState(f)}</td>
                <td className="k8s-actions">
                  <ForwardActions forward={f} onClose={(id) => void close(id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
