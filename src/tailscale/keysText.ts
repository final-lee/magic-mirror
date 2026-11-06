import type { TsKeyFinding, TsKeyKind } from "./keyTypes";

export const TAB_KEYS = "키";
export const LOADING = "키 목록을 읽는 중이에요…";
export const REFRESH = "다시 읽기";
export const SEARCH = "키 검색";
export const NO_KEYS = "키가 없어요.";
export const NO_MATCH = "조건에 맞는 키가 없어요.";
export const READ_ERROR = "키 목록을 읽지 못했어요";

export const KIND_LABEL: Record<TsKeyKind, string> = {
  auth: "auth key",
  client: "OAuth 클라이언트",
  federated: "federated identity",
  api: "API 토큰",
};
export const ALL = "모두";
export const FINDINGS_ONLY = "지적 있는 키";

export const COL_KIND = "종류";
export const COL_DESCRIPTION = "설명";
export const COL_CREATED = "만든 날";
export const COL_EXPIRES = "만료";
export const COL_ACCESS = "권한";
export const COL_FINDINGS = "점검";
export const NO_EXPIRY = "만료 없음";
export const NONE = "—";

export const REUSABLE = "재사용";
export const EPHEMERAL = "임시 기기";
export const PREAUTHORIZED = "사전 승인";
export const NO_DESCRIPTION = "(설명 없음)";

export const FINDINGS_TITLE = "점검 결과";
export const NO_FINDINGS = "지적할 키가 없어요.";
export const findingText = (finding: TsKeyFinding): string => {
  switch (finding.kind) {
    case "expired":
      return finding.days ? `만료됐어요 (${finding.days}일 전)` : "만료됐어요";
    case "expiring":
      return `${finding.days ?? 0}일 안에 만료돼요`;
    case "reusablePreauthorized":
      return "재사용 + 사전 승인 키예요. 새어 나가면 누구나 기기를 등록할 수 있어요";
    case "noTags":
      return "태그가 없어요. 등록한 기기가 키를 만든 사용자의 기기가 돼요";
    case "allScope":
      return "all 스코프예요. 테일넷 전체를 바꿀 수 있어요";
  }
};
export const findingShort: Record<TsKeyFinding["kind"], string> = {
  expired: "만료됨",
  expiring: "만료 임박",
  reusablePreauthorized: "재사용·사전 승인",
  noTags: "태그 없음",
  allScope: "all 스코프",
};

export const DELETE = "삭제";
export const deleteLabel = (name: string) => `${name} 삭제`;
export const DELETE_PREVIEW = "키 삭제 미리보기";
export const DELETE_PREVIEW_LOADING = "미리보기를 만드는 중이에요…";
export const CALLS = "부를 API";
export const CALL_SCOPE = "필요한 스코프";
export const CONFIRM_LABEL = (id: string) => `확인하려면 ${id} 입력`;
export const CONFIRM_MISMATCH = "입력한 키 ID가 달라요";
export const NOT_UNDOABLE = "되돌릴 수 없어요";
export const APPLY = "삭제";
export const APPLYING = "삭제하는 중…";
export const CLOSE = "닫기";
export const deleted = (name: string) => `삭제했어요: ${name}`;
export const NOT_LOGGED = "키는 지웠지만 변경 기록을 남기지 못했어요.";

export const LOCK_TITLE = "Tailnet Lock";
export const LOCK_LOADING = "Tailnet Lock 상태를 읽는 중이에요…";
export const LOCK_ERROR = "Tailnet Lock 상태를 읽지 못했어요";
export const LOCK_ENABLED = "상태";
export const LOCK_ON = "켜짐";
export const LOCK_OFF = "꺼짐";
export const LOCK_THIS_KEY = "이 Mac의 잠금 키";
export const LOCK_TRUSTED = "신뢰 키예요. 이 Mac이 서명 노드예요";
export const LOCK_NOT_TRUSTED = "신뢰 키가 아니에요. 이 Mac은 서명 노드가 아니에요";
export const LOCK_NODE_KEY = "이 Mac의 노드 키";
export const LOCK_SIGNED = "서명됨";
export const LOCK_UNSIGNED = "서명 안 됨";
export const LOCK_TRUSTED_COUNT = "신뢰 키 수";
export const LOCK_NEEDS_SIGNATURE = "서명이 필요한 기기";
export const LOCK_NONE_PENDING = "없음";
export const LOCK_DISABLED_NOTE = "Tailnet Lock이 꺼져 있어요. 켜면 서명 노드가 서명한 기기만 테일넷에 들어와요.";
