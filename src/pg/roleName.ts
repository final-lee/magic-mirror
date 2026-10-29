import type { PgRoleSummary } from "./types";

// 새 역할 이름의 규칙과 글. 백엔드(pg/change/resolve.rs의 new_name)와 같다: 같은 이름을 같은 글로 막는다.
export const BAD_NAME_TEXT = "역할 이름이 올바르지 않아요. 1~63바이트이고 pg_로 시작하지 않아야 해요";
export const RESERVED_NAME_TEXT = "이 이름은 PostgreSQL이 예약해 둬서 쓸 수 없어요";
export const nameTakenText = (name: string) => `이미 있는 역할이에요: ${name}`;

/** 역할 이름으로 쓸 수 없는 예약어(대소문자 구분 없이) */
const RESERVED = ["public", "none", "current_role", "current_user", "session_user"];

const encoder = new TextEncoder();

/**
 * 새 역할 이름의 문제. 없으면 null이다. 빈 이름도 올바르지 않지만 아직 입력하지 않은 칸을 탓하지는 않으므로 호출한 쪽이 비어 있는지 따로 본다.
 * 길이는 글자가 아니라 바이트다(PostgreSQL의 한도). 이미 있는 역할은 글자 그대로 같은 이름만 센다.
 */
export function roleNameProblem(name: string, roles: PgRoleSummary[]): string | null {
  if (name === "" || encoder.encode(name).length > 63 || name.startsWith("pg_") || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return BAD_NAME_TEXT;
  const lower = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (RESERVED.includes(lower)) return RESERVED_NAME_TEXT;
  if (roles.some((r) => r.name === name)) return nameTakenText(name);
  return null;
}
