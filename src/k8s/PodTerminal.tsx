import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { useXterm } from "./terminal/useXterm";
import { ATTACH_OUTPUT_ONLY, SHELL_OPENING, SHELL_REOPEN, SHELL_LABEL, shellExited } from "./text";
import type { K8sShellMode, K8sTarget } from "./types";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  namespace: string;
  pod: string;
  container: string;
  mode: K8sShellMode;
  /** 위험한 대상에서 입력한 이름(필요 없으면 null). 노드 셸은 쓰지 않는다 */
  confirmText: string | null;
  /** 보이는 동안만 크기를 맞추고 입력을 받는다(숨겨도 세션은 유지된다) */
  visible: boolean;
}

/**
 * 셸(exec)이나 attach 세션 하나를 xterm.js로 보여 준다. 마운트될 때 열고 사라질 때 닫는다.
 * 키 입력과 크기 변경은 백엔드로 보내고, 출력은 채널로 받아 그린다. 입력·출력은 어디에도 남기지 않는다.
 */
export function PodTerminal({ target, ssoProfile, namespace, pod, container, mode, confirmText, visible }: Props) {
  const { wrap, host, state, restart } = useXterm(visible, ssoProfile, (_cols, _rows, onMessage) =>
    mode === "node"
      ? k8sApi.nodeShellOpen(target, namespace, pod, ssoProfile, onMessage)
      : (mode === "attach" ? k8sApi.attachOpen : k8sApi.shellOpen)(target, namespace, pod, container, confirmText, ssoProfile, onMessage),
  );

  return (
    <div ref={wrap} className="k8s-shell-wrap" aria-label={SHELL_LABEL}>
      {state.phase === "error" && <ErrorState error={state.error} profile={ssoProfile} compact onRetry={restart} onLoggedIn={restart} />}
      {state.phase === "running" && mode === "attach" && !state.input && <p className="dim k8s-hint">{ATTACH_OUTPUT_ONLY}</p>}
      <div className="k8s-term-box">
        <div ref={host} className="k8s-term" aria-label={pod} />
        {state.phase === "opening" && <p className="dim k8s-hint k8s-term-note">{SHELL_OPENING}</p>}
        {state.phase === "ended" && (
          <div className="k8s-term-over">
            <p>{shellExited(state.code, state.reason)}</p>
            {/* 노드 셸 Pod는 세션이 끝나면 지워지니 같은 Pod로 다시 열 수 없다 */}
            {mode !== "node" && (
              <button className="btn tone-refresh" onClick={restart}>
                {SHELL_REOPEN}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
