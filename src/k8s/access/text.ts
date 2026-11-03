import type { AccessSection, Cell, SubjectKind } from "./types";

// ── 메뉴·탭 ──
export const NAV_ACCESS = "접근";
export const ACCESS_ICON = "🛡";
export const ACCESS_LABEL = "접근";
export const TAB_IDENTITIES = "신원";
export const TAB_MATRIX = "권한 표";
export const TAB_WHO_CAN = "누가 할 수 있나";
export const TAB_WORKLOAD = "워크로드 신원";
export const TABS_LABEL = "접근 화면";

/** 모든 접근 화면의 맨 위 안내 */
export const SCOPE_NOTE = "RBAC과 EKS access policy만 계산해요";
export const SCOPE_NOTE_DETAIL = "노드 인가, 승인 컨트롤러, 다른 인가 웹훅, IAM 정책은 보지 않아요.";
export const MY_PERMISSIONS = "내 권한 보기";
export const MY_PERMISSIONS_TITLE = "지금 접속한 신원이 이 네임스페이스에서 할 수 있는 것(내 권한)으로 가요";
export const REFRESH = "다시 읽기";
export const LOADING = "읽는 중이에요";
export const NONE = "없음";
export const CLOSE = "닫기";
export const OPEN_IAM = "IAM에서 열기";
export const fetchedAt = (iso: string) => `${iso.replace("T", " ").replace("Z", "")} 기준`;

// ── 읽지 못한 부분 ──
export const SECTION_LABELS: Record<AccessSection, string> = {
  cluster: "클러스터 설정(인증 모드)",
  accessEntries: "EKS access entry",
  awsAuth: "aws-auth ConfigMap",
  rbac: "Role·ClusterRole·바인딩",
  namespaces: "네임스페이스",
  serviceAccounts: "ServiceAccount",
  pods: "Pod",
  podIdentity: "Pod Identity 연결",
  iamRoles: "IAM 역할",
};
export const gapText = (section: string) => `이 부분을 읽지 못했어요: ${section}`;
export const RBAC_MISSING = "Role과 바인딩을 읽지 못해서 RBAC 권한은 계산하지 못했어요. 아래 표는 EKS access policy만 반영해요.";
/** EKS API 쪽 구역(로그인은 앱 프로필, 나머지는 exec 플러그인의 프로필) */
export const EKS_SECTIONS: ReadonlySet<AccessSection> = new Set(["cluster", "accessEntries", "podIdentity", "iamRoles"]);

// ── 신원 ──
export const MODE_LABEL = "인증 모드";
export const MODE_NOTES: Record<string, string> = {
  api: "access entry만 쓰여요. aws-auth는 있어도 무시돼요.",
  apiAndConfigMap: "둘 다 쓰여요. 같은 주체가 양쪽에 있으면 access entry가 먼저예요.",
  configMap: "aws-auth ConfigMap만 쓰여요. access entry는 있어도 무시돼요.",
};
export const MODE_UNKNOWN = "인증 모드를 읽지 못해서 두 출처를 모두 유효하다고 보고 계산했어요.";
export const AWS_AUTH_NONE = "kube-system/aws-auth ConfigMap이 없어요";
export const AWS_AUTH_PRESENT = "kube-system/aws-auth ConfigMap이 있어요";
export const awsAuthAccounts = (accounts: string[]) => `mapAccounts: ${accounts.join(", ")}(이 계정의 모든 IAM 주체를 허용하는 옛 방식이에요)`;
export const SSO_GROUP_TITLE = "SSO 권한 세트로 묶기";
export const ssoGroupRow = (set: string, count: number) => `AWSReservedSSO · ${set} (역할 ${count}개)`;
export const EXPAND = "펼치기";
export const COLLAPSE = "접기";
export const NO_MAPPINGS = "연결된 IAM 주체가 없어요";
export const IDENTITIES_LABEL = "신원 연결";
export const H_PRINCIPAL = "IAM 주체";
export const H_SOURCE = "출처";
export const H_USERNAME = "쿠버네티스 사용자";
export const H_GROUPS = "그룹";
export const H_POLICIES = "access policy";
export const H_STATE = "상태";
export const H_SUMMARY = "클러스터 전체 권한";
export const SOURCE_LABELS = { accessEntry: "access entry", awsAuth: "aws-auth" } as const;
export const EFFECTIVE = "쓰여요";
export const INACTIVE = "쓰이지 않아요";
export const NOT_EVALUATED = "평가하지 못함";
export const policyScopeText = (scope: { kind: "cluster" } | { kind: "namespaces"; namespaces: string[] }) =>
  scope.kind === "cluster" ? "클러스터" : scope.namespaces.join(", ") || "네임스페이스(없음)";
export const SEE_MATRIX = "권한 표";
export const SEE_MATRIX_TITLE = "권한 표에서 이 주체를 봐요";
export const DANGLING_TITLE = "없는 역할을 가리키는 바인딩";
export const danglingText = (binding: string, role: string) => `${binding} → ${role}`;

// ── 권한 표 ──
export const MATRIX_LABEL = "권한 표";
export const CLUSTER_WIDE = "클러스터 전체";
export const CLUSTER_WIDE_TITLE = "ClusterRoleBinding으로 받은 권한만(모든 네임스페이스와 클러스터 범위 리소스)";
export const FILTER_PLACEHOLDER = "주체 이름 찾기";
export const FILTER_LABEL = "주체 이름 필터";
export const KIND_LABELS: Record<SubjectKind, string> = { iam: "IAM", user: "사용자", group: "그룹", serviceAccount: "ServiceAccount" };
export const KINDS_LABEL = "주체 종류";
export const NAMESPACES_BUTTON = (n: number) => `네임스페이스 ${n}개`;
export const NAMESPACES_LABEL = "열에 보일 네임스페이스";
export const NAMESPACES_SEARCH = "네임스페이스 찾기";
export const NAMESPACES_NONE = "맞는 네임스페이스가 없어요";
export const NAMESPACES_CLEAR = "모두 빼기";
export const NAMESPACES_FIRST = "처음 몇 개만";
export const COLUMNS_LIMIT = 8;
export const columnsLimited = (n: number) => `열은 최대 ${n}개까지 보여요`;
export const SUBJECT_COLUMN = "주체";
export const NO_ROWS = "조건에 맞는 주체가 없어요";
export const pageText = (from: number, to: number, total: number) => `${from}–${to} / ${total}`;
export const PREV = "이전";
export const NEXT = "다음";
export const PAGER_LABEL = "쪽 넘기기";

export const CELLS: Cell[] = ["read", "write", "delete", "exec", "secretRead", "rbacWrite", "escalate"];
/** 칸의 이름과 한 글자 표시 */
export const CELL_LABELS: Record<Cell, string> = {
  read: "읽기",
  write: "쓰기",
  delete: "삭제",
  exec: "exec·attach·port-forward",
  secretRead: "Secret 읽기",
  rbacWrite: "RBAC 변경",
  escalate: "권한 상승 가능",
};
export const CELL_GLYPHS: Record<Cell, string> = { read: "읽", write: "쓰", delete: "삭", exec: "셸", secretRead: "비", rbacWrite: "R", escalate: "↑" };
/** 칸마다 무엇을 보고 전부·일부를 가르는지 */
export const CELL_RULES: Record<Cell, string> = {
  read: "pods, services, configmaps, persistentvolumeclaims, deployments, statefulsets, daemonsets, jobs, cronjobs, ingresses 10종에 get·list·watch",
  write: "같은 10종에 create·update·patch",
  delete: "같은 10종에 delete·deletecollection",
  exec: "pods/exec, pods/attach, pods/portforward에 create",
  secretRead: "secrets에 get·list·watch",
  rbacWrite: "roles·rolebindings(클러스터 전체 열은 clusterroles·clusterrolebindings도)에 create·update·patch·delete",
  escalate:
    "직접: roles·clusterroles의 escalate·bind, users·groups·serviceaccounts의 impersonate, serviceaccounts/token 만들기, nodes/proxy. 간접: Pod·워크로드 만들기와 Secret 읽기",
};
export const LEVEL_TEXT = ["없음", "일부", "전부"] as const;
export const ESCALATE_LEVEL_TEXT = ["없음", "간접 경로", "직접 경로"] as const;
export const levelText = (cell: Cell, level: number) => (cell === "escalate" ? ESCALATE_LEVEL_TEXT : LEVEL_TEXT)[level] ?? LEVEL_TEXT[0];
export const cellLabel = (subject: string, column: string, cell: Cell, level: number) => `${subject} · ${column} · ${CELL_LABELS[cell]}: ${levelText(cell, level)}`;
export const LEGEND_TITLE = "칸 설명";
export const LEGEND_FULL = "전부(또는 직접 경로)";
export const LEGEND_PARTIAL = "일부(이름이 정해진 것만, 또는 간접 경로)";
export const LEGEND_NONE = "없음";

// ── 칸 상세 ──
export const DETAIL_LABEL = "권한 상세";
export const DETAIL_CELL = (cell: Cell) => CELL_LABELS[cell];
export const DETAIL_COLUMN = (ns: string | null) => (ns === null ? CLUSTER_WIDE : `네임스페이스 ${ns}`);
export const PROBES_TITLE = "확인한 동작";
export const PATHS_TITLE = "바인딩 경로";
export const NO_PATHS = "이 칸을 허용하는 바인딩이 없어요";
export const H_PROBE = "동작";
export const H_RESULT = "결과";
export const H_PATH_COUNT = "경로 수";
export const ALLOWED = "허용";
export const DENIED = "없음";
export const NAMES_ONLY = "이름 한정";
export const DIRECT = "직접";
export const INDIRECT = "간접";
export const SESSION_DEPENDENT = "특정 세션 이름일 때만";
export const IAM_IDENTITY = "쿠버네티스에서의 신원";
export const verbResource = (verb: string, group: string, resource: string, sub: string | null) =>
  `${verb} ${resource}${sub ? `/${sub}` : ""}${group ? ` (${group})` : ""}`;

// ── 경로 글 ──
export const VIA_DIRECT = "직접 연결";
export const viaGroup = (group: string) => `그룹 ${group} 경유`;
export const viaDefault = (group: string) => `기본 그룹 ${group}에서 물려받음`;
export const viaPolicy = (policy: string) => `EKS access policy ${policy}`;
export const viaBuiltin = (group: string) => `API 서버 내장(${group}은 모든 것을 허용)`;
export const aggregatedFrom = (role: string) => `${role}에서 합쳐짐`;
export const SCOPE_CLUSTER = "클러스터 전체";
export const scopeNamespace = (ns: string) => `네임스페이스 ${ns}`;

// ── 누가 할 수 있나 ──
export const WHO_LABEL = "누가 할 수 있나";
export const F_VERB = "동사";
export const F_RESOURCE = "리소스";
export const F_RESOURCE_HINT = "pods, deployments.apps, pods/exec";
export const F_NAMESPACE = "네임스페이스";
export const F_NAME = "이름(선택)";
export const NS_CLUSTER = "(클러스터 범위)";
export const FIND = "찾기";
export const PRESETS_LABEL = "자주 묻는 것";
export const PRESETS: { label: string; verb: string; resource: string }[] = [
  { label: "Secret 읽기", verb: "get", resource: "secrets" },
  { label: "Pod 접속(exec)", verb: "create", resource: "pods/exec" },
  { label: "Pod 만들기", verb: "create", resource: "pods" },
  { label: "RBAC 바인딩 변경", verb: "create", resource: "rolebindings.rbac.authorization.k8s.io" },
  { label: "ClusterRole bind", verb: "bind", resource: "clusterroles.rbac.authorization.k8s.io" },
  { label: "사용자 impersonate", verb: "impersonate", resource: "users" },
];
export const REQUEST_INVALID = "동사와 리소스를 입력해 주세요";
export const H_SUBJECT = "주체";
export const H_KIND = "종류";
export const H_PATH = "경로";
export const H_CHECK = "클러스터 대조";
export const NO_RESULT = "이 동작을 할 수 있는 주체가 없어요";
export const WHO_INHERITED_NOTE = "기본 그룹(system:authenticated 등)에서 물려받은 권한은 그 그룹 한 줄로만 보여요. 모든 사용자와 ServiceAccount가 가지니까요.";
export const resultsTruncated = (shown: number, total: number) => `주체 ${total}명 중 ${shown}명만 보여요`;
export const morePaths = (n: number) => `외 ${n}개`;
export const CHECK_BUTTON = "클러스터에 대조(SubjectAccessReview)";
export const CHECK_DENIED_TITLE = "이 신원은 SubjectAccessReview를 만들 수 없어요";
export const CHECK_RUNNING = "대조하는 중이에요";
export const CHECK_LIMIT = 100;
export const checkLimited = (n: number) => `위에서 ${n}명만 대조해요`;
export const CHECK_MATCH = "일치";
export const CHECK_MISMATCH = "다름";
export const CHECK_SKIPPED = "세션에 따라 달라서 대조하지 않았어요";
export const checkSummary = (match: number, mismatch: number, failed: number) =>
  `대조 결과: 일치 ${match}명, 다름 ${mismatch}명${failed > 0 ? `, 대조하지 못함 ${failed}명` : ""}`;
/** 계산은 허용했는데 클러스터가 거부했다 */
export const MISMATCH_TEXT = "계산은 허용, 클러스터는 거부";
export const REVIEW_FAILED = "대조하지 못했어요";
export const subjectKindText = (s: { kind: SubjectKind; namespace: string | null }) => KIND_LABELS[s.kind];
export const subjectName = (s: { kind: SubjectKind; name: string; namespace: string | null }) => (s.kind === "serviceAccount" ? `${s.namespace}/${s.name}` : s.name);

// ── 워크로드 신원 ──
export const WORKLOAD_LABEL = "워크로드 신원";
export const H_SA = "ServiceAccount";
export const H_IRSA = "IRSA 역할";
export const H_POD_IDENTITY = "Pod Identity 역할";
export const H_PODS = "쓰는 Pod";
export const H_STATUS = "상태";
export const STATUS_WORKS = "동작해요";
export const STATUS_BROKEN = "연결돼 있지만 동작하지 않음";
export const STATUS_UNKNOWN = "확인하지 못함";
export const ONLY_BROKEN = "동작하지 않는 것만";
export const WORKLOAD_FILTER = "ServiceAccount·역할 이름 찾기";
export const NO_WORKLOADS = "IRSA나 Pod Identity가 연결된 ServiceAccount가 없어요";
export const WORKLOAD_TRUNCATED = "ServiceAccount나 Pod가 너무 많아서 일부만 읽었어요";
export const OIDC_ISSUER = "이 클러스터의 OIDC 발급자";
export const IRSA_AUDIENCE = "aud";
export const WORKLOAD_DETAIL_LABEL = "워크로드 신원 상세";
export const REASONS_TITLE = "이유";
export const PODS_TITLE = "쓰는 Pod";
export const podsMore = (shown: number, total: number) => `${total}개 중 ${shown}개만 보여요`;
export const NOTES_TITLE = "참고";
export const TARGET_ROLE = "대상 역할";
export const ASSOCIATION = "연결 ID";
export const MISSING_SA = "ServiceAccount 없음";
export const checkText = (c: { kind: "works" } | { kind: "broken" } | { kind: "unknown" }) =>
  c.kind === "works" ? STATUS_WORKS : c.kind === "broken" ? STATUS_BROKEN : STATUS_UNKNOWN;
