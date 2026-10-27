import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { isAppError } from "./errors";

type Listener = (profile: string) => void;
const listeners = new Set<Listener>();

/** SSO 세션 만료로 실패한 명령의 프로필을 받는다. 로그인 관리자가 구독한다. */
export function onSsoExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 이 프로필의 SSO 세션이 만료됐다고 알린다. */
export function reportSsoExpired(profile: string) {
  for (const listener of [...listeners]) listener(profile);
}

/** 모든 Tauri 명령이 지나는 길. 오류는 그대로 다시 던지고, SSO 만료면 그 명령의 profile을 알린다. */
export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    const profile = (args as Record<string, unknown> | undefined)?.profile;
    if (isAppError(e) && e.kind === "ssoExpired" && typeof profile === "string") reportSsoExpired(profile);
    throw e;
  }
}
