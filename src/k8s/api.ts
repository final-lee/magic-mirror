import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../api/invoke";
import type {
  K8sApplyResult, K8sChange, K8sChangeLogEntry, K8sChangeObject, K8sContextInfo, K8sKind, K8sKindRef, K8sLogMessage, K8sLogOptions, K8sObjectView, K8sOverview, K8sPreview, K8sRevision, K8sSecretValue, K8sRules, K8sSession, K8sTarget, K8sUndo, K8sWatchMessage,
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
  changeLog: () => invoke<K8sChangeLogEntry[]>("k8s_change_log"),
  undo: (logId: string) => invoke<K8sUndo>("k8s_undo", { logId }),
};
