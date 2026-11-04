import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { FORWARDS_KEY } from "./forwards";
import { parsePort, streamPermission } from "./streams";
import {
  FORWARD_BAD_PORT, FORWARD_CUSTOM, FORWARD_LOCAL, FORWARD_LOCAL_AUTO, FORWARD_NO_PORTS, FORWARD_OPEN, FORWARD_OPEN_SHORT, FORWARD_PORT, FORWARD_START, forwardPortLabel,
} from "./text";
import type { K8sForwardKind, K8sPort, K8sRules, K8sTarget } from "./types";

const CUSTOM = "custom";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  namespace: string;
  kind: K8sForwardKind;
  name: string;
  ports: K8sPort[];
  /** 이 네임스페이스의 내 권한. 아직 못 읽었으면 undefined */
  rules: K8sRules | undefined;
}

/** Pod나 Service 상세의 포트포워딩 열기 줄: 대상 포트·로컬 포트·[열기]가 한 줄. 연 포트포워딩은 그 아래 줄들에 보인다. */
export function ForwardPanel({ target, ssoProfile, namespace, kind, name, ports, rules }: Props) {
  const qc = useQueryClient();
  const perm = streamPermission(rules, "portforward", kind === "pod" ? name : undefined);
  const [selected, setSelected] = useState<string>(ports.length > 0 ? String(ports[0].port) : CUSTOM);
  const [custom, setCustom] = useState("");
  const [local, setLocal] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const start = async () => {
    const remote = selected === CUSTOM ? parsePort(custom) : Number(selected);
    const localPort = local.trim() === "" ? null : parsePort(local);
    if (remote === null || (local.trim() !== "" && localPort === null)) {
      setProblem(FORWARD_BAD_PORT);
      return;
    }
    setProblem(null);
    setError(null);
    setBusy(true);
    try {
      await k8sApi.forwardOpen(target, { namespace, kind, name, remotePort: remote, localPort }, ssoProfile);
      setLocal("");
      void qc.invalidateQueries({ queryKey: FORWARDS_KEY });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="k8s-forward-form">
        <span className="k8s-forward-title">{FORWARD_START}</span>
        <label>
          {FORWARD_PORT}
          <select data-k8s-action="forward" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {ports.map((p) => (
              <option key={`${p.container ?? ""}/${p.port}`} value={String(p.port)}>
                {forwardPortLabel(p)}
              </option>
            ))}
            <option value={CUSTOM}>{FORWARD_CUSTOM}</option>
          </select>
        </label>
        {selected === CUSTOM && (
          <input
            className="k8s-port-input"
            aria-label={FORWARD_CUSTOM}
            title={ports.length === 0 ? FORWARD_NO_PORTS : undefined}
            inputMode="numeric"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        )}
        <label>
          {FORWARD_LOCAL}
          <input className="k8s-port-input" inputMode="numeric" placeholder={FORWARD_LOCAL_AUTO} value={local} onChange={(e) => setLocal(e.target.value)} />
        </label>
        <button className="btn tone-primary" aria-label={FORWARD_OPEN} disabled={!perm.allowed || busy} title={perm.reason ?? undefined} onClick={() => void start()}>
          {FORWARD_OPEN_SHORT}
        </button>
      </div>
      {problem && <p className="err">{problem}</p>}
      {error !== null && <ErrorState error={error} profile={ssoProfile} compact onRetry={() => void start()} onLoggedIn={() => void start()} />}
    </>
  );
}
