import type { PgOverview, PgTargetInfo } from "./types";

/** 읽기 전용 복제본에는 아무것도 바꿀 수 없다 */
export const READ_REPLICA_TEXT = "읽기 전용 복제본이라 바꿀 수 없어요";

/** 시스템 역할(rdsadmin, rds_*, pg_* …)은 이 앱에서 바꿀 수 없다. 미리보기가 막힘으로 알리는 글과 같다 */
export const systemRoleText = (role: string) => `시스템 역할이라 바꿀 수 없어요: ${role}`;

/**
 * 이 대상에서 바꾸기 버튼을 끄는 이유. 바꿀 수 있으면 null이다.
 * 읽기 전용 복제본이 먼저이고(로그인한 DB 사용자와 상관없다), 그다음이 로그인한 DB 사용자가 역할을 관리할 수 없는 이유(1단계의 manageReason)다.
 * 바꾸기 버튼은 모두 이 글을 제목과 설명으로 달고 끈다. 막히지 않은 변경도 적용할 때 서버가 권한을 다시 확인한다.
 */
export function changeBlockReason(info: PgTargetInfo, ov: PgOverview): string | null {
  if (info.readReplica) return READ_REPLICA_TEXT;
  return ov.canManage ? null : ov.manageReason;
}

/** 소유자라서 가진 권한은 바꾸기 모드에서 켜고 끌 수 없다 */
export const OWNER_HELD_TEXT = "소유자라서 가진 권한이에요";

/** 구성원을 넣거나 뺄 수 있는 시스템 그룹. 나머지 시스템 역할은 구성원을 바꿀 수 없다 */
export const MEMBERSHIP_SYSTEM_GROUPS: readonly string[] = [
  "rds_superuser",
  "rds_iam",
  "rds_password",
  "rds_replication",
  "pg_read_all_data",
  "pg_write_all_data",
  "pg_monitor",
  "pg_read_all_settings",
  "pg_read_all_stats",
  "pg_stat_scan_tables",
  "pg_signal_backend",
];
