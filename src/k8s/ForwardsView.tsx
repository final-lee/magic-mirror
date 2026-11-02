import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { desktop } from "../api/desktop";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { FORWARDS_KEY, useK8sForwards } from "./forwards";
import { forwardAddress, forwardUrl } from "./streams";
import { targetKey } from "./targets";
import {
  COPIED, FORWARD_CLOSE, FORWARD_COPY_URL, FORWARD_HEALTHY, FORWARD_NO_POD, FORWARD_OPEN_BROWSER, FORWARDS_EMPTY, H_FORWARD_LOCAL, H_FORWARD_POD,
  H_FORWARD_STATE, H_FORWARD_TARGET, LOADING, NAV_FORWARDS, forwardTarget,
} from "./text";
import type { K8sTarget } from "./types";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
}

/** 이 클러스터에서 열린 port-forward 목록. 브라우저로 열고, 주소를 복사하고, 닫는다. */
export function ForwardsView({ target, ssoProfile }: Props) {
  const qc = useQueryClient();
  const forwards = useK8sForwards(true);
  const [copied, setCopied] = useState<number | null>(null);
  const [closeError, setCloseError] = useState<unknown>(null);
  const mine = (forwards.data ?? []).filter((f) => targetKey(f.target) === targetKey(target));

  const close = async (id: number) => {
    setCloseError(null);
    try {
      await k8sApi.forwardClose(id);
    } catch (e) {
      setCloseError(e);
    }
    void qc.invalidateQueries({ queryKey: FORWARDS_KEY });
  };

  if (forwards.isError) return <ErrorState error={forwards.error} profile={ssoProfile} compact onRetry={() => void forwards.refetch()} />;
  if (!forwards.data) return <div className="empty">{LOADING}</div>;
  return (
    <div className="k8s-forwards">
      {closeError !== null && <ErrorState error={closeError} profile={ssoProfile} compact onRetry={() => setCloseError(null)} />}
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
                <td>{f.pod === null ? FORWARD_NO_POD : (f.error ?? FORWARD_HEALTHY)}</td>
                <td className="k8s-actions">
                  <button className="btn" onClick={() => void desktop.openUrl(forwardUrl(f))}>
                    {FORWARD_OPEN_BROWSER}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      void desktop.copy(forwardUrl(f));
                      setCopied(f.id);
                    }}
                  >
                    {copied === f.id ? COPIED : FORWARD_COPY_URL}
                  </button>
                  <button className="btn" onClick={() => void close(f.id)}>
                    {FORWARD_CLOSE}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
