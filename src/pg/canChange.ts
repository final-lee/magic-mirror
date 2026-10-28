import type { PgOverview, PgTargetInfo } from "./types";

/** 읽기 전용 복제본에는 아무것도 바꿀 수 없다 */
export const READ_REPLICA_TEXT = "읽기 전용 복제본이라 바꿀 수 없어요";

/**
 * 이 대상에서 바꾸기 버튼을 끄는 이유. 바꿀 수 있으면 null이다.
 * 읽기 전용 복제본이 먼저이고(로그인한 DB 사용자와 상관없다), 그다음이 로그인한 DB 사용자가 역할을 관리할 수 없는 이유(1단계의 manageReason)다.
 * 바꾸기 버튼은 모두 이 글을 제목과 설명으로 달고 끈다. 막히지 않은 변경도 적용할 때 서버가 권한을 다시 확인한다.
 */
export function changeBlockReason(info: PgTargetInfo, ov: PgOverview): string | null {
  if (info.readReplica) return READ_REPLICA_TEXT;
  return ov.canManage ? null : ov.manageReason;
}
