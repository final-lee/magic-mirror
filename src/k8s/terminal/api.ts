import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../../api/invoke";
import type { K8sShellMessage, K8sShellOpened, K8sTarget } from "../types";

// 입력·크기·닫기는 셸 세션과 같은 명령(k8sApi.shellInput·shellResize·shellClose)을 쓴다.
export const terminalApi = {
  /**
   * 이 탭의 클러스터에 고정된 로컬 터미널을 연다. command가 null이면 로그인 셸, 있으면(확인을 거친 플러그인 명령) 그 명령을 실행한다.
   * 출력은 채널로 오고 반환값의 id로 입력·크기·닫기를 한다.
   */
  open: (target: K8sTarget, command: string | null, cols: number, rows: number, ssoProfile: string, onMessage: (m: K8sShellMessage) => void) => {
    const onEvent = new Channel<K8sShellMessage>();
    onEvent.onmessage = onMessage;
    return invoke<K8sShellOpened>("k8s_terminal_open", { target, command, cols, rows, onEvent, profile: ssoProfile });
  },
};
