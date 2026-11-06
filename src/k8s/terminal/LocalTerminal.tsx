import { useRef } from "react";
import { ErrorState } from "../../components/ErrorState";
import { shellExited } from "../text";
import type { K8sTarget } from "../types";
import { terminalApi } from "./api";
import { TERMINAL_CLOSE_TAB, TERMINAL_OPENING, TERMINAL_RESTART } from "./text";
import { useXterm } from "./useXterm";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  /** 확인을 거친 플러그인 명령. null이면 로그인 셸 */
  command: string | null;
  launch?: { claimed: boolean };
  /** 탭 이름(접근성 이름) */
  title: string;
  /** 보이는 동안만 크기를 맞추고 입력을 받는다(숨겨도 세션은 유지된다) */
  visible: boolean;
  onClose: () => void;
}

/**
 * 이 탭의 클러스터에 고정된 로컬 셸(또는 플러그인 명령) 하나를 xterm.js로 보여 준다. 마운트될 때 열고 사라질 때 닫는다.
 * 키 입력과 크기 변경은 백엔드로 보내고, 출력은 채널로 받아 그린다. 입력·출력은 어디에도 남기지 않는다.
 */
export function LocalTerminal({ target, ssoProfile, command, launch, title, visible, onClose }: Props) {
  const localLaunch = useRef({ claimed: false });
  const { wrap, host, state, restart } = useXterm(
    visible, ssoProfile,
    (cols, rows, onMessage) => terminalApi.open(target, command, cols, rows, ssoProfile, onMessage),
    command === null ? undefined : (launch ?? localLaunch.current),
  );

  return (
    <div ref={wrap} className="k8s-shell-wrap">
      {state.phase === "error" && <ErrorState error={state.error} profile={ssoProfile} compact onRetry={restart} onLoggedIn={restart} />}
      <div className="k8s-term-box">
        <div ref={host} className="k8s-term" aria-label={title} />
        {state.phase === "opening" && <p className="dim k8s-hint k8s-term-note">{TERMINAL_OPENING}</p>}
        {state.phase === "ended" && (
          <div className="k8s-term-over">
            <p>{shellExited(state.code, state.reason)}</p>
            {/* 플러그인 명령은 확인을 거쳐 한 번 실행한 것이라 같은 명령을 다시 돌리지 않는다 */}
            {command === null ? (
              <button className="btn tone-refresh" onClick={restart}>{TERMINAL_RESTART}</button>
            ) : (
              <button className="btn tone-ghost-danger" onClick={onClose}>{TERMINAL_CLOSE_TAB}</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
