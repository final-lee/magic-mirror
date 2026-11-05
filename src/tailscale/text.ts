import type { TsCheckStatus } from "./types";

export const DIAGNOSE = "Tailscale 진단";
export const RUNNING = "진단하는 중…";
export const REDIAGNOSE = "다시 진단";
export const ENABLE_ROUTES = "경로 받기 켜기";
export const UNDO = "되돌리기";
export const APPLY = "적용";
export const CANCEL = "취소";
export const EFFECT_ENABLE = "이 Mac이 테일넷의 서브넷 경로를 받아요. 다른 기기 설정은 바뀌지 않아요.";
export const EFFECT_DISABLE = "이 Mac이 테일넷의 서브넷 경로를 받지 않아요. 다른 기기 설정은 바뀌지 않아요.";
export const TAILNET = "테일넷";
export const ADDRESS_UNKNOWN = "주소를 확인하지 못했어요";
export const STATUS: Record<TsCheckStatus, { mark: string; label: string }> = {
  ok: { mark: "✓", label: "정상" },
  warn: { mark: "!", label: "주의" },
  fail: { mark: "✗", label: "실패" },
  skip: { mark: "–", label: "건너뜀" },
};
