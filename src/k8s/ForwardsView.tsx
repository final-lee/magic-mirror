import { useRef } from "react";
import { ErrorState } from "../components/ErrorState";
import { ListFind, useListFind } from "../components/ListFind";
import { vimTableKeys } from "../iam/ListTable";
import { fuzzyKeep } from "../lib/fuzzy";
import { ForwardActions, forwardState, useCloseForward } from "./ForwardActions";
import { useK8sForwards } from "./forwards";
import { forwardAddress } from "./streams";
import { targetKey } from "./targets";
import { FORWARDS_EMPTY, H_FORWARD_LOCAL, H_FORWARD_POD, H_FORWARD_STATE, H_FORWARD_TARGET, LIST_NO_MATCH, LOADING, NAV_FORWARDS, forwardTarget } from "./text";
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
  // ⌘F: 이 포워드 목록 안에서만 찾는다. 평소에는 찾기 줄이 없다
  const box = useRef<HTMLDivElement>(null);
  const find = useListFind(box);
  const listed = fuzzyKeep(mine, find.query, (f) => [forwardTarget(f), forwardAddress(f), f.pod, forwardState(f)]);

  if (forwards.isError) return <ErrorState error={forwards.error} profile={ssoProfile} compact onRetry={() => void forwards.refetch()} />;
  if (!forwards.data) return <div className="empty">{LOADING}</div>;
  return (
    <div className="k8s-forwards" ref={box}>
      <ListFind find={find} count={listed.length} />
      {closeError !== null && <ErrorState error={closeError} profile={ssoProfile} compact onRetry={clearError} />}
      {listed.length === 0 ? (
        <div className="empty">{mine.length === 0 ? FORWARDS_EMPTY : LIST_NO_MATCH}</div>
      ) : (
        <table className="k8s-table k8s-vim-rows" aria-label={NAV_FORWARDS} tabIndex={0} onKeyDown={vimTableKeys}>
          <thead>
            <tr><th>{H_FORWARD_TARGET}</th><th>{H_FORWARD_LOCAL}</th><th>{H_FORWARD_POD}</th><th>{H_FORWARD_STATE}</th><th /></tr>
          </thead>
          <tbody>
            {listed.map((f) => (
              <tr key={f.id} tabIndex={-1} className={f.error || f.pod === null ? "k8s-warn" : undefined}>
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
