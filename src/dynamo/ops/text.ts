import { OFF, ON, statusLabel, UNREAD } from "../text";

export const SETTINGS = "테이블 설정";
export const TTL = "TTL";
export const PITR = "특정 시점 복구(PITR)";
export const PROTECTION = "삭제 보호";
export const STREAM = "스트림";
export const CLASS = "테이블 클래스";
export const BILLING = "용량 모드";
export const INSIGHTS = "Contributor Insights";
export const ENABLE = "켜기…";
export const DISABLE = "끄기…";
export const CHANGE = "변경…";
export const BACKUPS = "온디맨드 백업";
export const BACKUP_NAME = "백업 이름";
export const CREATE_BACKUP = "백업 만들기…";
export const NO_BACKUPS = "백업이 없어요.";
export const DELETE = "삭제…";
export const RESTORE = "복원…";
export const RESTORE_PITR = "특정 시점으로 복원";
export const RESTORE_LOADING = "복원 상태를 읽는 중이에요…";
export const TARGET = "새 테이블 이름";
export const TIME = "복원 시각 (ISO 8601, 비우면 최신)";
export const EXPORT = "S3로 내보내기";
export const BUCKET = "같은 계정 S3 버킷";
export const PREFIX = "S3 접두사";
export const EXPORTS = "내보내기 기록";
export const EMPTY_EXPORTS = "내보낸 기록이 없어요.";
export const APPLY = "변경…";
export const ATTR = "TTL 속성 이름";
export const DAYS = "복구 기간(일)";
export const RCU = "읽기 용량(RCU)";
export const WCU = "쓰기 용량(WCU)";
export const ON_DEMAND = "온디맨드";
export const PROVISIONED = "프로비저닝";
export const READ_AGAIN = "다시 읽기";
export const STATUS_WORD: Record<string, string> = {
  ENABLED: ON,
  DISABLED: OFF,
  ENABLING: "켜는 중",
  DISABLING: "끄는 중",
  FAILED: "실패",
  AVAILABLE: "사용할 수 있음",
  DELETED: "삭제됨",
  IN_PROGRESS: "진행 중",
  COMPLETED: "완료",
};
/** AWS가 주는 상태 낱말을 한국어로. 읽지 못했으면(null) "읽지 못했어요" */
export const statusText = (status: string | null | undefined) =>
  status == null ? UNREAD : (STATUS_WORD[status] ?? statusLabel(status));
