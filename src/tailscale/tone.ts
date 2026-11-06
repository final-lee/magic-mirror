import type { ShareRequest } from "./shareTypes";

export type Tone = "primary" | "create" | "warn" | "caution" | "danger" | "refresh";

const WEIGHT: Record<Tone, number> = { danger: 5, caution: 4, warn: 3, create: 2, primary: 1, refresh: 0 };

/** 여러 변경이 섞이면 가장 무거운 색을 따른다. */
export function heaviestTone(tones: readonly Tone[]): Tone {
  return tones.reduce<Tone>((top, tone) => (WEIGHT[tone] > WEIGHT[top] ? tone : top), "primary");
}

/** 되돌리기: 없애는 일을 되돌리는 것(만든 것을 지우기)은 여전히 없애기이고, 나머지는 멈춤·되돌림이다. */
export function revertTone(tone: Tone): Tone {
  return tone === "danger" ? "danger" : "caution";
}

/** 기기 API 변경(`DeviceChange`의 요청 항목과 일괄 작업 메뉴의 작업 이름). */
export function deviceActionTone(action: string): Tone {
  if (action === "delete" || action === "expire") return "danger";
  if (action === "routes") return "create";
  if (action === "authorize" || action.startsWith("keyExpiry")) return "warn";
  return "primary";
}

export function deviceChangeTone(actions: readonly string[]): Tone {
  return heaviestTone(actions.map(deviceActionTone));
}

/** 연동(웹훅·포스처·OAuth 앱·로그 스트리밍·AWS 외부 ID) 요청. */
export function integrationTone(action: string): Tone {
  if (action.endsWith("Delete")) return "danger";
  if (action.endsWith("Create")) return "create";
  if (action === "webhookRotate") return "warn";
  if (action === "externalValidate") return "refresh";
  return "primary";
}

/** Tailnet Lock 명령. `revert`는 직전 신뢰 키 변경을 되돌리는 명령이다. */
export function lockTone(kind: string, revert = false): Tone {
  const tone = lockKindTone(kind);
  return revert ? revertTone(tone) : tone;
}

function lockKindTone(kind: string): Tone {
  switch (kind) {
    case "initialize":
    case "local-off":
    case "tailnet-off": return "warn";
    case "trust-key": return "create";
    case "untrust-key":
    case "revoke-start":
    case "revoke-cosign":
    case "revoke-finish": return "danger";
    default: return "primary";
  }
}

/** 이 Mac의 `tailscale` 명령. 설정(`tailscale set`)은 화면에서 직접 정한다: 켜기·끄기와 exit node는 상태 변경, 그 밖의 값은 실행, 되돌리기는 멈춤·되돌림. */
export function macActionTone(kind: string): Tone {
  switch (kind) {
    case "disconnect":
    case "sign-out": return "caution";
    case "account-select": return "warn";
    case "account-remove": return "danger";
    default: return "primary";
  }
}

/** 공유(Serve·Funnel·Service 호스트·Taildrop·인증서) 명령. */
export function shareTone(request: ShareRequest): Tone {
  switch (request.action) {
    case "mapping": return "create";
    case "mapping-off": return request.service === "funnel" ? "warn" : "danger";
    case "advertise": return "warn";
    case "serve-reset":
    case "funnel-reset":
    case "drain":
    case "clear": return "danger";
    default: return "primary";
  }
}

/** 사용자·초대 변경. */
export function userTone(action: string, revert = false): Tone {
  const tone = userActionTone(action);
  return revert ? revertTone(tone) : tone;
}

function userActionTone(action: string): Tone {
  switch (action) {
    case "delete":
    case "deleteInvite": return "danger";
    case "suspend": return "caution";
    case "createInvite": return "create";
    case "role":
    case "approve":
    case "restore": return "warn";
    default: return "primary";
  }
}
