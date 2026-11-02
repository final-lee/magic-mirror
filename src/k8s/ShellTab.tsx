import { useState } from "react";
import { errorMessage } from "../api/errors";
import { k8sApi } from "./api";
import { PodTerminal } from "./PodTerminal";
import { streamPermission } from "./streams";
import {
  ATTACH_WARNING, LOG_CONTAINER, SHELL_CANCEL, SHELL_CLOSE, SHELL_CONFIRM, SHELL_MODE_ATTACH, SHELL_MODE_EXEC, SHELL_MODE_LABEL, SHELL_NO_CONTAINER,
  SHELL_CHECKING_NAME, SHELL_OPEN, SHELL_TYPED_LABEL, shellConfirmTitle, shellTypedHint,
} from "./text";
import type { K8sContainer, K8sRules, K8sShellMode, K8sTarget } from "./types";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  namespace: string;
  pod: string;
  /** 초기화 컨테이너를 뺀 목록 */
  containers: K8sContainer[];
  /** 이 네임스페이스의 내 권한. 아직 못 읽었으면 undefined */
  rules: K8sRules | undefined;
  /** 이 탭이 보이는지(숨겨도 열린 세션은 유지된다) */
  visible: boolean;
}

interface Session {
  container: string;
  mode: K8sShellMode;
  confirmText: string | null;
}

/**
 * Pod 상세의 셸 탭. 컨테이너와 방식(셸, attach)을 고르고, 확인(위험한 네임스페이스는 Pod 이름 입력)을 거쳐 터미널을 연다.
 * 세션은 탭을 바꿔도 유지되고, Pod 상세를 닫거나 세션을 닫을 때 끊는다.
 */
export function ShellTab({ target, ssoProfile, namespace, pod, containers, rules, visible }: Props) {
  const [container, setContainer] = useState<string>("");
  const [mode, setMode] = useState<K8sShellMode>("exec");
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [nonce, setNonce] = useState(0);
  const chosen = containers.some((c) => c.name === container) ? container : (containers[0]?.name ?? "");
  const perm = streamPermission(rules, mode === "attach" ? "attach" : "exec", pod);
  // 입력해야 하는 이름은 백엔드의 위험 판단(변경 공통 틀과 같은 규칙) 하나에서 온다. undefined: 아직 모름, null: 필요 없음
  const [required, setRequired] = useState<string | null | undefined>(undefined);
  const [checkError, setCheckError] = useState("");

  const ask = () => {
    setConfirming(true);
    setRequired(undefined);
    setCheckError("");
    k8sApi.shellConfirmName(namespace, pod).then(setRequired, (e: unknown) => setCheckError(errorMessage(e)));
  };
  const close = () => {
    setConfirming(false);
    setTyped("");
  };
  const confirm = () => {
    setSession({ container: chosen, mode, confirmText: required ? typed : null });
    setNonce((n) => n + 1);
    close();
  };

  return (
    <div className="k8s-shell">
      {session === null && (
        <div className="k8s-shell-form">
          {containers.length === 0 ? (
            <p className="dim">{SHELL_NO_CONTAINER}</p>
          ) : (
            <>
              <label className="k8s-field">
                {LOG_CONTAINER}
                <select value={chosen} onChange={(e) => setContainer(e.target.value)}>
                  {containers.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <div role="radiogroup" aria-label={SHELL_MODE_LABEL} className="k8s-field">
                {SHELL_MODE_LABEL}
                <label className="k8s-check">
                  <input type="radio" name="shell-mode" checked={mode === "exec"} onChange={() => setMode("exec")} />
                  {SHELL_MODE_EXEC}
                </label>
                <label className="k8s-check">
                  <input type="radio" name="shell-mode" checked={mode === "attach"} onChange={() => setMode("attach")} />
                  {SHELL_MODE_ATTACH}
                </label>
              </div>
              <div className="k8s-actions">
                <button className="btn" disabled={!perm.allowed} title={perm.reason ?? undefined} onClick={ask}>
                  {SHELL_OPEN}
                </button>
              </div>
              {perm.reason && <p className="dim k8s-hint">{perm.reason}</p>}
            </>
          )}
        </div>
      )}
      {confirming && (
        <div className="k8s-confirm" role="dialog" aria-label={shellConfirmTitle(pod, chosen)}>
          <p>{shellConfirmTitle(pod, chosen)}</p>
          {mode === "attach" && <p className="err">{ATTACH_WARNING}</p>}
          {required === undefined && !checkError && <p className="dim k8s-hint">{SHELL_CHECKING_NAME}</p>}
          {checkError && <p className="err">{checkError}</p>}
          {required && (
            <label className="k8s-field">
              <span>{shellTypedHint(required)}</span>
              <input aria-label={SHELL_TYPED_LABEL} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </label>
          )}
          <div className="k8s-actions">
            <button className="btn" disabled={required === undefined || (required !== null && typed !== required)} onClick={confirm}>
              {SHELL_CONFIRM}
            </button>
            <button className="btn" onClick={close}>
              {SHELL_CANCEL}
            </button>
          </div>
        </div>
      )}
      {session !== null && (
        <>
          <div className="k8s-shell-bar">
            <span className="mono">
              {session.container} · {session.mode === "attach" ? SHELL_MODE_ATTACH : SHELL_MODE_EXEC}
            </span>
            <button className="btn k8s-push" onClick={() => setSession(null)}>
              {SHELL_CLOSE}
            </button>
          </div>
          {session.mode === "attach" && <p className="err k8s-hint">{ATTACH_WARNING}</p>}
          <PodTerminal
            key={nonce}
            target={target}
            ssoProfile={ssoProfile}
            namespace={namespace}
            pod={pod}
            container={session.container}
            mode={session.mode}
            confirmText={session.confirmText}
            visible={visible}
          />
        </>
      )}
    </div>
  );
}
