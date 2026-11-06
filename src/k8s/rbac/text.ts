import type { RbacSubjectSpec } from "./types";

// ── 장바구니 ──
export const CART_LABEL = "권한 변경 장바구니";
export const cartCount = (count: number, max: number) => `장바구니 ${count}/${max}`;
export const CART_PREVIEW = "한 번에 미리보기…";
export const CART_CLEAR = "비우기";
export const CART_ITEMS = "담은 변경";
export const CART_REMOVE = "빼기";
export const cartRemoveLabel = (title: string) => `${title} 장바구니에서 빼기`;
export const CART_ADD = "장바구니에 담기";
export const CART_ADDED = (count: number, max: number) => `담았어요 (${count}/${max})`;
export const CART_DUPLICATE = "이미 장바구니에 있어요";
export const CART_FULL = (max: number) => `장바구니는 ${max}개까지 담을 수 있어요`;
export const CART_HINT = "권한 표나 바인딩 상세에서 변경을 담아 한 번에 미리보기하고 적용해요";

// ── 일괄 미리보기 ──
export const BATCH_TITLE = "권한 변경 미리보기";
export const BATCH_UNDO_TITLE = "권한 변경 되돌리기 미리보기";
export const batchItem = (index: number, title: string) => `${index}. ${title}`;
export const BATCH_LOADING = "미리보기를 불러오는 중이에요…";
export const BATCH_PREVIEW_FAILED = "미리보기에 실패했어요";
export const BATCH_APPLY = (count: number) => `${count}개 적용`;
export const BATCH_APPLYING = "적용 중…";
export const BATCH_CLOSE = "닫기";
export const BATCH_CANCEL = "취소";
export const BATCH_RETRY = "미리보기 다시 받기";
export const BATCH_STALE = "미리보기 이후 바뀌었어요. 아무것도 적용하지 않았어요. 미리보기를 다시 받아 주세요";
export const BATCH_APPLIED = "적용함";
export const BATCH_FAILED = "실패";
export const BATCH_SKIPPED = "건너뜀";
export const BATCH_STOPPED = "적용하다 멈췄어요. 이미 적용한 변경은 그대로 남아 있어요";
export const BATCH_DONE = "모두 적용했어요";
export const BATCH_UNDO_APPLIED = "적용한 것 되돌리기";
export const BATCH_UNDO_UNAVAILABLE = "되돌릴 수 없는 변경이 있어요";
export const BATCH_BLOCKED = "계획하지 못한 변경이 있어서 적용할 수 없어요. 장바구니에서 빼거나 고친 뒤 다시 미리보기 해 주세요";
export const BATCH_ORDER_NOTE = "변경은 담은 순서대로 앞 변경이 적용된 상태에서 계획해요. 적용 직전에 모두 다시 계획해 미리보기와 다르면 아무것도 적용하지 않아요";
export const BATCH_TOTAL_TITLE = "전체를 적용하면";
export const BATCH_TOTAL_NONE = "실효 권한이 달라지는 주체가 없어요";
export const BATCH_CONFIRM_ALL = "이름 입력이 필요한 변경은 각각 이름을 입력해야 적용할 수 있어요";

// ── 영향(누가 무엇을 얻고 잃는지) ──
export const EFFECT_TITLE = "누가 무엇을 얻고 잃는지";
export const EFFECT_NONE = "실효 권한이 달라지는 주체가 없어요";
export const EFFECT_ESCALATED = "클러스터 관리자 권한이나 권한 상승 경로를 새로 얻는 주체가 있어요";
export const EFFECT_OWN = "이 앱이 쓰는 신원이 권한을 잃어요";
export const effectCount = (count: number) => `${count}명`;
export const effectMore = (shown: number, total: number) => `${total}명 중 ${shown}명만 보여요`;
export const EFFECT_UNAVAILABLE = (reason: string) => `영향을 끝까지 계산하지 못했어요: ${reason}`;
export const EFFECT_SUBJECT = "주체";
export const EFFECT_GAINED = "얻음";
export const EFFECT_LOST = "잃음";
export const EFFECT_ESCALATED_BADGE = "권한 상승";
export const EFFECT_OWN_BADGE = "내 신원";
export const EFFECT_DETAIL = "자세히";
export const CLUSTER_WIDE = "클러스터 전체";
export const ALL_RESOURCES = "모든 리소스";
export const ALL_VERBS = "모든 동작";
export const ALL_URLS = "모든 비리소스 URL";
export const capabilityText = (verbs: string[], resource: string, group: string, namespace: string | null) => {
  const what = resource === "*" && group === "*" ? ALL_RESOURCES : `${resource}${group && group !== "*" ? `.${group}` : ""}`;
  return `${verbs.includes("*") ? ALL_VERBS : verbs.join(", ")} ${what} · ${namespace ?? CLUSTER_WIDE}`;
};

// ── 바인딩 상세의 도구 ──
export const BINDING_ADD_SUBJECT = "주체 추가";
export const BINDING_REMOVE_SUBJECT = "주체 빼기";
export const BINDING_CART_DELETE = "삭제를 장바구니에";
export const BINDING_SUBJECT_KIND = "종류";
export const BINDING_SUBJECT_NAME = "이름";
export const BINDING_SUBJECT_NAMESPACE = "네임스페이스";
export const BINDING_SUBJECT_PICK = "뺄 주체";
export const BINDING_NO_SUBJECTS = "주체가 없어요";
export const BINDING_PREVIEW = "미리보기…";
export const BINDING_CLOSE = "닫기";
export const SUBJECT_KIND_LABELS: Record<RbacSubjectSpec["kind"], string> = { User: "사용자", Group: "그룹", ServiceAccount: "ServiceAccount" };
export const subjectLabel = (s: RbacSubjectSpec) => `${SUBJECT_KIND_LABELS[s.kind]} ${s.kind === "ServiceAccount" ? `${s.namespace ?? ""}/` : ""}${s.name}`;
export const INVALID_SUBJECT_HINT = "주체의 이름(ServiceAccount는 네임스페이스도)을 입력해 주세요";
export const BINDING_DENIED = (verb: string, resource: string) => `${resource}에 ${verb} 권한이 없어요`;

// ── 권한 표 칸에서 담기 ──
export const CELL_CHANGE_TITLE = "권한 바꾸기";
export const CELL_PATHS_HINT = "이 칸의 권한을 주는 바인딩이에요. 빼거나 지우는 변경을 장바구니에 담아요";
export const CELL_REMOVE_SUBJECT = "이 주체 빼기 담기";
export const CELL_DELETE_BINDING = "바인딩 삭제 담기";
export const CELL_NO_SUBJECT_REMOVE = "이 경로는 바인딩의 주체로 빼지 못해요(바인딩을 지우거나 신원 탭에서 그룹을 바꿔요)";
export const CELL_GRANT_TITLE = "권한 주기";
export const CELL_GRANT_ROLE = "ClusterRole";
export const CELL_GRANT_NAME = "바인딩 이름";
export const CELL_GRANT_ADD = "권한 주기 담기";
export const CELL_GRANT_PREVIEW = "미리보기…";
export const CELL_GRANT_IAM = "IAM 주체는 access entry의 그룹이나 access policy로 권한을 줘요. 신원 탭에서 바꿔요";
export const cellGrantHint = (cluster: boolean, namespace: string | null) =>
  cluster ? "ClusterRoleBinding을 만들어 모든 네임스페이스에 줘요" : `${namespace} 네임스페이스에 RoleBinding을 만들어요`;
export const CELL_GRANT_ROLE_EMPTY = "ClusterRole 이름을 입력해 주세요";

// ── access entry ──
export const ENTRY_CREATE = "access entry 만들기…";
export const ENTRY_GROUPS = "그룹 변경…";
export const ENTRY_ASSOCIATE = "정책 연결…";
export const ENTRY_DISASSOCIATE = "해제";
export const ENTRY_DELETE = "삭제…";
export const ENTRY_CREATE_TITLE = "access entry 만들기";
export const ENTRY_GROUPS_TITLE = "쿠버네티스 그룹 바꾸기";
export const ENTRY_ASSOCIATE_TITLE = "access policy 연결";
export const ENTRY_PRINCIPAL = "IAM 주체 ARN";
export const ENTRY_PRINCIPAL_PLACEHOLDER = "arn:aws:iam::123456789012:role/이름";
export const ENTRY_USERNAME = "사용자 이름(비우면 EKS가 정해요)";
export const ENTRY_GROUPS_LABEL = "쿠버네티스 그룹(쉼표로 나눠요)";
export const ENTRY_POLICY = "access policy";
export const ENTRY_POLICY_NONE = "정책 연결 안 함";
export const ENTRY_POLICY_CUSTOM = "직접 입력";
export const ENTRY_POLICY_ARN = "정책 ARN";
export const ENTRY_SCOPE = "범위";
export const ENTRY_SCOPE_CLUSTER = "클러스터 전체";
export const ENTRY_SCOPE_NAMESPACES = "네임스페이스";
export const ENTRY_SCOPE_NAMESPACES_LABEL = "네임스페이스(쉼표로 나눠요)";
export const ENTRY_PREVIEW = "미리보기";
export const ENTRY_CANCEL = "취소";
export const ENTRY_CONFIG_MAP = "인증 모드가 CONFIG_MAP이라 access entry를 쓰지 않아요";
export const ENTRY_API_NOTE = "EKS 권한은 미리 확인할 수 없어요. 권한이 없으면 적용할 때 EKS의 오류를 그대로 보여 줘요";
export const ENTRY_AWS_AUTH_NOTE = "aws-auth는 직접 고치지 않아요. access entry로 옮기세요";
export const ENTRY_UNREADABLE = "자세히 읽지 못한 항목이에요";
export const entryPolicyUndo = (name: string) => `${name} 연결 해제…`;
export const ENTRY_GROUPS_REQUIRED = "그룹 이름이 비어 있어요";
export const ENTRY_PRINCIPAL_REQUIRED = "IAM 주체 ARN을 입력해 주세요";
export const ENTRY_POLICY_REQUIRED = "정책 ARN을 입력해 주세요";
export const ENTRY_NAMESPACES_REQUIRED = "네임스페이스를 하나 이상 입력해 주세요";

export const KNOWN_POLICIES: { name: string; arn: string }[] = [
  { name: "AmazonEKSClusterAdminPolicy", arn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy" },
  { name: "AmazonEKSAdminPolicy", arn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy" },
  { name: "AmazonEKSEditPolicy", arn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy" },
  { name: "AmazonEKSViewPolicy", arn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy" },
];

// ── 변경 이름(장바구니·되돌리기 목록) ──
export const TITLE_BINDING_CREATE = (binding: string) => `${binding} 만들기`;
export const TITLE_BINDING_DELETE = (binding: string) => `${binding} 삭제`;
export const TITLE_SUBJECTS = (binding: string, add: string[], remove: string[]) =>
  `${binding} · ${[...add.map((a) => `+${a}`), ...remove.map((r) => `−${r}`)].join(", ")}`;
export const TITLE_ENTRY_CREATE = (name: string) => `access entry ${name} 만들기`;
export const TITLE_ENTRY_DELETE = (name: string) => `access entry ${name} 삭제`;
export const TITLE_ENTRY_GROUPS = (name: string, groups: string[]) => `access entry ${name} 그룹 → ${groups.join(", ") || "없음"}`;
export const TITLE_ENTRY_ASSOCIATE = (name: string, policy: string) => `access entry ${name}에 ${policy} 연결`;
export const TITLE_ENTRY_DISASSOCIATE = (name: string, policy: string) => `access entry ${name}에서 ${policy} 해제`;
