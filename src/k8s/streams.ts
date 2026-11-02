import { can } from "./can";
import { noStreamPermission, SHELL_PERMISSION_CHECKING } from "./text";
import type { K8sForward, K8sRules } from "./types";

export type StreamResource = "exec" | "attach" | "portforward";

export interface StreamPermission {
  allowed: boolean;
  /** 허용하지 않을 때만 */
  reason: string | null;
}

/**
 * pods/exec, pods/attach, pods/portforward 만들기 권한. 규칙을 아직 못 읽었으면 허용하지 않고 이유를 보인다.
 * 규칙 목록이 불완전해서 알 수 없는 경우(unknown)는 막지 않는다(서버가 가린다).
 */
export function streamPermission(rules: K8sRules | undefined, sub: StreamResource, podName?: string): StreamPermission {
  if (!rules) return { allowed: false, reason: SHELL_PERMISSION_CHECKING };
  const verdict = can(rules, { verb: "create", group: "", resource: "pods", subresource: sub, name: podName });
  return verdict === "no" ? { allowed: false, reason: noStreamPermission(`pods/${sub}`) } : { allowed: true, reason: null };
}

/** 로컬로 열린 주소 */
export const forwardAddress = (f: Pick<K8sForward, "localPort">) => `127.0.0.1:${f.localPort}`;
export const forwardUrl = (f: Pick<K8sForward, "localPort">) => `http://${forwardAddress(f)}`;

/** 입력한 포트 문자열 → 1~65535의 정수, 아니면 null */
export function parsePort(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : null;
}
