import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../api/invoke";
import type {
  K8sApplyResult, K8sChange, K8sChangeLogEntry, K8sChangeObject, K8sContextInfo, K8sDrainMessage, K8sForward, K8sForwardRequest, K8sKind, K8sKindRef, K8sLogMessage, K8sLogOptions,
  K8sObjectView, K8sOverview, K8sPreview, K8sRevision, K8sSecretValue, K8sRules, K8sSession, K8sShellMessage, K8sShellOpened, K8sTarget, K8sUndo, K8sWatchMessage,
} from "./types";

// 명령 이름과 인자 이름은 K1 계획의 Contract와 같아야 한다. target은 객체 하나로 넘긴다.
// k8s_context를 뺀 명령은 최상위 profile에 exec 플러그인의 프로필을 넣는다: invoke가 SSO 만료를 그 프로필로 알린다(src/api/invoke.ts).
export const k8sApi = {
  context: (target: K8sTarget, kubeconfig: string | null, saved: string | null) =>
    invoke<K8sContextInfo>("k8s_context", { target, kubeconfig, saved }),
  open: (target: K8sTarget, kubeconfig: string | null, context: string, ssoProfile: string) =>
    invoke<K8sSession>("k8s_open", { target, kubeconfig, context, profile: ssoProfile }),
  close: (target: K8sTarget, ssoProfile: string) => invoke<null>("k8s_close", { target, profile: ssoProfile }),
  rules: (target: K8sTarget, namespace: string, ssoProfile: string) =>
    invoke<K8sRules>("k8s_rules", { target, namespace, profile: ssoProfile }),
  watch: (target: K8sTarget, kind: K8sKindRef, namespace: string | null, ssoProfile: string, onMessage: (m: K8sWatchMessage) => void) => {
    const onEvent = new Channel<K8sWatchMessage>();
    onEvent.onmessage = onMessage;
    return invoke<number>("k8s_watch", { target, kind, namespace, onEvent, profile: ssoProfile });
  },
  /** watch와 로그 흐름을 멈춘다 */
  unwatch: (watchId: number) => invoke<null>("k8s_unwatch", { watchId }),
  /** Pod 컨테이너 로그. 반환값은 unwatch에 넘기는 번호 */
  logs: (target: K8sTarget, namespace: string, pod: string, options: K8sLogOptions, ssoProfile: string, onMessage: (m: K8sLogMessage) => void) => {
    const onEvent = new Channel<K8sLogMessage>();
    onEvent.onmessage = onMessage;
    return invoke<number>("k8s_logs", { target, namespace, pod, options, onEvent, profile: ssoProfile });
  },
  /** Pod 셸(exec). 위험한 네임스페이스는 confirmText가 Pod 이름과 같아야 한다. 출력은 채널로 오고, 반환값의 id로 입력·크기·닫기를 한다 */
  shellOpen: (target: K8sTarget, namespace: string, pod: string, container: string, confirmText: string | null, ssoProfile: string, onMessage: (m: K8sShellMessage) => void) => {
    const onEvent = new Channel<K8sShellMessage>();
    onEvent.onmessage = onMessage;
    return invoke<K8sShellOpened>("k8s_shell_open", { target, namespace, pod, container, confirmText, onEvent, profile: ssoProfile });
  },
  /** 컨테이너의 주 프로세스에 attach. 셸과 같은 채널·명령으로 다룬다 */
  attachOpen: (target: K8sTarget, namespace: string, pod: string, container: string, confirmText: string | null, ssoProfile: string, onMessage: (m: K8sShellMessage) => void) => {
    const onEvent = new Channel<K8sShellMessage>();
    onEvent.onmessage = onMessage;
    return invoke<K8sShellOpened>("k8s_attach_open", { target, namespace, pod, container, confirmText, onEvent, profile: ssoProfile });
  },
  /** 셸·attach를 열 때 입력해야 하는 이름. 위험하지 않으면 null(규칙은 백엔드 change::dangerous 하나) */
  shellConfirmName: (namespace: string, pod: string) => invoke<string | null>("k8s_shell_confirm_name", { namespace, pod }),
  /** 변경 틀로 만든 노드 셸 Pod가 준비되면 노드로 들어가는 셸을 연다. 닫으면 Pod를 지운다 */
  nodeShellOpen: (target: K8sTarget, namespace: string, pod: string, ssoProfile: string, onMessage: (m: K8sShellMessage) => void) => {
    const onEvent = new Channel<K8sShellMessage>();
    onEvent.onmessage = onMessage;
    return invoke<K8sShellOpened>("k8s_node_shell_open", { target, namespace, pod, onEvent, profile: ssoProfile });
  },
  shellInput: (shellId: number, data: string) => invoke<null>("k8s_shell_input", { shellId, data }),
  shellResize: (shellId: number, cols: number, rows: number) => invoke<null>("k8s_shell_resize", { shellId, cols, rows }),
  shellClose: (shellId: number) => invoke<null>("k8s_shell_close", { shellId }),
  forwardOpen: (target: K8sTarget, request: K8sForwardRequest, ssoProfile: string) => invoke<K8sForward>("k8s_forward_open", { target, request, profile: ssoProfile }),
  /** 모든 탭의 열린 port-forward */
  forwardList: () => invoke<K8sForward[]>("k8s_forward_list", {}),
  forwardClose: (id: number) => invoke<null>("k8s_forward_close", { id }),
  kinds: (target: K8sTarget, ssoProfile: string) => invoke<K8sKind[]>("k8s_kinds", { target, profile: ssoProfile }),
  get: (target: K8sTarget, kind: K8sKindRef, namespace: string | null, name: string, ssoProfile: string) =>
    invoke<K8sObjectView>("k8s_get", { target, kind, namespace, name, profile: ssoProfile }),
  /** Secret 키 하나의 값. 부른 쪽이 컴포넌트 상태에만 둔다(쿼리 캐시에 넣지 않는다) */
  secretValue: (target: K8sTarget, namespace: string, name: string, key: string, ssoProfile: string) =>
    invoke<K8sSecretValue>("k8s_secret_value", { target, namespace, name, key, profile: ssoProfile }),
  /** 개요가 던지는 오류는 앱 프로필의 AWS 설정에서만 나온다(쿠버네티스 쪽 실패는 gaps에 담긴다) */
  overview: (target: K8sTarget) => invoke<K8sOverview>("k8s_overview", { target, profile: target.profile }),
  revisions: (target: K8sTarget, object: K8sChangeObject, ssoProfile: string) =>
    invoke<K8sRevision[]>("k8s_revisions", { target, object, profile: ssoProfile }),
  preview: (target: K8sTarget, change: K8sChange, ssoProfile: string) =>
    invoke<K8sPreview>("k8s_preview", { target, change, profile: ssoProfile }),
  apply: (target: K8sTarget, change: K8sChange, confirmText: string | null, undoOf: string | null, ssoProfile: string) =>
    invoke<K8sApplyResult>("k8s_apply", { target, change, confirmText, undoOf, profile: ssoProfile }),
  /** 미리보기한 drain을 적용한다. 진행은 채널로 오고 반환값은 `unwatch`(중단)에 넘기는 번호 */
  drain: (target: K8sTarget, node: string, confirmText: string | null, ssoProfile: string, onMessage: (m: K8sDrainMessage) => void) => {
    const onEvent = new Channel<K8sDrainMessage>();
    onEvent.onmessage = onMessage;
    return invoke<number>("k8s_drain", { target, node, confirmText, onEvent, profile: ssoProfile });
  },
  changeLog: () => invoke<K8sChangeLogEntry[]>("k8s_change_log"),
  undo: (logId: string) => invoke<K8sUndo>("k8s_undo", { logId }),
};
