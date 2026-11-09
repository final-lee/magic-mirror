import { invoke } from "../api/invoke";
import type { SqsApplyResult, SqsChange, SqsChangeRecord, SqsFlow, SqsMoveTask, SqsOverview, SqsPeekable, SqsPreview, SqsQueue, SqsRegionFlow } from "./types";

// 명령 이름과 인자는 src-tauri/src/sqs_commands.rs와 같아야 한다(Tauri가 camelCase 인자를 snake_case로 바꿔 준다).
// profile은 최상위 인자로 넘긴다: invoke가 SSO 만료를 알릴 때 읽는다.
export const sqsApi = {
  /** 리전의 큐 목록과 건강 진단. CloudWatch 활동은 백엔드가 5분 동안 캐시한다(force면 새로 읽는다) */
  overview: (profile: string, region: string, force: boolean) => invoke<SqsOverview>("sqs_overview", { profile, region, force }),
  /** 큐 하나를 다시 읽는다(태그 포함) */
  queue: (profile: string, region: string, url: string) => invoke<SqsQueue>("sqs_queue", { profile, region, url }),
  /** 생산자·소비자·DLQ·정책. withIam이면 계정 IAM으로 보내고 받는 주체도 계산한다 */
  flow: (profile: string, region: string, url: string, withIam: boolean) => invoke<SqsFlow>("sqs_flow", { profile, region, url, withIam }),
  /** 리전 전체 SNS → SQS → Lambda/Pipes 흐름(IAM 제외) */
  regionFlow: (profile: string, region: string) => invoke<SqsRegionFlow>("sqs_region_flow", { profile, region }),
  /** 엿보기를 할 수 있는가(DLQ이거나 소비자 없는 큐) */
  peekable: (profile: string, region: string, url: string) => invoke<SqsPeekable>("sqs_peekable", { profile, region, url }),
  preview: (profile: string, region: string, url: string, change: SqsChange) => invoke<SqsPreview>("sqs_preview", { profile, region, url, change }),
  apply: (profile: string, region: string, url: string, change: SqsChange, expectedVersion: string | null, confirmName: string | null) =>
    invoke<SqsApplyResult>("sqs_apply", { profile, region, url, change, expectedVersion, confirmName }),
  /** 엿보기 세션의 남은 메시지를 바로 다시 보이게 한다(ChangeMessageVisibilityBatch 0) */
  release: (profile: string, peekId: string) => invoke<null>("sqs_release", { profile, peekId }),
  /** 저장 대화창에서 고른 경로에 JSONL을 쓴다. 취소하면 null */
  saveJsonl: (fileName: string, text: string) => invoke<string | null>("sqs_save_jsonl", { fileName, text }),
  /** 이 DLQ에서 시작한 메시지 이동 작업(최근 것부터) */
  moveTasks: (profile: string, region: string, url: string) => invoke<SqsMoveTask[]>("sqs_move_tasks", { profile, region, url }),
  /** 이 프로필·리전의 변경 기록(오래된 것부터) */
  changes: (profile: string, region: string) => invoke<SqsChangeRecord[]>("sqs_changes", { profile, region }),
};
