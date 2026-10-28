import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { isAppError } from "./errors";

/** startedAt은 실패한 명령을 부른 시각이다. 로그인 관리자가 로그인 전에 시작한 호출의 낡은 보고를 가려내는 데 쓴다. */
type Listener = (profile: string, startedAt: number) => void;
const listeners = new Set<Listener>();

/** SSO 세션 만료로 실패한 명령의 프로필을 받는다. 로그인 관리자가 구독한다. */
export function onSsoExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 이 프로필의 SSO 세션이 만료됐다고 알린다. startedAt은 그 명령을 부른 시각이다(모르면 지금). */
export function reportSsoExpired(profile: string, startedAt = Date.now()) {
  for (const listener of [...listeners]) {
    try {
      listener(profile, startedAt);
    } catch (e) {
      // 구독자의 오류가 호출한 쪽의 원래 오류를 바꾸거나 다른 구독자를 막으면 안 된다. 다만 원인은 남겨서 로그인 관리자의 버그가 조용히 묻히지 않게 한다.
      console.error("SSO 만료 알림을 처리하다 오류가 났어요", e);
    }
  }
}

/**
 * 명령이 쓰는 자격 증명의 프로필. 대부분의 명령은 최상위 인자 `profile`로 받고, pg 명령은 `target` 객체 안(`{ target: { profile, … } }`)에 담는다.
 * 최상위가 우선이다. 문자열이 아니면 없는 것으로 본다.
 */
function profileOf(args: InvokeArgs | undefined): string | undefined {
  const top = args as Record<string, unknown> | undefined;
  if (typeof top?.profile === "string") return top.profile;
  const target = top?.target;
  if (typeof target === "object" && target !== null) {
    const profile = (target as Record<string, unknown>).profile;
    if (typeof profile === "string") return profile;
  }
  return undefined;
}

/** 모든 Tauri 명령이 지나는 길. 오류는 그대로 다시 던지고, SSO 만료면 그 명령의 profile과 시작 시각을 알린다. */
export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  const startedAt = Date.now();
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    const profile = profileOf(args);
    if (isAppError(e) && e.kind === "ssoExpired" && profile !== undefined) reportSsoExpired(profile, startedAt);
    throw e;
  }
}
