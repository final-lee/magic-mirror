import type { AccessLevel, PrincipalKind } from "./types";

/** 권한 표의 열 순서 */
export const LEVELS: AccessLevel[] = ["list", "read", "write", "permissions", "tagging"];

export const LEVEL_LABEL: Record<AccessLevel, string> = {
  list: "목록",
  read: "읽기",
  write: "쓰기",
  permissions: "권한 관리",
  tagging: "태그",
};

export const KIND_LABEL: Record<PrincipalKind, string> = { user: "사용자", group: "그룹", role: "역할" };

export const STATUS_LABEL = {
  allowed: "허용",
  conditional: "조건부",
  denied: "거부",
  boundary: "경계로 차단",
} as const;
