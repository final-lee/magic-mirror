import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../api/invoke";
import type { K8sContextInfo, K8sKindRef, K8sRules, K8sSession, K8sTarget, K8sWatchMessage } from "./types";

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
  unwatch: (watchId: number) => invoke<null>("k8s_unwatch", { watchId }),
};
