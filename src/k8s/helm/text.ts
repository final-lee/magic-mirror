// Helm 화면 문구. 백엔드(src-tauri/src/k8s/helm/)가 보내는 문구와 겹치는 것은 같은 문장이어야 한다.

export const NAV_HELM = "Helm";
export const HELM_LABEL = "Helm 릴리스";
export const DETAIL_LABEL = "릴리스 상세";

export const FILTER_PLACEHOLDER = "이름·차트·네임스페이스로 거르기";
export const ONLY_PROBLEMS = "문제 있는 것만";
export const LIST_EMPTY = "이 네임스페이스에 Helm 릴리스가 없어요";
export const LIST_NO_MATCH = "조건에 맞는 릴리스가 없어요";
export const LOADING = "불러오는 중…";
export const PROBLEM_COUNT = (n: number) => `문제 ${n}`;
export const REFRESH_HINT = "10초마다 다시 읽어요";

export const COL_NAME = "이름";
export const COL_NAMESPACE = "네임스페이스";
export const COL_STATUS = "상태";
export const COL_CHART = "차트";
export const COL_APP_VERSION = "앱 버전";
export const COL_REVISION = "리비전";
export const COL_UPDATED = "갱신";
export const COL_DESCRIPTION = "설명";
export const UNREADABLE_ROW = "릴리스 데이터를 읽지 못했어요";

/** helm 상태 값의 설명(배지에 마우스를 올리면 보인다). 모르는 값은 그대로 보인다 */
export const STATUS_HINT: Record<string, string> = {
  deployed: "배포가 끝나 쓰는 중이에요",
  superseded: "새 리비전이 대신한 옛 리비전이에요",
  failed: "배포에 실패했어요",
  unknown: "상태를 알 수 없어요",
  uninstalled: "삭제됐고 이력만 남아 있어요",
  uninstalling: "삭제하는 중이에요",
  "pending-install": "설치가 진행 중이거나 중단됐어요",
  "pending-upgrade": "업그레이드가 진행 중이거나 중단됐어요",
  "pending-rollback": "롤백이 진행 중이거나 중단됐어요",
};
export const PENDING_NOTE = "끝나지 않은 작업이 걸려 있어요. 다른 변경은 helm이 'another operation is in progress'로 거절할 수 있어요";

export const TAB_SUMMARY = "요약";
export const TAB_VALUES = "values";
export const TAB_MANIFEST = "매니페스트";
export const TAB_HISTORY = "이력";
export const TAB_NOTES = "notes";

export const SEC_INFO = "릴리스";
export const SEC_CHART = "차트";
export const SEC_RESOURCES = "리소스";
export const SEC_HOOKS = "훅";
export const SEC_DEPENDENCIES = "의존 차트";
export const LBL_NAMESPACE = "네임스페이스";
export const LBL_STATUS = "상태";
export const LBL_REVISION = "리비전";
export const LBL_FIRST_DEPLOYED = "처음 배포";
export const LBL_LAST_DEPLOYED = "마지막 배포";
export const LBL_DESCRIPTION = "설명";
export const LBL_CHART = "차트";
export const LBL_APP_VERSION = "앱 버전";
export const LBL_HOME = "홈";
export const LBL_KUBE_VERSION = "필요한 쿠버네티스";
export const LBL_DEPRECATED = "지원 중단된 차트예요";
export const LBL_STORE = "저장소";
export const STORE_SECRET = "Secret";
export const STORE_CONFIGMAP = "ConfigMap";
export const COL_KIND = "종류";
export const COL_RESOURCE_NAME = "이름";
export const COL_OPEN = "열기";
export const OPEN_OBJECT = "워크로드 화면에서 열기";
export const NOT_OPENABLE = "이 클러스터가 내주지 않는 종류라 열 수 없어요";
export const NO_RESOURCES = "이 릴리스가 만든 리소스가 없어요";
export const NO_HOOKS = "훅이 없어요";
export const HOOK_EVENTS = (events: string[]) => events.join(", ");

export const VALUES_USER = "사용자가 준 값";
export const VALUES_USER_NOTE = "릴리스를 설치·업그레이드할 때 준 값이에요(--set, -f를 합친 것). 값은 있는 그대로 보여요";
export const VALUES_USER_EMPTY = "준 값이 없어요(차트 기본값을 써요)";
export const VALUES_COMPUTED = "계산된 값";
export const VALUES_COMPUTED_NOTE = "차트 기본값 위에 사용자가 준 값을 얹은 값이에요(helm get values --all)";
export const VALUES_EDIT = "values 편집";

export const MANIFEST_NOTE = "Secret의 값은 가려서 보여요";
export const NOTES_EMPTY = "차트가 남긴 notes가 없어요";

export const HISTORY_COL_REVISION = "리비전";
export const HISTORY_COL_STATUS = "상태";
export const HISTORY_COL_UPDATED = "갱신";
export const HISTORY_COL_CHART = "차트";
export const HISTORY_COL_APP = "앱 버전";
export const HISTORY_COL_DESCRIPTION = "설명";
export const HISTORY_VIEW = "보기";
export const HISTORY_ROLLBACK = "이 리비전으로 롤백";
export const HISTORY_CURRENT = "최신";
export const HISTORY_SHOWING = "보는 중";
export const HISTORY_UNREADABLE = "데이터를 읽지 못했어요";

export const VIEWING_OLD = (viewing: number, latest: number) => `리비전 ${viewing}을 보고 있어요(최신 ${latest}). 변경은 최신 리비전에만 할 수 있어요`;
export const VIEW_LATEST = "최신으로";

// 도구 모음
export const ACT_UPGRADE = "업그레이드";
export const ACT_ROLLBACK = "롤백";
export const ACT_UNINSTALL = "삭제";
export const ACT_INSTALL = "차트 설치";
export const ACT_PREVIEW = "미리보기";
export const ACT_CANCEL = "취소";
export const ACT_KEEP_HISTORY = "이력 남기기";
export const ACT_REVISION = "리비전";
export const ACT_NO_OTHER_REVISION = "되돌아갈 다른 리비전이 없어요";
export const CLOSE = "닫기";
export const NEED_LATEST = "최신 리비전을 보고 있을 때만 바꿀 수 있어요";
export const DENIED = (verb: string, resource: string) => `${resource}에 ${verb} 권한이 없어요`;
export const TOOL_CHECKING = "helm을 확인하는 중이에요";

// 업그레이드 창
export const UPGRADE_TITLE = (name: string) => `${name} 업그레이드`;
export const UPGRADE_NOTE = "아래 values가 사용자 값 전체가 돼요(--reset-values). 지운 키는 차트 기본값으로 돌아가요";
export const UPGRADE_CHART_STORED = "저장된 차트 그대로";
export const UPGRADE_CHART_OTHER = "다른 차트로(차트 위치 입력)";
export const UPGRADE_CHART_LABEL = "차트";
export const UPGRADE_STORED_NOTE = (chart: string) => `리비전에 저장된 ${chart} 차트를 그대로 써요. 저장소에 접속하지 않아요`;
export const VALUES_LABEL = "values (YAML)";
export const VALUES_EDITOR_LABEL = "values YAML 편집기";
export const VALUES_INVALID = "values가 올바른 YAML이 아니에요";
export const VALUES_NOT_MAP = "values는 키: 값 꼴이어야 해요";

// 차트 위치 입력
export const SRC_PATH = "로컬 경로";
export const SRC_REPO = "저장소";
export const SRC_OCI = "OCI";
export const SRC_KIND_LABEL = "차트 종류";
export const SRC_PATH_LABEL = "차트 경로";
export const SRC_PATH_HINT = "/Users/…/chart(Chart.yaml이 있는 폴더) 또는 .tgz 파일의 절대 경로";
export const SRC_REPO_URL = "저장소 주소";
export const SRC_REPO_URL_HINT = "https://charts.example.com";
export const SRC_CHART_NAME = "차트 이름";
export const SRC_CHART_NAME_HINT = "nginx";
export const SRC_OCI_REF = "OCI 주소";
export const SRC_OCI_HINT = "oci://registry.example.com/charts/web";
export const SRC_VERSION = "버전(비우면 최신)";
export const SRC_INVALID = "차트 위치를 입력해 주세요";

// 설치 창
export const INSTALL_TITLE = "차트 설치";
export const INSTALL_NAME = "릴리스 이름";
export const INSTALL_NAMESPACE = "네임스페이스";
export const INSTALL_CREATE_NAMESPACE = "네임스페이스가 없으면 만들기";
export const INSTALL_LOAD_DEFAULTS = "차트 기본값 불러오기";
export const INSTALL_LOADING_DEFAULTS = "불러오는 중…";
export const INSTALL_DEFAULTS_NOTE = "편집기를 차트의 기본 values로 채워요(지금 입력한 글은 바뀌어요)";
export const INSTALL_NAME_INVALID = "릴리스 이름은 소문자·숫자·-·.만 쓰고 53자 이하여야 해요";
export const INSTALL_NAMESPACE_INVALID = "네임스페이스는 소문자·숫자·-만 쓰고 63자 이하여야 해요";

export const RELEASE_NAME_PATTERN = /^[a-z0-9]([a-z0-9.-]{0,51}[a-z0-9])?$/;
export const NAMESPACE_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
