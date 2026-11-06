/** 앱 관리·ApplicationSet 화면의 글. 문구는 여기에만 둔다 */

// 공통
export const MANAGE_PREVIEW = "미리 보기";
export const MANAGE_CANCEL = "취소";
export const MANAGE_LOADING = "불러오는 중이에요";
export const MANAGE_NO_CHANGE = "바뀐 내용이 없어요";
export const MANAGE_DENIED = "이 작업을 할 권한이 없어요";
export const manageYamlLine = (line: number, message: string) => `${line}번째 줄: ${message}`;
export const MANAGE_YAML_EMPTY = "내용이 비었어요";
export const MANAGE_YAML_NOT_MAP = "키: 값 형태여야 해요";
export const MANAGE_YAML_ONE_DOC = "문서는 하나만 넣어 주세요";

// 관리 탭
export const TAB_ARGO_MANAGE = "관리";
export const MANAGE_VIEW_LABEL = "관리 항목";
export const MANAGE_VIEW_FORM = "설정 바꾸기";
export const MANAGE_VIEW_YAML = "YAML 편집";
export const MANAGE_VIEW_NOTIFY = "알림 구독";
export const MANAGE_VIEW_DELETE = "앱 삭제";

// 설정 바꾸기(폼)
export const MANAGE_FORM_POLICY = "동기화 정책";
export const MANAGE_AUTOMATED = "자동 동기화";
export const MANAGE_PRUNE = "삭제된 리소스 정리(prune)";
export const MANAGE_SELF_HEAL = "클러스터에서 바뀐 것 되돌리기(selfHeal)";
export const MANAGE_ALLOW_EMPTY = "리소스가 하나도 없어도 허용(allowEmpty)";
export const MANAGE_SYNC_OPTIONS = "동기화 옵션";
export const MANAGE_OPTIONS: [string, string][] = [
  ["CreateNamespace=true", "네임스페이스 만들기"],
  ["PruneLast=true", "정리는 마지막에"],
  ["ApplyOutOfSyncOnly=true", "어긋난 리소스만 적용"],
  ["ServerSideApply=true", "서버 측 적용"],
  ["Replace=true", "교체(replace)"],
  ["RespectIgnoreDifferences=true", "무시한 차이는 적용하지 않기"],
  ["FailOnSharedResource=true", "다른 앱과 겹치면 실패"],
  ["Validate=false", "스키마 검증 건너뛰기"],
  ["SkipDryRunOnMissingResource=true", "없는 종류는 시험 실행 건너뛰기"],
];
export const manageSourceTitle = (index: number, count: number, repo: string) => (count > 1 ? `소스 ${index + 1} · ${repo}` : `소스 · ${repo}`);
export const MANAGE_TARGET_REVISION = "목표 리비전";
export const MANAGE_HELM = "Helm";
export const MANAGE_HELM_VALUES = "values (YAML 글)";
export const MANAGE_HELM_VALUES_OBJECT = "valuesObject (YAML)";
export const MANAGE_HELM_PARAMS = "파라미터";
export const MANAGE_PARAM_NAME = "이름";
export const MANAGE_PARAM_VALUE = "값";
export const MANAGE_PARAM_FORCE = "문자열로 고정";
export const MANAGE_PARAM_ADD = "파라미터 추가";
export const MANAGE_REMOVE = "삭제";
export const MANAGE_KUSTOMIZE = "Kustomize";
export const MANAGE_KUSTOMIZE_IMAGES = "이미지 (예: nginx=nginx:1.27)";
export const MANAGE_IMAGE_ADD = "이미지 추가";
export const MANAGE_NAME_PREFIX = "이름 앞에 붙이기(namePrefix)";
export const MANAGE_NAME_SUFFIX = "이름 뒤에 붙이기(nameSuffix)";
export const MANAGE_NO_SOURCES = "이 앱에는 고칠 소스가 없어요";
export const MANAGE_FORM_PREVIEW = "바뀐 내용 미리 보기";
export const manageFormProblem = (code: string) => {
  const [index, kind] = code.split(":");
  const where = `소스 ${index}`;
  if (kind === "valuesObject-yaml") return `${where}: valuesObject YAML을 읽지 못했어요`;
  if (kind === "valuesObject-shape") return `${where}: valuesObject는 키: 값 형태여야 해요`;
  return `${where}: 파라미터 이름을 입력해 주세요`;
};

// YAML 편집
export const MANAGE_YAML_TITLE = "spec 전체 편집";
export const MANAGE_YAML_HINT = "Application의 spec 전체를 바꿔요. 저장하기 전에 변경 내용을 먼저 보여 드려요.";
export const MANAGE_YAML_LABEL = "Application spec YAML";
export const MANAGE_YAML_RESET = "처음 값으로";

// 알림 구독
export const MANAGE_NOTIFY_TITLE = "알림 구독";
export const MANAGE_NOTIFY_HINT = "트리거가 일어나면 서비스로 알려요. 받는 곳이 여럿이면 ;로 이어 주세요.";
export const MANAGE_NOTIFY_NONE = "구독한 알림이 없어요";
export const MANAGE_NOTIFY_TRIGGER = "트리거";
export const MANAGE_NOTIFY_SERVICE = "서비스";
export const MANAGE_NOTIFY_RECIPIENTS = "받는 곳";
export const MANAGE_NOTIFY_ADD = "구독 추가";
export const MANAGE_NOTIFY_EDIT = "받는 곳 바꾸기";
export const MANAGE_NOTIFY_UNAVAILABLE = "서버의 알림 설정을 읽지 못해 이름을 직접 입력해요";

// 앱 삭제
export const MANAGE_DELETE_TITLE = "앱 삭제";
export const MANAGE_DELETE_FOREGROUND = "리소스까지 모두 삭제 (foreground)";
export const MANAGE_DELETE_FOREGROUND_NOTE = "관리하던 리소스가 모두 지워진 뒤에 앱이 사라져요. 가장 안전한 삭제예요.";
export const MANAGE_DELETE_BACKGROUND = "리소스까지 삭제하고 앱은 먼저 지우기 (background)";
export const MANAGE_DELETE_BACKGROUND_NOTE = "앱이 먼저 사라지고, 리소스는 뒤에서 지워져요. 지우는 도중에 실패해도 앱은 이미 없어요.";
export const MANAGE_DELETE_ORPHAN = "앱만 삭제 (리소스는 남김)";
export const MANAGE_DELETE_ORPHAN_NOTE = "클러스터의 리소스는 그대로 두고 ArgoCD가 관리만 그만둬요.";
export const MANAGE_DELETE_PICK = "삭제 방식";
export const MANAGE_DELETE_GO = "삭제 미리 보기";

// 앱 만들기
export const MANAGE_CREATE = "앱 만들기…";
export const MANAGE_CREATE_TITLE = "새 Application";
export const MANAGE_CREATE_HINT = "YAML을 채운 뒤 미리 보기에서 서버에 보낼 내용을 확인해요. 이미 있는 이름이면 만들지 않아요.";
export const MANAGE_CREATE_PROJECT = "프로젝트";
export const MANAGE_CREATE_DEST = "대상";
export const MANAGE_CREATE_PICK = "고르면 YAML에 넣어요";
export const MANAGE_CREATE_LABEL = "Application YAML";
export const MANAGE_CREATE_NOT_APP = "kind가 Application이어야 해요";
export const MANAGE_CREATE_NAME = "metadata.name을 입력해 주세요";
export const MANAGE_CREATE_NO_SPEC = "spec이 있어야 해요";

// ApplicationSet 상세
export const APPSET_DETAIL_LABEL = "ApplicationSet 상세";
export const APPSET_OPEN = "ApplicationSet 열기";
export const APPSET_KIND = "ApplicationSet";
export const APPSET_TAB_OVERVIEW = "개요";
export const APPSET_TAB_APPS = "만든 앱";
export const APPSET_TAB_TREE = "트리";
export const APPSET_TAB_EVENTS = "Events";
export const APPSET_TAB_YAML = "YAML";
export const APPSET_TAB_PREVIEW = "미리 보기";
export const APPSET_SAVE = "저장";
export const APPSET_DELETE = "삭제…";
export const APPSET_CONDITIONS = "조건";
export const APPSET_NO_CONDITIONS = "조건이 아직 없어요";
export const APPSET_GENERATORS = "Generator";
export const APPSET_NO_GENERATORS = "generator가 없어요";
export const APPSET_TEMPLATE = "템플릿";
export const APPSET_T_NAME = "앱 이름";
export const APPSET_T_PROJECT = "프로젝트";
export const APPSET_T_SOURCES = "소스";
export const APPSET_T_DEST = "대상";
export const APPSET_GO_TEMPLATE = "Go 템플릿";
export const APPSET_PRESERVE = "삭제해도 만든 앱 남김";
export const APPSET_STRATEGY = "Progressive Sync";
export const APPSET_NO_STRATEGY = "단계별 배포를 쓰지 않아요(한꺼번에 올려요)";
export const appSetStep = (n: number) => `${n}단계`;
export const APPSET_STEP_MATCH = "대상";
export const APPSET_STEP_MAX = "한 번에";
export const APPSET_STEP_ALL = "모든 앱";
export const APPSET_COL_APP = "앱";
export const APPSET_COL_STATUS = "상태";
export const APPSET_COL_MESSAGE = "메시지";
export const APPSET_NO_APPS = "만든 앱이 없어요";
export const APPSET_NO_EVENTS = "이벤트가 없어요";
export const APPSET_NO_TREE = "트리 항목이 없어요";
export const APPSET_COL_SYNC = "Sync";
export const APPSET_COL_HEALTH = "Health";
export const APPSET_COL_DEST = "대상";
export const APPSET_COL_REVISION = "리비전";
export const APPSET_EVENT_TYPE = "종류";
export const APPSET_EVENT_REASON = "이유";
export const APPSET_EVENT_MESSAGE = "메시지";
export const APPSET_EVENT_LAST = "마지막";
export const APPSET_EVENT_COUNT = "횟수";

// ApplicationSet 편집·미리 보기·저장·삭제
export const APPSET_EDIT_LABEL = "ApplicationSet YAML";
export const APPSET_EDIT_HINT = "고친 spec이 만들 앱을 서버에 계산해 보고, 지금 앱과 비교해요. 미리 보기만으로는 아무것도 저장하지 않아요.";
export const APPSET_GENERATE = "미리 보기 계산";
export const APPSET_GENERATING = "계산하는 중이에요";
export const APPSET_RESET = "처음 값으로";
export const APPSET_UNCHANGED = "저장된 것과 같아요";
export const APPSET_PREVIEW_FIRST = "고친 뒤 미리 보기 계산을 눌러 보세요";
export const appSetCounts = (added: number, removed: number, changed: number, same: number) => `추가 ${added} · 삭제 ${removed} · 변경 ${changed} · 그대로 ${same}`;
export const APPSET_KIND_TEXT = { added: "추가", removed: "삭제", changed: "변경", same: "그대로" } as const;
export const APPSET_SHOW_SAME = "그대로인 앱도 보기";
export const APPSET_STALE = "미리 본 뒤에 YAML을 고쳤어요. 다시 계산해 주세요";
export const MANAGE_NAME_LOCKED = "ApplicationSet 이름은 바꿀 수 없어요";
export const APPSET_DELETE_TITLE = "ApplicationSet 삭제";
export const APPSET_DELETE_WARN = "이 ApplicationSet이 만든 앱도 함께 삭제돼요. 앱이 관리하던 리소스도 앱 삭제 설정에 따라 지워질 수 있어요.";
export const APPSET_DELETE_PRESERVED = "이 ApplicationSet은 삭제해도 만든 앱을 남기도록 설정돼 있어요(preserveResourcesOnDeletion).";
export const APPSET_DELETE_CONTINUE = "삭제 미리 보기";
export const APPSET_DELETE_ABOUT = (count: number) => `지금 만든 앱 ${count}개가 영향을 받아요.`;
export const CLOSE_LABEL = "닫기";
