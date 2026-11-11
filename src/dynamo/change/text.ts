import { CLASS_LABEL } from "../text";

export const PREVIEW = "변경 미리 보기";
export const LOADING = "미리 보기를 불러오는 중이에요…";
export const CALLS = "보낼 요청";
export const DIFF = "변경 전후";
export const IMPACT = "영향";
export const WARNINGS = "주의할 점";
export const CONFIRM = "확인하려면 테이블 이름을 입력해 주세요";
export const APPLY = "적용";
export const CANCEL = "취소";
export const UNDO = "되돌리기…";
export const EMPTY = "아직 변경 기록이 없어요.";
export const RELOAD = "다시 읽기";
export const DONE = "되돌렸어요";
export const UNAVAILABLE = "되돌릴 수 없어요";
export const SETTING = "항목";
export const ATTRIBUTE = "속성";
export const BEFORE = "이전";
export const AFTER = "변경 후";
export const NO_VALUE = "—";
export const RAW_DIFF = "원본 JSON 보기";
export const paramsSummary = (lines: number) => `요청 인자 보기 (${lines}줄)`;
export { OFF, ON } from "../text";
export const FIELD: Record<string, string> = {
  enabled: "사용",
  attribute: "속성 이름",
  days: "복구 기간(일)",
  viewType: "뷰 타입",
  class: "테이블 클래스",
  mode: "용량 모드",
  read: "읽기 용량(RCU)",
  write: "쓰기 용량(WCU)",
  indexes: "인덱스 용량",
  arn: "ARN",
  name: "이름",
  target: "새 테이블 이름",
  time: "시각",
  bucket: "S3 버킷",
  prefix: "S3 접두사",
  format: "형식",
};
export const SETTING_VALUE: Record<string, string> = {
  onDemand: "온디맨드",
  provisioned: "프로비저닝",
  ...CLASS_LABEL,
};
export const SUCCESS = "성공";
export const FAILURE = "실패";
export const undoOf = (summary: string) => `되돌리기: ${summary}`;
export const UNDO_ORIGIN_UNKNOWN = "되돌리기: 원래 기록을 찾을 수 없어요";
export const UNDO_UNAVAILABLE = "되돌릴 수 없음(이전 값이 남아 있지 않음)";
export const RESULTS_TITLE = "변경하지 못한 아이템";
export const READ_ITEM = "읽은 아이템";
export const LATEST_ITEM = "현재 아이템";
export const CLOSE = "닫기";
