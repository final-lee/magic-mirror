import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { desktop } from "../api/desktop";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { FORWARDS_KEY, useK8sForwards } from "./forwards";
import { forwardAddress, forwardUrl } from "./streams";
import { targetKey } from "./targets";
import { COPIED, FORWARD_CLOSE, FORWARD_COPY_URL, FORWARD_HEALTHY, FORWARD_NO_POD, FORWARD_OPEN_BROWSER, FORWARDS_HERE, forwardPod, forwardTarget } from "./text";
import type { K8sForward, K8sForwardKind, K8sTarget } from "./types";

/** port-forward를 끝낸다. 끝낸 뒤(실패해도) 열린 목록을 다시 읽는다. */
export function useCloseForward() {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const close = async (id: number) => {
    setError(null);
    try {
      await k8sApi.forwardClose(id);
    } catch (e) {
      setError(e);
    }
    void qc.invalidateQueries({ queryKey: FORWARDS_KEY });
  };
  return { close, error, clearError: () => setError(null) };
}

/** 열린 port-forward 하나의 상태 글: 붙은 Pod가 없거나 최근 실패가 있으면 그 사유 */
export const forwardState = (f: K8sForward) => (f.pod === null ? FORWARD_NO_POD : (f.error ?? FORWARD_HEALTHY));

/** 열린 port-forward 하나에 대한 버튼: 브라우저로 열기, 주소 복사, 종료 */
export function ForwardActions({ forward, onClose }: { forward: K8sForward; onClose: (id: number) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button className="btn small tone-nav" onClick={() => void desktop.openUrl(forwardUrl(forward))}>
        {FORWARD_OPEN_BROWSER}
      </button>
      <button
        className="btn small tone-secondary"
        onClick={() => {
          void desktop.copy(forwardUrl(forward));
          setCopied(true);
        }}
      >
        {copied ? COPIED : FORWARD_COPY_URL}
      </button>
      <button className="btn small tone-ghost-danger" onClick={() => onClose(forward.id)}>
        {FORWARD_CLOSE}
      </button>
    </>
  );
}

interface ObjectForwardsProps {
  target: K8sTarget;
  ssoProfile: string;
  namespace: string;
  kind: K8sForwardKind;
  name: string;
  live: boolean;
  /** 맨 위에 놓을 포트포워딩 열기 줄. 있으면 열린 것이 없어도 영역을 그린다 */
  children?: ReactNode;
}

/**
 * Pod·Service 상세의 포트포워딩 영역: 열기 줄과 이 객체의 열린 port-forward. Pod 상세에는 지금 이 Pod로 이어진 Service 포워드도 함께 보인다.
 * 열기 줄도 열린 것도 없으면 아무것도 그리지 않는다.
 */
export function ObjectForwards({ target, ssoProfile, namespace, kind, name, live, children }: ObjectForwardsProps) {
  const forwards = useK8sForwards(live);
  const { close, error, clearError } = useCloseForward();
  const here = (forwards.data ?? []).filter(
    (f) => targetKey(f.target) === targetKey(target) && f.namespace === namespace && ((f.kind === kind && f.name === name) || (kind === "pod" && f.pod === name)),
  );
  if (here.length === 0 && error === null && !children) return null;
  return (
    <div className="k8s-obj-forwards" role="region" aria-label={FORWARDS_HERE}>
      {children}
      {error !== null && <ErrorState error={error} profile={ssoProfile} compact onRetry={clearError} />}
      {here.map((f) => (
        <div key={f.id} className={`k8s-obj-forward${f.error || f.pod === null ? " k8s-warn" : ""}`}>
          <span aria-hidden="true">🔌</span>
          <span className="mono">{forwardAddress(f)}</span>
          <span className="dim">→</span>
          <span className="mono">{forwardTarget(f)}</span>
          {f.kind === "service" && f.pod && <span className="dim">{forwardPod(f.pod)}</span>}
          <span className={f.error || f.pod === null ? "err" : "dim"}>{forwardState(f)}</span>
          <span className="k8s-obj-forward-acts">
            <ForwardActions forward={f} onClose={(id) => void close(id)} />
          </span>
        </div>
      ))}
    </div>
  );
}
