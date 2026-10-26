import type { AppError } from "./types";

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e;
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) {
    switch (e.kind) {
      case "ssoExpired":
        return "SSO 세션이 만료됐어요";
      case "accessDenied":
        return `권한 없음 (${e.action})`;
      case "throttled":
        return "요청이 너무 많아요. 잠시 후 다시 시도하세요";
      case "network":
        return `네트워크 오류: ${e.message}`;
      case "other":
        return e.message;
    }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
