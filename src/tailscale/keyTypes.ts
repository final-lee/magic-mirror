export type TsKeyKind = "auth" | "client" | "federated" | "api";

export interface TsKey {
  id: string;
  kind: TsKeyKind;
  description: string;
  created: string | null;
  expires: string | null;
  /** OAuth 클라이언트·federated identity·API 토큰의 스코프 */
  scopes: string[];
  /** auth key는 등록한 기기에 붙는 태그, OAuth 클라이언트·federated identity는 허용 태그 */
  tags: string[];
  reusable: boolean;
  ephemeral: boolean;
  preauthorized: boolean;
  invalid: boolean;
  userId: string | null;
}

export type TsKeyFindingKind = "expired" | "expiring" | "reusablePreauthorized" | "noTags" | "allScope";

/** `days`: expiring이면 남은 날수, expired면 지난 날수 */
export interface TsKeyFinding {
  keyId: string;
  kind: TsKeyFindingKind;
  days: number | null;
}

export interface TsKeys {
  keys: TsKey[];
  findings: TsKeyFinding[];
}

export interface TsKeyCall {
  method: string;
  path: string;
  /** 이 호출에 쓰는 OAuth 스코프 */
  scope: string;
}

export interface TsKeyDeletePreview {
  key: TsKey;
  calls: TsKeyCall[];
  /** 적용하려면 입력해야 하는 글(키 ID) */
  confirmName: string;
  warnings: string[];
  reversible: boolean;
}

/** `logged`가 false면 키는 지웠지만 변경 기록을 남기지 못했다 */
export interface TsKeyDeleted {
  logged: boolean;
}

export interface TsLock {
  enabled: boolean;
  publicKey: string | null;
  nodeKeySigned: boolean | null;
  thisKeyTrusted: boolean | null;
  trustedKeys: number;
  needsSignature: { name: string; nodeKey: string | null }[];
}
