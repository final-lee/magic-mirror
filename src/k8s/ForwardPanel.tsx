import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { desktop } from "../api/desktop";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { FORWARDS_KEY } from "./forwards";
import { forwardAddress, forwardUrl, parsePort, streamPermission } from "./streams";
import {
  COPIED, COPY, FORWARD_BAD_PORT, FORWARD_CUSTOM, FORWARD_LOCAL, FORWARD_LOCAL_AUTO, FORWARD_NO_PORTS, FORWARD_OPEN, FORWARD_OPEN_BROWSER, FORWARD_PORT,
  FORWARD_START, forwardOpened, forwardPortLabel,
} from "./text";
import type { K8sForward, K8sForwardKind, K8sPort, K8sRules, K8sTarget } from "./types";

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

/** Pod나 Service 상세의 port-forward 버튼과 포트 고르기 */
export function ForwardPanel({ target, ssoProfile, namespace, kind, name, ports, rules }: Props) {
  const qc = useQueryClient();
  const perm = streamPermission(rules, "portforward", kind === "pod" ? name : undefined);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>(ports.length > 0 ? String(ports[0].port) : CUSTOM);
  const [custom, setCustom] = useState("");
  const [local, setLocal] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [opened, setOpened] = useState<K8sForward | null>(null);
  const [copied, setCopied] = useState(false);

  const start = async () => {
    const remote = selected === CUSTOM ? parsePort(custom) : Number(selected);
    const localPort = local.trim() === "" ? null : parsePort(local);
    if (remote === null || (local.trim() !== "" && localPort === null)) {
      setProblem(FORWARD_BAD_PORT);
      return;
    }
    setProblem(null);
    setError(null);
    setOpened(null);
    setBusy(true);
    try {
      const f = await k8sApi.forwardOpen(target, { namespace, kind, name, remotePort: remote, localPort }, ssoProfile);
      setOpened(f);
      void qc.invalidateQueries({ queryKey: FORWARDS_KEY });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="btn small tone-primary" disabled={!perm.allowed} title={perm.reason ?? undefined} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {FORWARD_START}
      </button>
      {open && perm.allowed && (
        <div className="k8s-forward-panel">
          {ports.length === 0 && <p className="dim k8s-hint">{FORWARD_NO_PORTS}</p>}
          <label className="k8s-field">
            {FORWARD_PORT}
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {ports.map((p) => (
                <option key={`${p.container ?? ""}/${p.port}`} value={String(p.port)}>
                  {forwardPortLabel(p)}
                </option>
              ))}
              <option value={CUSTOM}>{FORWARD_CUSTOM}</option>
            </select>
          </label>
          {selected === CUSTOM && <input aria-label={FORWARD_CUSTOM} inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value)} />}
          <label className="k8s-field">
            {FORWARD_LOCAL}
            <input inputMode="numeric" placeholder={FORWARD_LOCAL_AUTO} value={local} onChange={(e) => setLocal(e.target.value)} />
          </label>
          <div className="k8s-actions">
            <button className="btn tone-primary" disabled={busy} onClick={() => void start()}>
              {FORWARD_OPEN}
            </button>
          </div>
          {problem && <p className="err">{problem}</p>}
          {error !== null && <ErrorState error={error} profile={ssoProfile} compact onRetry={() => void start()} onLoggedIn={() => void start()} />}
          {opened && (
            <div role="status" className="k8s-forward-done">
              <span className="mono">{forwardOpened(forwardAddress(opened))}</span>
              <button className="btn tone-secondary" onClick={() => void desktop.openUrl(forwardUrl(opened))}>
                {FORWARD_OPEN_BROWSER}
              </button>
              <button
                className="btn tone-secondary"
                onClick={() => {
                  void desktop.copy(forwardUrl(opened));
                  setCopied(true);
                }}
              >
                {copied ? COPIED : COPY}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
