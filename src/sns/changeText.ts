// 변경 대화창·변경 기록·DLQ 고르기의 글. 백엔드가 주는 글(경고, 영향)은 여기 두지 않는다.
import { readKey } from "./change";
import type { SnsChangeRecord, SnsChangeRequest } from "./types";
import { resourceNameOf } from "./targets";

// 변경 대화창
export const PLAN_LOADING = "미리보기를 만드는 중이에요…";
export const PLAN_FAILED = "미리보기를 만들지 못했어요";
export const APPLY_FAILED = "적용하지 못했어요";
export const STALE_NOTICE = "적용하기 전에 상태가 바뀌어서 미리보기를 다시 만들었어요. 바뀐 내용을 확인한 뒤에 적용하세요";
export const SECTION_CALLS = "호출할 API";
export const SECTION_FIELDS = "바뀌는 값";
export const SECTION_IMPACT = "진단에 생기는 변화";
export const CALL_TARGET = "대상";
export const CALL_BODY = "본문";
export const FIELD_BEFORE = "이전";
export const FIELD_AFTER = "이후";
export const FIELD_NONE = "없음";
export const NO_FIELDS = "바뀌는 값이 없어요";
export const DIFF_LABEL = "줄 차이";
export const REPLAN = "미리보기 다시 받기";
export const APPLY = "적용";
export const APPLYING = "적용 중…";
export const UNDO_APPLY = "되돌리기";
export const UNDOING = "되돌리는 중…";
export const CANCEL = "취소";
export const CLOSE = "닫기";
export const CONFIRM_GATE = "확인 문구를 정확히 입력해야 적용할 수 있어요";
export const NOT_READY = "미리보기를 받은 뒤에 적용할 수 있어요";
export const RESULT_OK = "적용했어요";
export const RESULT_UNDO_OK = "되돌렸어요";
export const RESULT_PARTIAL = "일부만 적용했어요";
export const RESULT_NONE = "적용하지 못했어요";
export const RESULT_CALLS = "실행한 호출";
export const RESULT_NO_CALLS = "실행한 호출이 없어요";
export const RESULT_RECORDED = "변경 기록에 남겼어요";
export const RESULT_OUTPUTS = "결과값";
export const RESULT_PARTIAL_NOTE = "앞의 호출은 이미 AWS에 반영됐어요. 변경 기록에서 되돌릴 수 있어요";

export const UNDO_TITLE = "되돌리기 미리보기";

/** 대화창 제목: 무엇을 하는 변경인지 */
export function requestTitle(request: SnsChangeRequest): string {
  switch (request.kind) {
    case "queuePolicy":
      return "큐 정책 고치기";
    case "lambdaPermission":
      return "Lambda 권한 고치기";
    case "addDlq":
      return "DLQ 붙이기";
    case "replay":
      return "다시 보내기";
    case "archivePolicy":
      return "아카이브 정책 변경";
    case "subscribe":
      return "구독 만들기";
    case "unsubscribe":
      return "구독 해지";
    case "filterPolicy":
      return "필터 정책 바꾸기";
    case "rawDelivery":
      return request.enabled ? "raw 전달 켜기" : "raw 전달 끄기";
    case "subscriptionDeliveryPolicy":
      return "구독의 HTTP 배달 정책";
    case "topicDeliveryPolicy":
      return "주제의 HTTP 배달 정책";
    case "topicPolicy":
      return "주제 정책 저장";
    case "deliveryLogging":
      return "배달 상태 로깅";
    case "publish":
      return "시험 발행";
    case "undo":
      return UNDO_TITLE;
  }
}

/** 구독 ARN의 끝 조각(UUID)을 짧게 */
const shortSubscription = (arn: string) => (arn.split(":").pop() ?? arn).slice(0, 8);

/** 변경 기록의 한 줄 요약 */
export function requestSummary(request: SnsChangeRequest): string {
  switch (request.kind) {
    case "queuePolicy":
      return `큐 정책에 이 주제의 배달 권한 추가 · ${resourceNameOf(request.queueArn) ?? request.queueArn}`;
    case "lambdaPermission":
      return `Lambda 함수에 이 주제의 호출 권한 추가 · ${resourceNameOf(request.functionArn) ?? request.functionArn}`;
    case "addDlq":
      return `구독 ${shortSubscription(request.subscriptionArn)}에 DLQ 붙이기 · ${resourceNameOf(request.dlqArn) ?? request.dlqArn}`;
    case "replay":
      return `구독 ${shortSubscription(request.subscriptionArn)} 다시 보내기 · 되돌릴 수 없음`;
    case "archivePolicy":
      return request.retentionDays === null ? "아카이브 끄기" : `아카이브 보존 ${request.retentionDays}일`;
    case "subscribe":
      return `구독 만들기 · ${request.protocol} · ${resourceNameOf(request.endpoint) ?? request.endpoint}`;
    case "unsubscribe":
      return `구독 ${shortSubscription(request.subscriptionArn)} 해지`;
    case "filterPolicy":
      return request.filterPolicy === null ? `구독 ${shortSubscription(request.subscriptionArn)} 필터 정책 지우기` : `구독 ${shortSubscription(request.subscriptionArn)} 필터 정책 바꾸기`;
    case "rawDelivery":
      return `구독 ${shortSubscription(request.subscriptionArn)} raw 전달 ${request.enabled ? "켜기" : "끄기"}`;
    case "subscriptionDeliveryPolicy":
      return `구독 ${shortSubscription(request.subscriptionArn)} HTTP 배달 정책 ${request.deliveryPolicy === null ? "지우기" : "바꾸기"}`;
    case "topicDeliveryPolicy":
      return `주제 HTTP 배달 정책 ${request.deliveryPolicy === null ? "지우기" : "바꾸기"}`;
    case "topicPolicy":
      return "주제 정책 저장";
    case "deliveryLogging":
      return `${request.protocol} 배달 상태 로깅 · 성공 ${request.successRoleArn ? `역할 ${resourceNameOf(request.successRoleArn) ?? "있음"}, 표본 ${request.sampleRate}%` : "꺼짐"} · 실패 ${request.failureRoleArn ? "역할 있음" : "꺼짐"}`;
    case "publish":
      return `시험 발행 · 속성 ${request.attributes.length}개${request.messageGroupId ? ` · 그룹 ${request.messageGroupId}` : ""}`;
    case "undo":
      return `변경 되돌리기 · 기록 ${request.id}`;
  }
}

// 변경 기록
export const LOG_LABEL = "변경 기록";
export const LOG_LOADING = "변경 기록을 불러오는 중…";
export const LOG_EMPTY = "이 주제의 변경 기록이 없어요";
export const LOG_COLS = { at: "시각", summary: "내용", calls: "호출", state: "상태", action: "조치" } as const;
export const LOG_UNDONE = "되돌렸어요";
export const LOG_IS_UNDO = "되돌리기 기록";
export const UNDO_OPEN = "되돌리기…";
export const UNDO_WHY_DONE = "이미 되돌렸어요";
export const UNDO_WHY_IS_UNDO = "되돌리기 기록은 다시 되돌릴 수 없어요";
export const UNDO_WHY_NO_CALLS = "실행한 호출이 없어서 되돌릴 것이 없어요";
export const UNDO_WHY_PUBLISH = "발행한 메시지는 되돌릴 수 없어요";
export const LOG_RECONFIRM = "다시 확인 필요";

/** 변경 기록에서 한 줄 요약 아래에 더 보여 줄 값(발행한 MessageId 등). 없으면 null */
export function recordDetail(record: SnsChangeRecord): string | null {
  const messageId = readKey(record.after, "messageId");
  const subscriptionArn = readKey(record.after, "subscriptionArn");
  if (record.request.kind === "publish" && typeof messageId === "string") return `MessageId ${messageId}`;
  if (record.request.kind === "subscribe" && typeof subscriptionArn === "string" && !subscriptionArn.startsWith("arn:")) return subscriptionArn;
  return null;
}

/** 해지 기록이 email·http(s)라 되돌려도 다시 확인이 필요한가 */
export function needsReconfirm(record: SnsChangeRecord): boolean {
  return record.request.kind === "unsubscribe" && readKey(readKey(record.before, "subscription"), "reconfirm") === true;
}

// DLQ 고르기
export const DLQ_TITLE = "DLQ 고르기";
export const DLQ_LOADING = "SQS 큐 목록을 불러오는 중…";
export const DLQ_LIST = "DLQ로 쓸 수 있는 큐";
export const DLQ_EMPTY = "DLQ로 쓸 수 있는 큐가 없어요";
export const DLQ_FILTER = "큐 이름 찾기";
export const DLQ_NO_MATCH = "찾는 큐가 없어요";
export const DLQ_PREVIEW = "미리 보기…";
export const DLQ_NEED_PICK = "DLQ로 쓸 큐를 고르세요";
export const DLQ_RULE = (fifo: boolean) => (fifo ? "이 구독에는 FIFO 큐만 DLQ로 쓸 수 있어요(FIFO 구독의 DLQ는 FIFO 큐여야 해요)" : "이 구독에는 표준 큐만 DLQ로 쓸 수 있어요(표준 구독의 DLQ는 표준 큐여야 해요)");
export const DLQ_HIDDEN = (n: number) => `종류·계정·리전이 맞지 않아 숨긴 큐 ${n}개`;
export const DLQ_TRUNCATED = "큐가 많아서 목록이 잘렸을 수 있어요. 안 보이는 큐는 이름으로 찾지 못해요";

// 진단의 고치기 단추
export const FIX_OPEN = "고치기…";
export const FIX_DLQ_OPEN = "DLQ 붙이기…";
export const FIX_DLQ_MISSING = "이 구독을 찾을 수 없어서 DLQ를 붙일 수 없어요";
