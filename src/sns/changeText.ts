// 변경 대화창·변경 기록·DLQ 고르기의 글. 백엔드가 주는 글(경고, 영향)은 여기 두지 않는다.
import type { SnsChangeRequest } from "./types";
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
