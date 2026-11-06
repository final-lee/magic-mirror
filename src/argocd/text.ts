// ArgoCD 화면의 글. 오류 문구 두 개(TOKEN_INVALID, TOKEN_MISSING)는 백엔드의 ARGOCD_TOKEN_INVALID·ARGOCD_TOKEN_MISSING과 글자까지 같아야 한다.
import type { ArgoEnv, ArgoEnvSource } from "./argoEnv";

export const ARGOCD_TITLE = "🐙 ArgoCD";
export const LOADING = "불러오는 중…";
export const CLOSE = "닫기";
export const COL_NAME = "이름";
export const COL_NAMESPACE = "네임스페이스";
export const H_STATE = "상태";
export const H_MESSAGE = "메시지";

// 서버 고르기·편집
export const SERVER_LABEL = "ArgoCD 서버";
export const SERVER_EDIT = "서버 목록 편집";
export const SERVER_NAME = "서버 이름";
export const SERVER_NAME_PLACEHOLDER = "이름(비우면 주소의 호스트)";
export const SERVER_URL = "서버 주소";
export const SERVER_ADD = "서버 추가";
export const SERVER_NEXT = "다음";
export const SERVER_REMOVE = "삭제";
export const SERVER_URL_PLACEHOLDER = "https://argocd.example.com";
export const SERVER_INVALID = "http:// 또는 https://로 시작하는 서버 주소를 넣어 주세요";
export const SERVER_DUPLICATE = "이미 있는 서버 주소예요";
export const serverRemoveLabel = (name: string) => `${name} 삭제`;
export const sessionLine = (username: string, version: string) => `${username} · ${version}`;

// 처음 연결: 1단계 서버 주소 → 2단계 API 토큰
export const STEPS_LABEL = "ArgoCD 연결 단계";
export const STEP_SERVER = "1. 서버 주소";
export const STEP_TOKEN = "2. API 토큰";
export const SERVER_HELP = "연결할 ArgoCD 서버 주소를 넣어 주세요. ArgoCD 웹 화면을 여는 주소와 같아요.";
export const tokenFor = (name: string, url: string) => `${name} (${url})`;

// 토큰
export const TOKEN_INVALID = "ArgoCD 토큰이 만료됐거나 맞지 않아요. 새 토큰을 넣어 주세요";
export const TOKEN_MISSING = "이 ArgoCD 서버의 토큰을 넣어 주세요";
export const TOKEN_LABEL = "API 토큰";
export const TOKEN_SUBMIT = "연결";
export const TOKEN_CANCEL = "취소";
export const TOKEN_CHANGE = "토큰 바꾸기";
export const TOKEN_FORGET = "토큰 지우기";
export const TOKEN_HELP = "ArgoCD UI의 Settings → Accounts → 계정 → Tokens에서 만들거나, argocd account generate-token 으로 만들어 붙여 넣어요. 토큰은 이 Mac의 키체인에만 저장해요.";
export const TOKEN_HTTP_WARNING = "이 서버는 http:// 라서 토큰이 암호화되지 않은 채 오가요. 믿을 수 있는 내부망에서만 쓰세요.";

// 목록
export const ARGO_SYNC_GROUP = "Sync 상태";
export const ARGO_HEALTH_GROUP = "Health 상태";
export const ARGO_SYNC_STATUSES = ["Synced", "OutOfSync", "Unknown"] as const;
export const ARGO_HEALTH_STATUSES = ["Healthy", "Progressing", "Degraded", "Suspended", "Missing", "Unknown"] as const;
export const ARGO_PROJECT = "프로젝트";
export const ARGO_SEARCH = "이름·레이블·네임스페이스 검색";
// 거르기: 환경 칩, 여러 개 고르는 목록(대상 클러스터·프로젝트), 레이블
export const ARGO_ENV_GROUP = "환경";
export const ARGO_CLUSTER_FILTER = "클러스터";
export const argoPickButton = (label: string, picked: number) => `${label}: ${picked === 0 ? "전체" : `${picked}개`}`;
export const ARGO_PICK_CLEAR = "선택 해제";
export const ARGO_LABEL_FILTER = "레이블 필터";
export const ARGO_LABEL_PLACEHOLDER = "레이블 (key=value)";
export const ARGO_LABEL_SUGGESTIONS = "레이블 후보";
export const argoLabelRemove = (text: string) => `${text} 빼기`;
// 환경 이름과 어디서 읽었는지(칸에 마우스를 올리면 보인다)
export const ARGO_ENV_TEXT: Record<ArgoEnv, string> = { dev: "dev", stg: "stg", prd: "prd", ops: "ops", demo: "demo", preview: "preview", unknown: "미분류" };
export const ARGO_ENV_SOURCE: Record<ArgoEnvSource | "none", string> = {
  label: "레이블에서 읽었어요",
  name: "이름에서 추정했어요",
  namespace: "네임스페이스에서 추정했어요",
  cluster: "대상 클러스터에서 추정했어요",
  none: "환경을 알 수 없어요",
};
export const H_ARGO_ENV = "환경";
// 묶기: 1단계("묶기")와 그 안의 2단계("그 안에서")
export const ARGO_GROUP_BY = "묶기";
export const ARGO_GROUP_THEN = "그 안에서";
export const ARGO_GROUP_NONE = "없음";
export const ARGO_GROUP_SET = "ApplicationSet";
export const ARGO_GROUP_ENV = "환경";
export const ARGO_GROUP_CLUSTER = "대상 클러스터";
export const ARGO_GROUP_PROJECT = "프로젝트";
export const ARGO_GROUP_NAMESPACE = "네임스페이스";
export const argoGroupLabel = (key: string) => `레이블: ${key}`;
export const ARGO_NO_CLUSTER = "(대상 없음)";
export const ARGO_NO_PROJECT = "(프로젝트 없음)";
export const ARGO_NO_NAMESPACE = "(네임스페이스 없음)";
export const ARGO_NO_LABEL = "(레이블 없음)";
export const ARGO_NO_APPS = "Application이 없어요";
export const ARGO_NO_MATCH = "조건에 맞는 Application이 없어요";
export const ARGO_UNGROUPED = "ApplicationSet 없음";
export const ARGO_APPS_LABEL = "Application 목록";
export const argoAppCount = (n: number) => `Application ${n}개`;
export const argoGenerators = (g: string) => `generator: ${g}`;
export const H_ARGO_DEST = "대상";
export const H_ARGO_OPERATION = "작업";
export const H_ARGO_REVISION = "Revision";
export const H_ARGO_LAST_SYNC = "마지막 동기화";
export const H_ARGO_AUTO = "자동";
export const ARGO_AUTO_ON = "켜짐";
export const ARGO_AUTO_OFF = "꺼짐";
export const ARGO_IN_CLUSTER = "이 클러스터";
export const argoErrors = (n: number) => `오류 ${n}`;
export const argoWarnings = (n: number) => `경고 ${n}`;
// 묶음 머리의 요약 칩(앱 하나는 한 칸으로만 센다)
export const argoOutOfSync = (n: number) => `OutOfSync ${n}`;
export const argoCaution = (n: number) => `주의 ${n}`;
export const argoOk = (n: number) => `정상 ${n}`;
// 정상은 접어서 문제를 먼저 보인다
export const argoOkApps = (n: number) => `정상 Application ${n}개`;
export const ARGO_EXPAND_ALL = "모두 펼치기";
export const ARGO_FOLD_OK = "정상 접기";

// 상세
export const ARGO_DETAIL_LABEL = "Application 상세";
export const TAB_ARGO_OVERVIEW = "개요";
export const TAB_ARGO_RESOURCES = "리소스";
export const TAB_ARGO_HISTORY = "이력";
export const TAB_ARGO_RAW = "YAML/JSON";
export const ARGO_REFRESH = "Refresh";
export const ARGO_HARD_REFRESH = "Hard refresh";
export const ARGO_SYNC = "Sync…";
export const ARGO_REFRESH_DONE = "Refresh를 요청했어요";
export const ARGO_SYNC_DONE = "동기화를 시작했어요";
export const ARGO_SYNC_RUNNING = "동기화가 진행 중이에요";
export const argoRefreshPending = (v: string) => `Refresh 요청(${v})을 컨트롤러가 아직 처리하지 않았어요`;
export const ARGO_SYNC_TITLE = "동기화";
export const ARGO_SYNC_CONFIRM = "동기화";
export const ARGO_SYNC_NOTE = "소스의 목표 리비전과 맞추도록 리소스를 적용해요";
export const ARGO_PRUNE = "Prune";
export const ARGO_PRUNE_HINT = "소스에 없는 리소스를 지워요";
export const ARGO_DRY_RUN = "Dry run";
export const ARGO_DRY_RUN_HINT = "적용하지 않고 결과만 확인해요";
export const ARGO_CANCEL = "취소";
export const ARGO_TARGET_REVISION = "목표 리비전";
export const ARGO_APPLICATION = "Application";

export const SEC_ARGO_STATUS = "상태";
export const SEC_ARGO_OPERATION = "작업";
export const SEC_ARGO_CONDITIONS = "조건";
export const SEC_ARGO_SOURCES = "소스";
export const SEC_ARGO_DEST = "대상";
export const SEC_ARGO_POLICY = "동기화 정책";
export const SEC_ARGO_IMAGES = "이미지";
export const SEC_ARGO_FAILED = "적용하지 못한 리소스";
export const L_ARGO_SYNC = "Sync";
export const L_ARGO_HEALTH = "Health";
export const L_ARGO_PROJECT = "프로젝트";
export const L_ARGO_APPSET = "ApplicationSet";
export const L_ARGO_RECONCILED = "마지막 조정";
export const L_ARGO_REVISIONS = "Revision";
export const L_ARGO_PHASE = "단계";
export const L_ARGO_MESSAGE = "메시지";
export const L_ARGO_INITIATED = "요청자";
export const L_ARGO_STARTED = "시작";
export const L_ARGO_FINISHED = "끝";
export const L_ARGO_REPO = "저장소";
export const L_ARGO_CHART = "차트";
export const L_ARGO_PATH = "경로";
export const L_ARGO_TARGET = "목표 리비전";
export const L_ARGO_REF = "ref";
export const L_ARGO_VALUES = "values 파일";
export const L_ARGO_CLUSTER = "클러스터";
export const L_ARGO_NAMESPACE = "네임스페이스";
export const L_ARGO_AUTOMATED = "자동 동기화";
export const L_ARGO_PRUNE = "Prune";
export const L_ARGO_SELF_HEAL = "Self heal";
export const L_ARGO_OPTIONS = "옵션";
export const ARGO_AUTOMATED_USER = "자동";
export const ARGO_NO_OPERATION = "아직 동기화한 기록이 없어요";
export const ARGO_YES = "예";
export const ARGO_NO = "아니요";
export const ARGO_NO_RESOURCES = "리소스가 없어요";
export const ARGO_NO_HISTORY = "배포 이력이 없어요";
export const ARGO_HOOK = "hook";
export const ARGO_PRUNING = "삭제 예정";
export const ARGO_TREE_LABEL = "리소스 트리";
export const ARGO_SYNC_BADGE_TITLE = "Sync 상태";
export const ARGO_HEALTH_BADGE_TITLE = "Health 상태";
export const H_ARGO_ID = "ID";
export const H_ARGO_DEPLOYED = "배포";
export const H_ARGO_HOOK_PHASE = "hook 단계";

// 화면 전환(서버 화면 위쪽). 화면을 늘릴 때는 ArgoViews.tsx의 ARGO_VIEWS에 한 줄을 더한다.
export const ARGO_VIEWS_LABEL = "ArgoCD 화면";
export const ARGO_VIEW_APPS = "앱";
export const ARGO_VIEW_RESOURCES = "리소스 검색";
export const ARGO_VIEW_MAPS = "지도";
export const ARGO_VIEW_METRICS = "지표";
export const MAP_TEXT = {
  tabs: "지도 종류", matrix: "플릿 매트릭스", versions: "환경 간 버전", sets: "ApplicationSet 펼침",
  hierarchy: "app-of-apps 계층", timeline: "배포 타임라인", network: "네트워크",
  relations: "리소스 관계", listDisplay: "목록 표시", list: "목록", matrixDimension: "매트릭스 열",
  noSet: "이 앱은 ApplicationSet에서 만들지 않았어요", selected: "선택한 앱",
  cluster: "클러스터", project: "프로젝트", all: "전체", empty: "표시할 데이터가 없어요",
  driftOnly: "차이 있는 앱만", drift: "상위 환경과 달라요", cycle: "순환 참조",
  env: "환경", app: "Application", external: "외부", ingress: "Ingress", service: "Service", pod: "Pod",
  range: "기간", day: "24시간", week: "7일", month: "30일", revision: "리비전",
  initiator: "실행자", message: "메시지", noNetwork: "네트워크 관계가 있는 리소스가 없어요",
  tally: (t: { err: number; outOfSync: number; caution: number; ok: number }) => `오류 ${t.err} · OutOfSync ${t.outOfSync} · 주의 ${t.caution} · 정상 ${t.ok}`,
};
