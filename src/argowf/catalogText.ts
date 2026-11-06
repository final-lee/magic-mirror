// Cron·템플릿·보관함·점검 화면의 글(오류 문구는 text.ts)

export const CAT_LOADING = "불러오는 중…";
export const CAT_CLOSE = "닫기";
export const CAT_CONFIRM = "적용";
export const CAT_NO_RUNS = "이 목록에 보일 Workflow가 없어요. 끝난 Workflow는 TTL로 지워졌을 수 있어요";
export const CAT_FIND_COUNT_UNIT = "건";

// Workflow 열(Workflows·보관함·이력이 같이 쓴다)
export const COL_NAME = "이름";
export const COL_NAMESPACE = "네임스페이스";
export const COL_STATE = "상태";
export const COL_ORIGIN = "원천";
export const COL_STARTED = "시작";
export const COL_DURATION = "걸린 시간";
export const COL_MESSAGE = "메시지";
export const CAT_ORIGIN_DIRECT = "직접";
export const CAT_ORIGIN_CRON = (name: string) => `⏱ ${name}`;
export const CAT_ORIGIN_TEMPLATE = (name: string) => `📄 ${name}`;

/** 최근 실행 막대의 읽을 거리: "최근 3회: 성공 2 · 실패 1" (0인 것은 뺀다) */
export function runsLabel(phases: string[]): string {
  if (phases.length === 0) return "최근 실행 없음";
  const count = (f: (p: string) => boolean) => phases.filter(f).length;
  const parts = [
    ["성공", count((p) => p === "Succeeded")],
    ["실패", count((p) => p === "Failed" || p === "Error")],
    ["실행 중", count((p) => p === "Running")],
    ["대기", count((p) => p === "Pending")],
  ] as const;
  return `최근 ${phases.length}회: ${parts
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t} ${n}`)
    .join(" · ")}`;
}

// CronWorkflow
export const CRON_SEARCH = "CronWorkflow 찾기";
export const CAT_NO_CRONS = "CronWorkflow가 없어요";
export const CAT_NO_CRON_MATCH = "찾는 CronWorkflow가 없어요";
export const CRON_COL_SCHEDULE = "스케줄";
export const CRON_COL_NEXT = "다음 실행";
export const CRON_COL_LAST = "마지막 실행";
export const CRON_COL_RUNS = "최근 10회";
export const CRON_COL_STATE = "상태";
export const CRON_COL_POLICY = "동시 실행 정책";
export const CRON_SUSPENDED = "정지됨";
export const CRON_MISSED = "놓침";
export const CRON_NEVER_RAN = "아직 안 돌았어요";
export const cronLastScheduled = (rel: string) => `${rel} 예약됨 (결과를 알 수 없어요)`;

export const CRON_DETAIL_LABEL = "CronWorkflow 상세";
export const CRON_KIND = "CronWorkflow";
export const TAB_CRON_OVERVIEW = "개요";
export const TAB_CRON_RUNS = "실행 이력";
export const TAB_YAML = "YAML";
export const SEC_CRON_SCHEDULE = "스케줄";
export const SEC_CRON_NEXT = "다음 5회";
export const SEC_CRON_STATE = "상태";
export const SEC_CRON_SPEC = "Workflow 설정";
export const CRON_SCHEDULE = "스케줄";
export const CRON_TIMEZONE = "시간대";
export const CRON_CONCURRENCY = "동시 실행 정책";
export const CRON_STARTING_DEADLINE = "시작 기한";
export const cronStartingDeadline = (seconds: number) => `${seconds}초`;
export const CRON_NEXT_NONE = "예정된 실행이 없어요";
export const CRON_NEXT_SUSPENDED = "정지돼 있어서 아래 시각에 실행되지 않아요";
export const CRON_ACTIVE = "실행 중인 Workflow";
export const CRON_SUCCEEDED_FAILED = "성공 / 실패";
export const CRON_LAST_SCHEDULED = "마지막 예약";
export const CRON_ENTRYPOINT = "entrypoint";
export const CRON_TEMPLATE = "템플릿";
export const CRON_SA = "ServiceAccount";
export const CRON_PARAMS = "파라미터";

export const CRON_RUN = "지금 실행…";
export const CRON_RUN_NOTE = "이 Cron의 설정으로 Workflow를 하나 바로 만들어요. 스케줄과 상관없고, 만든 Workflow는 지울 수 있어요.";
export const CRON_RUN_DONE = "Workflow를 만들었어요";
export const CRON_SUSPEND = "정지…";
export const CRON_SUSPEND_NOTE = "스케줄 실행을 멈춰요. 이미 도는 Workflow는 그대로 두고, 재개하면 다시 돌아요.";
export const CRON_SUSPEND_DONE = "정지했어요";
export const CRON_RESUME = "재개…";
export const CRON_RESUME_NOTE = "스케줄 실행을 다시 시작해요. 정지된 동안 지나간 실행은 따라잡지 않아요.";
export const CRON_RESUME_DONE = "재개했어요";
export const CRON_DELETE = "삭제…";
export const CRON_DELETE_NOTE = "이 CronWorkflow를 지워요. 되돌릴 수 없어요. 이미 만들어진 Workflow는 남아요.";
export const CRON_DELETE_DONE = "삭제했어요";

// 템플릿
export const TPL_SEARCH = "템플릿 찾기";
export const CAT_NO_TEMPLATES = "WorkflowTemplate이 없어요";
export const CAT_NO_TEMPLATE_MATCH = "찾는 템플릿이 없어요";
export const TPL_CLUSTER = "클러스터";
export const TPL_COL_SCOPE = "범위";
export const TPL_COL_PARAMS = "파라미터";
export const TPL_COL_CRONS = "쓰는 Cron";
export const TPL_COL_RATE = "최근 성공률";
export const TPL_NO_RUNS_RATE = "실행 없음";
export const rateText = (ok: number, total: number) => `${Math.round((ok / total) * 100)}% (${ok}/${total})`;

export const TPL_DETAIL_LABEL = "템플릿 상세";
export const TAB_TPL_OVERVIEW = "개요";
export const TAB_TPL_RUNS = "최근 실행";
export const SEC_TPL_DESC = "설명";
export const SEC_TPL_PARAMS = "파라미터";
export const SEC_TPL_TEMPLATES = "템플릿";
export const SEC_TPL_CRONS = "쓰는 Cron";
export const TPL_NO_PARAMS = "파라미터가 없어요";
export const TPL_NO_CRONS = "이 템플릿을 쓰는 Cron이 없어요";
export const TPL_COL_DEFAULT = "기본값";
export const TPL_COL_ENUM = "선택지";
export const TPL_COL_DESC = "설명";
export const TPL_ENTRYPOINT = "entrypoint";
export const TPL_TEMPLATE_NAMES = "템플릿 이름";
export const TPL_SA = "ServiceAccount";
export const TPL_NO_DEADLINE = "없어요";
export const TPL_RUN = "실행…";

// 템플릿 실행 창
export const SUBMIT_TITLE = (name: string) => `${name} 실행`;
export const SUBMIT_NOTE = "이 템플릿으로 Workflow를 새로 만들어요. 아래 값이 그대로 파라미터로 가요.";
export const SUBMIT_NAMESPACE = "네임스페이스";
export const SUBMIT_NO_PARAMS = "이 템플릿은 파라미터가 없어요.";
export const SUBMIT_PICK = "선택하세요";
export const SUBMIT_DONE = "Workflow를 만들었어요";
export const SUBMIT_NEED_NAMESPACE = "Workflow를 만들 네임스페이스를 넣어 주세요";
export const submitNeedChoice = (name: string) => `${name} 값을 골라 주세요`;

// 보관함
export const ARCHIVE_SEARCH = "보관된 Workflow 찾기";
export const ARCHIVE_EMPTY = "보관된 Workflow가 없어요. 서버에 아카이브를 켜지 않았을 수 있어요";
export const ARCHIVE_NO_MATCH = "찾는 Workflow가 없어요";

// 점검
export const FIND_CARDS_LABEL = "점검 항목";
export const FIND_ITEMS_LABEL = "점검 대상";
export const FIND_COL_SUBJECT = "종류";
export const FIND_COL_TARGET = "대상";
export const FIND_COL_SCOPE = "범위";
export const FIND_COL_DETAIL = "내용";
export const FIND_NONE = "문제 없음";
export const FIND_NO_PROBLEMS = "발견된 문제가 없어요";
export const FIND_LEVEL = { danger: "위험", warn: "주의", info: "참고" };

export const FIND_FAILING = "연속 실패 Cron";
export const FIND_MISSED = "놓친 실행이 있는 Cron";
export const FIND_LONG_RUNNING = "오래 실행 중";
export const FIND_LONG_PENDING = "오래 대기 중";
export const FIND_NO_DEADLINE = "제한 시간 없는 Cron·템플릿";
export const FIND_DEFAULT_SA_TITLE = "default ServiceAccount로 도는 Cron·템플릿";

export const FIND_SUBJECT_CRON = "Cron";
export const FIND_SUBJECT_WORKFLOW = "Workflow";
export const FIND_SUBJECT_TEMPLATE = "템플릿";
export const FIND_SUBJECT_CLUSTER_TEMPLATE = "클러스터 템플릿";
export const FIND_SCOPE_CLUSTER = "클러스터";

export const findFailingDetail = (streak: number, lastRel: string) => `최근 ${streak}회 연속 실패${lastRel ? ` · 마지막 실행 ${lastRel}` : ""}`;
export const findMissedDetail = (lastRel: string) => `예정된 실행을 놓쳤어요${lastRel ? ` · 마지막 예약 ${lastRel}` : ""}`;
export const findRunningDetail = (span: string, suspended: boolean) => `${span}째 실행 중${suspended ? " (정지됨)" : ""}`;
export const findPendingDetail = (span: string) => `${span}째 대기 중`;
export const FIND_NO_DEADLINE_DETAIL = "activeDeadlineSeconds가 없어서 멈추지 않으면 계속 돌 수 있어요";
export const FIND_DEFAULT_SA = "default ServiceAccount로 돌아요";
export const FIND_DEFAULT_SA_UNSET = "ServiceAccount를 정하지 않아서 default로 돌아요";
