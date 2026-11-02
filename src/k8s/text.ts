import type { K8sGroupKind, K8sOverviewSection, K8sProblem } from "./types";

// 사용자에게 보이는 문구. 백엔드(k8s/failure.rs, k8s/kubeconfig.rs)의 상수와 같은 문장이어야 한다.

export const NO_KUBECONFIG = (paths: string[]) => `kubeconfig 파일이 없어요(${paths.join(", ")}). 터미널에서 아래 명령을 실행한 뒤 다시 열어 주세요`;
export const UNREADABLE_KUBECONFIG = (path: string, reason: string) => `kubeconfig를 읽지 못했어요(${path}): ${reason}`;
export const NO_CONTEXT = "kubeconfig에 이 클러스터의 context가 없어요. 터미널에서 아래 명령을 실행한 뒤 다시 열어 주세요";
export const updateCommand = (cluster: string, region: string, profile: string) =>
  `aws eks update-kubeconfig --name ${cluster} --region ${region} --profile ${profile}`;
export const SEVERAL_CONTEXTS = "이 클러스터를 가리키는 context가 여러 개예요. 접속할 context를 골라 주세요";
export const savedMissing = (name: string) => `저장해 둔 context ${name}이(가) kubeconfig에 없어요. 다시 골라 주세요`;
export const execMissing = (command: string) => `kubeconfig의 인증 명령(${command})을 찾지 못했어요. aws CLI가 설치돼 있는지 확인해 주세요`;
export const execFailed = (line: string) => `kubeconfig의 인증 명령이 실패했어요: ${line}`;
export const UNREACHABLE_PRIVATE = "클러스터 엔드포인트에 연결하지 못했어요. 프라이빗 엔드포인트라서 Tailscale 연결을 확인해 주세요";
export const UNREACHABLE_PUBLIC = "클러스터 엔드포인트에 연결하지 못했어요. 엔드포인트의 허용 CIDR에 이 컴퓨터의 IP가 있는지 확인해 주세요";
export const UNREACHABLE_BOTH = "클러스터 엔드포인트에 연결하지 못했어요. Tailscale 연결이나 엔드포인트의 허용 CIDR을 확인해 주세요";
export const TLS_FAILED = "클러스터 인증서를 확인하지 못했어요";
export const UNAUTHORIZED = "클러스터가 이 신원을 알아보지 못했어요. EKS access entry나 aws-auth ConfigMap에 등록돼 있는지 확인해 주세요";
export const NOT_OPENED = "먼저 연결해 주세요";
export const IDENTITY_FALLBACK = "이 클러스터에서는 신원을 물어볼 수 없어 kubeconfig의 사용자 이름을 보여줘요";
export const profileMismatch = (execProfile: string, profile: string) => `kubeconfig는 프로필 ${execProfile}로 접속해요(앱에서 고른 프로필: ${profile})`;
export const RULES_INCOMPLETE = "이 네임스페이스의 권한 목록이 완전하지 않아요. 버튼은 켜 두고 실제 요청에서 서버가 판단해요";

export const tabTitle = (cluster: string) => `☸️ ${cluster}`;

export const LABEL_CONTEXT = "context";
export const LABEL_IDENTITY = "신원";
export const LABEL_GROUPS = "그룹";
export const LABEL_NAMESPACE = "네임스페이스";
export const ALL_NAMESPACES = "모든 네임스페이스";
export const RECONNECT = "다시 연결";

export const STATE_CONNECTING = "연결 중…";
export const STATE_CONNECTED = "연결됨";
export const STATE_DISCONNECTED = "연결 안 됨";

export const NAV_MY_PERMISSIONS = "내 권한";

export const HEADER_VERBS = "동작";
export const HEADER_API_GROUP = "API 그룹";
export const HEADER_RESOURCE = "리소스";
export const HEADER_NAME = "이름";
export const CORE_GROUP = "(core)";
export const WILDCARD = "모두";

export const COPY = "복사";
export const COPIED = "복사했어요";
export const RECHECK = "다시 확인";

export const SETTINGS_KUBECONFIG_LABEL = "kubeconfig 경로";
export const SETTINGS_KUBECONFIG_PLACEHOLDER = "비우면 KUBECONFIG 또는 ~/.kube/config";

export const ALL_NAMESPACES_NOTE = "모든 네임스페이스를 고르면 default 네임스페이스 기준으로 보여줘요";

export const BAR_LABEL = "연결 정보";
export const NAV_LABEL = "클러스터 메뉴";

// K2
export const NAV_OVERVIEW = "개요";
export const NAV_ALL = "All";
export const NAV_EVENTS = "이벤트";
export const NAV_BOOKMARKS_LABEL = "북마크";
export const bookmarkAdd = (kind: string) => `${kind} 북마크`;
export const bookmarkRemove = (kind: string) => `${kind} 북마크 해제`;
export const BOOKMARK_MISSING = "이 클러스터에는 이 리소스 종류가 없어요";
export const RESIZE_LANE = "너비 조절";

export const CAT_WORKLOADS = "워크로드";
export const CAT_NETWORK = "네트워크";
export const CAT_CONFIG = "설정";
export const CAT_STORAGE = "저장소";
export const CAT_CLUSTER = "클러스터";
export const CAT_CUSTOM = "사용자 정의 리소스";
export const KIND_TREE_LABEL = "리소스 종류";

export const FILTER_PLACEHOLDER = "이름 또는 레이블 셀렉터(app=web,tier!=db)";
export const ONLY_PROBLEMS = "문제 있는 것만";
export const LIST_EMPTY = "항목이 없어요";
export const LIST_NO_MATCH = "조건에 맞는 항목이 없어요";
export const BAD_SELECTOR = "레이블 셀렉터를 해석하지 못했어요";
export const LOADING = "불러오는 중…";

export const COL_NAME = "이름";
export const COL_NAMESPACE = "네임스페이스";
export const COL_PROBLEMS = "이상";
export const COL_AGE = "나이";
/** 종류별 값의 열 이름. 키는 백엔드 read/values.rs의 키와 같다 */
export const COLUMN_LABELS: Record<string, string> = {
  ready: "준비", status: "상태", restarts: "재시작", node: "노드", ip: "IP", upToDate: "최신", available: "사용 가능",
  desired: "원하는 수", current: "현재", completions: "완료", schedule: "일정", suspend: "일시정지", active: "실행 중",
  lastSchedule: "마지막 실행", type: "타입", clusterIp: "클러스터 IP", externalIp: "외부 주소", ports: "포트", class: "클래스",
  hosts: "호스트", address: "주소", podSelector: "Pod 셀렉터", policyTypes: "정책 종류", endpoints: "엔드포인트", keys: "키",
  roleArn: "IAM 역할", volume: "볼륨", capacity: "용량", accessModes: "접근 모드", storageClass: "스토리지 클래스",
  reclaimPolicy: "회수 정책", claim: "클레임", provisioner: "프로비저너", volumeBindingMode: "바인딩 모드", default: "기본",
  version: "kubelet", instanceType: "인스턴스 타입", zone: "AZ", group: "노드그룹",
};
export const PROBLEM_LABELS: Record<K8sProblem, string> = {
  crashLoopBackOff: "CrashLoopBackOff",
  imagePullBackOff: "ImagePullBackOff",
  pending: "Pending",
  oomKilled: "OOMKilled",
  notReady: "준비 안 됨",
};

export const TAB_SUMMARY = "요약";
export const TAB_YAML = "YAML";
export const TAB_LOGS = "로그";
export const LOG_CONTAINER = "컨테이너";
export const LOG_PREVIOUS = "이전 컨테이너";
export const LOG_FOLLOW = "따라가기";
export const LOG_TAIL = "처음에 받을 줄 수";
export const logTailOption = (n: number) => `최근 ${n.toLocaleString("ko-KR")}줄`;
export const LOG_SEARCH = "로그에서 찾기";
export const logMatches = (n: number) => `${n.toLocaleString("ko-KR")}줄 일치`;
export const LOG_PAUSE = "일시정지";
export const LOG_RESUME = "이어 보기";
export const logPending = (n: number) => `${n.toLocaleString("ko-KR")}줄 대기 중`;
export const LOG_TO_BOTTOM = "맨 아래로";
export const LOG_OPENING = "로그를 여는 중…";
export const LOG_EMPTY = "로그가 없어요";
export const LOG_ENDED = "로그가 끝났어요";
export const logTrimmed = (n: number) => `오래된 줄은 지우고 최근 ${n.toLocaleString("ko-KR")}줄만 보관해요`;
export const LOG_RESTART = "다시 열기";
export const LOG_VIEW_LABEL = "보기 방식";
export const LOG_VIEW_PRETTY = "JSON 정리";
export const LOG_VIEW_RAW = "원문";
export const LOG_FIELDS_SHOW = "필드 펼치기";
export const LOG_FIELDS_HIDE = "필드 접기";
export const LOG_COPY_JSON = "JSON 복사";
export const LOG_LEVELS = "레벨 거르기";
export const LOG_LEVEL_NAMES = { error: "오류", warn: "경고", info: "정보", debug: "디버그", other: "기타" } as const;
export const LOG_LEVEL_OTHER_TITLE = "레벨을 알 수 없는 줄";
export const LOG_LEVEL_NONE = "고른 레벨의 줄이 없어요";
export const SEC_OWNERS = "소유자";
export const SEC_CHILDREN = "소유한 리소스";
export const SEC_CONTAINERS = "컨테이너";
export const SEC_CONDITIONS = "상태 조건";
export const SEC_EVENTS = "이벤트";
export const SEC_LABELS = "레이블";
export const SEC_ANNOTATIONS = "어노테이션";
export const SEC_SECRET_KEYS = "Secret 키";
export const BACK = "뒤로";
export const CLOSE = "닫기";
export const openNode = (name: string) => `노드 ${name} 보기`;
export const OPEN_IN_IAM = "IAM에서 열기";
export const CREATED_AT = "만든 시각";
export const CHILDREN_TRUNCATED = "처음 500개만 보여줘요";
export const NO_RECENT_EVENTS = "최근 이벤트가 없어요";
export const H_IMAGE = "이미지";
export const H_STATE = "상태";
export const H_RESTARTS = "재시작";
export const H_LAST_TERMINATION = "마지막 종료";
export const INIT_MARK = "init";
export const H_KIND = "종류";
export const H_REASON = "이유";
export const H_MESSAGE = "메시지";
export const YAML_SECRET_NOTE = "Secret 값은 ••••로 가렸어요";
export const DETAIL_LABEL = "상세";

export const H_KEY = "키";
export const H_SIZE = "크기";
export const H_VALUE = "값";
export const byteSize = (n: number) => `${n}바이트`;
export const SHOW_VALUE = "값 보기";
export const HIDE_VALUE = "숨기기";
export const BASE64_NOTE = "텍스트가 아니라서 base64로 보여줘요";
export const NO_SECRET_PERMISSION = "이 네임스페이스의 secrets get 권한이 없어요";

export const WARNINGS_ONLY = "Warning만 보기";
export const H_TIME = "시각";
export const H_OBJECT = "대상";
export const H_COUNT = "횟수";
export const NO_EVENTS = "이벤트가 없어요";

export const SEC_CLUSTER = "클러스터";
export const SEC_NODES = "노드";
export const SEC_NODEGROUPS = "노드그룹";
export const SEC_FARGATE = "Fargate 프로필";
export const SEC_NODEPOOLS = "Karpenter NodePool";
export const SEC_ADDONS = "애드온";
export const SEC_UPGRADE = "업그레이드 점검";
export const REFRESH = "새로 고침";
export const L_VERSION = "버전";
export const L_PLATFORM = "플랫폼 버전";
export const L_STATUS = "상태";
export const L_ENDPOINT = "엔드포인트";
export const L_PUBLIC = "퍼블릭";
export const L_PRIVATE = "프라이빗";
export const L_CIDRS = "허용 CIDR";
export const L_LOGGING = "컨트롤 플레인 로깅";
export const L_SECRETS_ENCRYPTION = "Secret 암호화";
export const L_OIDC = "OIDC 공급자";
export const L_AUTH_MODE = "인증 모드";
export const ON = "켜짐";
export const OFF = "꺼짐";
export const NONE = "없음";
export const H_INSTANCE_TYPE = "인스턴스 타입";
export const H_ZONE = "AZ";
export const H_NODEGROUP = "노드그룹";
export const H_KUBELET = "kubelet";
export const H_CPU_REQUESTED = "CPU 요청";
export const H_MEMORY_REQUESTED = "메모리 요청";
export const H_CPU_USED = "CPU 사용";
export const H_MEMORY_USED = "메모리 사용";
export const GROUP_KIND_LABELS: Record<K8sGroupKind, string> = { managed: "관리형", fargate: "Fargate", karpenter: "Karpenter", self: "자체 관리" };
export const CORDONED = "스케줄 중지";
export const NO_METRICS = "metrics-server가 없어 사용량은 보여주지 않아요";
export const REQUESTS_PARTIAL = "Pod가 많아 요청량은 처음 10,000개 Pod로만 계산했어요";
export const H_VERSION = "버전";
export const H_CAPACITY_TYPE = "용량 타입";
export const H_SIZE_RANGE = "크기(최소/원하는/최대)";
export const H_ADDON = "애드온";
export const H_CURRENT_VERSION = "현재 버전";
export const H_LATEST_VERSION = "최신 버전";
export const H_ISSUES = "문제";
export const UP_TO_DATE = "최신이에요";
export const SUB_INSIGHTS = "Upgrade Insights";
export const SUB_REMOVED = "제거되는 API";
export const SUB_SKEW = "버전 차이";
export const H_CHECK = "점검";
export const NO_INSIGHTS = "Upgrade Insights 결과가 없어요";
export const removedTitle = (version: string) => `${version}에서 제거되는 API를 쓰는 리소스`;
export const H_CURRENT_API = "지금 API";
export const H_NEW_API = "바꿀 API";
export const noRemoved = (version: string) => `${version}에서 제거되는 API를 쓰는 리소스가 없어요`;
export const skewText = (n: number) => `컨트롤 플레인보다 ${n} 마이너 버전 낮아요`;
export const NO_SKEW = "모든 노드가 컨트롤 플레인과 같은 버전이에요";
export const gapText = (section: string) => `이 부분을 읽지 못했어요: ${section}`;
export const SECTION_LABELS: Record<K8sOverviewSection, string> = {
  cluster: "클러스터", nodes: "노드", metrics: "사용량", nodegroups: "노드그룹", fargate: "Fargate 프로필",
  nodePools: "Karpenter NodePool", addons: "애드온", insights: "Upgrade Insights", removedApis: "제거되는 API",
};

export const CHANGE_MODE = "변경";
export const CHANGE_LOG = "변경 기록";
export const CHANGE_DONE = "변경을 적용했어요";
export const CHANGE_PREVIEW = "변경 미리보기";
export const CHANGE_UNDO_PREVIEW = "되돌리기 미리보기";
export const CHANGE_LOADING = "미리보기를 불러오는 중이에요…";
export const CHANGE_STALE = "미리보기 이후 바뀌었어요. 미리보기를 다시 받아 주세요.";
export const CHANGE_RETRY = "미리보기 다시 받기";
export const CHANGE_CANCEL = "취소";
export const CHANGE_APPLY = "적용";
export const CHANGE_APPLYING = "적용 중…";
export const CHANGE_CALLS = "API 호출";
export const CHANGE_BODY = "본문";
export const CHANGE_DIFF = "필드 변경";
export const CHANGE_IMPACT = "영향";
export const CHANGE_WARNINGS = "경고";
export const CHANGE_CONFIRM = "확인할 이름";
export const CHANGE_SCALE = "크기 조절";
export const CHANGE_REPLICAS = "복제본 수";
export const CHANGE_RESTART = "롤아웃 재시작";
export const CHANGE_ROLLOUT_UNDO = "롤아웃 되돌리기";
export const CHANGE_REVISION = "리비전";
export const CHANGE_DELETE = "삭제";
export const CHANGE_RERUN = "재실행";
export const CHANGE_RUN_NOW = "바로 실행";
export const CHANGE_JOB_NAME = "새 Job 이름";
export const CHANGE_SUSPEND = "일시정지";
export const CHANGE_RESUME = "재개";
export const CHANGE_UNDO = "되돌리기";
export const CHANGE_SUCCESS = "성공";
export const CHANGE_FAILED = "실패";
export const CHANGE_NO_LOG = "변경 기록이 없어요";
export const CHANGE_DENIED = (verb: string, resource: string) => `${resource}에 ${verb} 권한이 없어요`;
export const CHANGE_PATH = "경로";
export const CHANGE_BEFORE = "이전";
export const CHANGE_AFTER = "이후";
export const ROLLOUT_PROGRESS = (ready: number, desired: number) => `새 Pod ${ready}/${desired} 준비`;
export const ROLLOUT_WAITING = "롤아웃 상태를 기다리는 중이에요";
export const CHANGE_CONFLICTS = "필드 충돌";
export const CHANGE_CONFLICT_FIELD = "필드";
export const CHANGE_CONFLICT_MANAGER = "소유 manager";
export const CHANGE_CONFLICT_BLOCK = "다른 manager와 충돌해서 적용할 수 없어요. 강제 적용으로 다시 미리보기 해 주세요";
export const CHANGE_FORCE = "강제 적용으로 다시 미리보기";
export const CHANGE_FORCE_NOTE = "강제 적용은 다른 manager가 가진 필드를 가져와요. 적용하려면 이름을 입력해야 해요";

export const YAML_EDIT = "편집";
export const YAML_EDITOR_LABEL = "YAML 편집기";
export const YAML_PREVIEW = "미리보기";
export const YAML_CANCEL_EDIT = "편집 취소";
export const YAML_EDIT_NOTE = "서버가 채우는 필드(status, managedFields, uid, resourceVersion, creationTimestamp, generation)는 빼고 보여 줘요. 미리보기는 서버에서 먼저 적용해 보고(dry-run) 현재 객체와의 차이를 보여 줘요.";
export const YAML_SYNTAX_ERROR = "YAML 문법 오류가 있어요";
export const YAML_PROBLEMS = "YAML 문법 오류";
export const yamlProblem = (line: number, column: number, message: string) => `${line}줄 ${column}칸: ${message}`;
export const YAML_NOT_OBJECT = "객체가 아닌 문서예요";
export const YAML_NO_KIND = "apiVersion과 kind가 필요해요";
export const YAML_NO_NAME = "metadata.name이 필요해요";
export const YAML_NO_NAMESPACE = "네임스페이스를 정해 주세요. metadata.namespace를 적거나 위에서 네임스페이스를 골라 주세요";
export const yamlKindUnknown = (apiVersion: string, kind: string) => `이 클러스터에 없는 종류예요: ${apiVersion} ${kind}`;
export const yamlNotNamespaced = (kind: string) => `${kind}는 네임스페이스가 없는 종류예요. metadata.namespace를 빼 주세요`;
export const YAML_IDENTITY_CHANGED = "종류, 이름, 네임스페이스는 바꿀 수 없어요. 새 객체는 'YAML로 만들기'를 써 주세요";
export const YAML_ONE_DOCUMENT = "편집에서는 문서를 하나만 쓸 수 있어요";

export const SECRET_EDIT_NOTE = "값은 가려져 있어요. 키마다 '값 보기'로 읽어서 고치거나 '새 값 입력'으로 바꿀 수 있어요. 고치지 않은 키는 그대로 둬요. 값은 기록하지 않아서 Secret 변경은 되돌릴 수 없어요.";
export const SECRET_NEW_VALUE = "새 값 입력";
export const SECRET_VALUE_LABEL = (key: string) => `${key} 값`;
export const SECRET_KEEP = "그대로 두기";
export const SECRET_BINARY_NOTE = "바이너리 값은 여기서 고칠 수 없어요(새 값 입력으로는 바꿀 수 있어요)";
export const SECRET_ADD_KEY = "키 추가";
export const SECRET_NEW_KEY_NAME = "새 키 이름";
export const SECRET_NEW_KEY_VALUE = "새 키의 값";
export const SECRET_ADD = "추가";

export const YAML_CREATE = "YAML로 만들기";
export const YAML_CREATE_HINT = "YAML을 붙여 넣어 주세요. 문서 여러 개는 ---로 나눠요. 네임스페이스가 없는 문서는 위에서 고른 네임스페이스로 만들어요.";
export const YAML_CREATE_EMPTY = "만들 문서가 없어요";
export const yamlTooMany = (max: number) => `한 번에 ${max}개까지만 만들 수 있어요`;
export const yamlDocumentError = (index: number, message: string) => `${index}번째 문서: ${message}`;

export const BATCH_TITLE = "문서별 미리보기";
export const BATCH_UNDO_TITLE = "되돌리기 미리보기(문서별)";
export const batchItem = (index: number, kind: string, name: string) => `${index}. ${kind} ${name}`;
export const BATCH_APPLIED = "적용함";
export const BATCH_FAILED = "실패";
export const BATCH_SKIPPED = "건너뜀";
export const BATCH_LOADING = "미리보기 중…";
export const BATCH_PREVIEW_FAILED = "미리보기에 실패했어요";
export const BATCH_APPLY = (count: number) => `${count}개 적용`;
export const BATCH_PARTIAL = (count: number) => `미리보기가 되지 않은 문서 앞의 ${count}개만 먼저 적용해요. 적용한 뒤 나머지를 다시 미리보기 해요`;
export const BATCH_STOPPED = "적용하다 멈췄어요. 이미 적용한 문서는 그대로 남아 있어요";
export const BATCH_UNDO_APPLIED = "적용한 것 되돌리기";
export const BATCH_UNDO_UNAVAILABLE = "되돌릴 수 없는 문서가 있어요";
export const BATCH_CLOSE = "닫기";
export const BATCH_DONE = "모두 적용했어요";
export const CHANGE_WHOLE_OBJECT = "객체 전체";
export const YAML_DOCUMENT_ERRORS = "문서 오류";
