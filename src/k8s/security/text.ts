import type { Category, CheckId, Severity, SecuritySection } from "./types";

// ── 메뉴·화면 ──
export const NAV_SECURITY = "보안 점검";
export const SECURITY_ICON = "🔍";
export const SECURITY_LABEL = "보안 점검";
export const LOADING = "보안 점검을 읽는 중이에요";
export const REFRESH = "다시 점검";
export const CLOSE = "닫기";
export const DASH = "—";
export const SCOPE_NOTE = "읽기만 해서 찾은 설정상의 위험이에요. 실제로 악용된다는 뜻은 아니에요. 항목은 아래 \"점검 항목\"에서 켜고 끌 수 있어요.";
export const fetchedAt = (iso: string) => `${iso.replace("T", " ").replace("Z", "")} 기준`;

// ── 심각도·분류 ──
export const SEVERITY_LABELS: Record<Severity, string> = { high: "높음", medium: "중간", low: "낮음" };
export const SEVERITIES: Severity[] = ["high", "medium", "low"];
export const CATEGORY_LABELS: Record<Category, string> = { cluster: "클러스터", permissions: "권한", workloads: "워크로드" };
export const CATEGORIES: Category[] = ["cluster", "permissions", "workloads"];
export const SUMMARY_LABEL = "점검 요약";
export const BY_SEVERITY_LABEL = "심각도별";
export const BY_CATEGORY_LABEL = "분류별";
export const FILTER_TITLE = (label: string, on: boolean) => (on ? `${label} 거르기를 풀어요` : `${label}만 보여요`);
export const TOTAL = (n: number) => `${n}건`;
export const ALL_CLEAR = "찾은 문제가 없어요";
export const NO_MATCH = "조건에 맞는 문제가 없어요";
export const HIDDEN_SYSTEM = (n: number) => `시스템 네임스페이스 ${n}건은 숨겼어요`;

// ── 목록 ──
export const FILTER_PLACEHOLDER = "대상·메시지·네임스페이스 검색";
export const INCLUDE_SYSTEM = "시스템 네임스페이스 포함";
export const INCLUDE_SYSTEM_TITLE = "kube-system, kube-public, kube-node-lease, amazon-*의 문제도 보여요";
export const GROUP_BY_CHECK = "점검 항목별로 묶기";
export const CHECKS_PANEL = "점검 항목";
export const CHECKS_PANEL_TITLE = "점검 항목을 켜고 끄고, 끈 항목은 결과에서 빼요(모든 클러스터에 같이 적용돼요)";
export const FINDINGS_LABEL = "찾은 문제";
export const FINDINGS_TABLE_LABEL = "찾은 문제 목록";
export const H_SEVERITY = "심각도";
export const H_CHECK = "점검 항목";
export const H_TARGET = "대상";
export const H_NAMESPACE = "네임스페이스";
export const H_MESSAGE = "내용";
export const H_FIX = "자동 수정";
export const FIX_AVAILABLE = "고칠 수 있어요";
export const groupCount = (n: number) => `${n}건`;
export const GROUP_COLLAPSE = (title: string, open: boolean) => (open ? `${title} 접기` : `${title} 펼치기`);

// ── 점검 항목 설정 ──
export const CHECKS_ENABLE_ALL = "모두 켜기";
export const CHECKS_DISABLE_ALL = "모두 끄기";
export const checkCount = (n: number) => `${n}건`;
export const CHECK_SKIPPED = "읽지 못해 점검하지 못했어요";
export const CHECK_OFF = "꺼져 있어요";
export const SKIPPED_TITLE = "점검하지 못한 항목";
export const skippedLine = (titles: string[]) => `읽지 못해 점검하지 못한 항목: ${titles.join(", ")}`;

// ── 읽지 못한 부분 ──
export const SECTION_LABELS: Record<SecuritySection, string> = {
  cluster: "클러스터 설정(DescribeCluster)",
  versions: "버전 지원 기간(DescribeClusterVersions)",
  accessEntries: "EKS access entry",
  awsAuth: "aws-auth ConfigMap",
  rbac: "Role·ClusterRole·바인딩",
  namespaces: "네임스페이스",
  serviceAccounts: "ServiceAccount",
  deployments: "Deployment",
  statefulSets: "StatefulSet",
  daemonSets: "DaemonSet",
  jobs: "Job",
  cronJobs: "CronJob",
  pods: "Pod",
  networkPolicies: "NetworkPolicy",
  nodes: "노드",
  nodegroups: "관리형 노드그룹",
  launchTemplates: "노드그룹 시작 템플릿(EC2)",
  instances: "EC2 인스턴스",
};
export const GAPS_LABEL = "읽지 못한 부분";
export const gapLine = (sections: string[]) => `이 부분을 읽지 못했어요: ${sections.join(", ")}`;
export const PARTIAL_LINE = (sections: string[]) => `목록이 너무 길어 일부만 점검했어요: ${sections.join(", ")}`;

// ── 상세 ──
export const DETAIL_LABEL = "보안 점검 상세";
export const SEC_SUMMARY = "요약";
export const SEC_EVIDENCE = "증거";
export const SEC_WHY = "왜 중요한가요";
export const SEC_REMEDY = "해결 방법";
export const SEC_FIX = "자동으로 고치기";
export const H_SEVERITY_DETAIL = "심각도";
export const H_CATEGORY = "분류";
export const FIX_BUTTON = "자동으로 고치기";
export const FIX_BUTTON_TITLE = "미리보기에서 바뀌는 내용을 확인하고 적용해요(서버 dry-run을 먼저 돌려요)";
export const FIX_CHECKING = "권한을 확인하는 중이에요";
export const FIX_NOTE = "적용하기 전에 미리보기에서 바뀌는 필드와 영향을 확인해요. 변경 기록에서 되돌릴 수 있어요.";
export const NO_FIX = "자동으로 고치지 않아요. 값을 사람이 정해야 하거나 서비스가 깨질 수 있어서예요.";
export const OPEN_OBJECT = "워크로드 화면에서 열기";
export const OPEN_IAM = "IAM에서 열기";
export const OPEN_ACCESS = "접근 화면에서 보기";
export const OPEN_SERVICE_ACCOUNT = "ServiceAccount 열기";
export const AWS_TARGET_NOTE = "AWS 리소스예요. AWS 콘솔이나 IaC에서 고쳐야 해요(이 앱은 클러스터·노드그룹을 바꾸지 않아요).";
export const fixDenied = (verb: string, resource: string) => `${resource}에 ${verb} 권한이 없어요`;

// ── 대상 이름 ──
export const AWS_RESOURCE_LABELS: Record<string, string> = { cluster: "클러스터", nodegroup: "노드그룹", nodepool: "NodePool", instance: "인스턴스" };
export const SUBJECT_KIND_LABELS = { user: "사용자", group: "그룹", serviceAccount: "ServiceAccount", iam: "IAM 주체" } as const;

export interface CheckInfo {
  id: CheckId;
  category: Category;
  title: string;
  /** 왜 중요한가 */
  why: string;
  /** 사람이 직접 고치는 방법 */
  remedy: string;
}

/** 점검 항목 전부(백엔드 `CheckId::ALL`과 같은 이름·순서) */
export const CHECKS: CheckInfo[] = [
  {
    id: "clusterPublicEndpoint",
    category: "cluster",
    title: "API 서버가 모든 IP에 열림",
    why: "인터넷의 누구나 API 서버에 접속을 시도할 수 있어요. 인증이 막아 주지만 자격 증명이 새거나 API 서버에 취약점이 나오면 곧바로 노출돼요.",
    remedy: "퍼블릭 접근 CIDR을 사무실·VPN 주소로 좁히거나 프라이빗 엔드포인트만 쓰세요(EKS 콘솔 → 네트워킹 → 엔드포인트 접근 관리).",
  },
  {
    id: "clusterLoggingOff",
    category: "cluster",
    title: "컨트롤 플레인 로그 꺼짐",
    why: "audit·authenticator 로그가 없으면 누가 언제 무엇을 바꿨는지, 어떤 IAM 신원이 들어왔는지 사고 뒤에 추적할 수 없어요.",
    remedy: "EKS 콘솔 → 관찰 가능성 → 로깅에서 필요한 유형을 켜세요. 로그는 CloudWatch Logs에 쌓이니 보관 기간을 정해 두세요.",
  },
  {
    id: "clusterSecretsPlain",
    category: "cluster",
    title: "Secret KMS 봉투 암호화 없음",
    why: "EKS는 etcd 저장소를 기본으로 암호화하지만, 고객 관리 KMS 키로 Secret을 한 번 더 감싸야 키 사용 기록과 접근 통제를 직접 관리할 수 있어요.",
    remedy: "클러스터에 암호화 구성(KMS 키)을 켜세요. 한 번 켜면 끌 수 없고, 기존 Secret은 다시 써야 암호화돼요.",
  },
  {
    id: "clusterVersionSupport",
    category: "cluster",
    title: "표준 지원 종료가 가까움",
    why: "표준 지원이 끝나면 확장 지원(추가 요금)으로 넘어가고 그 뒤에는 보안 패치가 멈춰요. 업그레이드는 한 번에 한 마이너 버전씩이라 시간이 걸려요.",
    remedy: "EKS Upgrade Insights와 개요 화면의 업그레이드 점검을 보고 다음 버전으로 올릴 계획을 세우세요.",
  },
  {
    id: "clusterAwsAuth",
    category: "cluster",
    title: "aws-auth ConfigMap 사용 중",
    why: "aws-auth는 잘못 고치면 모든 신원이 잠기고, 변경 기록이 남지 않으며 권한 검토 도구와 맞지 않아요. access entry가 이를 대신해요.",
    remedy: "access entry로 옮긴 뒤 인증 모드를 API로 바꾸세요(EKS 콘솔 → 액세스).",
  },
  {
    id: "clusterCreatorAdmin",
    category: "cluster",
    title: "생성자 관리자 권한 남음",
    why: "클러스터를 만든 신원에게 자동으로 붙는 cluster-admin 권한은 사람이 퇴사하거나 역할이 바뀌어도 남아 있어요. 누가 이 권한을 갖는지 문서에 없는 경우가 많아요.",
    remedy: "필요한 관리자에게 명시적으로 access entry를 만들고, 이 항목은 지우세요(지우기 전에 다른 관리자 접근이 되는지 확인하세요).",
  },
  {
    id: "adminSubject",
    category: "permissions",
    title: "모든 권한을 가진 주체",
    why: "cluster-admin·system:masters는 Secret 읽기, 모든 워크로드 변경, 권한 부여까지 할 수 있어요. 이 권한을 가진 주체가 많을수록 하나가 뚫렸을 때 피해가 커요.",
    remedy: "꼭 필요한 주체만 남기고 나머지는 edit·view 같은 좁은 역할로 바꾸세요. 자동화 계정은 필요한 네임스페이스의 Role로 제한하세요.",
  },
  {
    id: "anonymousAccess",
    category: "permissions",
    title: "익명·모든 인증 주체에게 준 권한",
    why: "system:unauthenticated와 system:anonymous는 로그인하지 않은 누구나, system:authenticated는 클러스터에 접속할 수 있는 모든 신원(다른 계정의 IAM 역할 포함)이 쓸 수 있어요.",
    remedy: "해당 바인딩의 주체를 필요한 사용자·그룹으로 바꾸거나 바인딩을 지우세요. 기본 설정(system:public-info-viewer 등)은 점검하지 않아요.",
  },
  {
    id: "escalateBind",
    category: "permissions",
    title: "역할을 스스로 키울 수 있음(bind·escalate)",
    why: "roles·clusterroles에 escalate나 bind가 있으면 자기가 가진 것보다 큰 권한을 만들어 자기에게 붙일 수 있어서 사실상 cluster-admin과 같아요.",
    remedy: "해당 규칙을 빼거나 resourceNames로 특정 역할만 묶을 수 있게 제한하세요.",
  },
  {
    id: "impersonate",
    category: "permissions",
    title: "다른 신원으로 가장할 수 있음",
    why: "users·groups·serviceaccounts에 impersonate가 있거나 ServiceAccount 토큰을 만들 수 있으면 더 강한 주체로 행동할 수 있어요.",
    remedy: "해당 규칙을 빼거나 resourceNames로 가장할 수 있는 대상을 정하세요.",
  },
  {
    id: "podCreateStrongSa",
    category: "permissions",
    title: "Pod를 만들어 강한 ServiceAccount 권한을 쓸 수 있음",
    why: "Pod를 만들 수 있으면 같은 네임스페이스의 어떤 ServiceAccount든 지정해 그 토큰으로 API를 호출할 수 있어요. 그 네임스페이스에 강한 ServiceAccount가 있으면 그 권한이 우회로로 열려요.",
    remedy: "강한 ServiceAccount를 별도 네임스페이스로 옮기거나 그 권한을 줄이고, Pod 생성 권한은 필요한 네임스페이스에만 주세요(승인 정책으로 serviceAccountName을 제한할 수도 있어요).",
  },
  {
    id: "nodesProxy",
    category: "permissions",
    title: "nodes/proxy 권한",
    why: "kubelet API를 API 서버 경유로 부를 수 있어서 그 노드의 모든 Pod에서 명령을 실행할 수 있어요(감사 로그에도 잘 남지 않아요).",
    remedy: "모니터링 도구라면 nodes/metrics, nodes/stats처럼 필요한 하위 리소스만 허용하세요.",
  },
  {
    id: "secretsReadAll",
    category: "permissions",
    title: "모든 네임스페이스의 Secret 읽기",
    why: "모든 Secret에는 다른 ServiceAccount 토큰, DB 비밀번호, TLS 키가 들어 있어서 읽을 수 있으면 다른 권한을 얻는 길이 돼요.",
    remedy: "클러스터 전체(ClusterRoleBinding) 대신 필요한 네임스페이스에 RoleBinding으로 주고, resourceNames로 읽을 Secret을 정하세요.",
  },
  {
    id: "unusedRole",
    category: "permissions",
    title: "쓰이지 않는 Role·ClusterRole",
    why: "바인딩이 없는 역할은 아무 효과가 없지만, 나중에 누가 실수로 묶으면 오래된 권한이 되살아나요. 정리할수록 권한 검토가 쉬워져요.",
    remedy: "더 이상 필요 없으면 지우세요(Helm 차트가 만든 것이면 차트에서 빼세요).",
  },
  {
    id: "bindingMissingRole",
    category: "permissions",
    title: "없는 역할을 가리키는 바인딩",
    why: "역할이 없는 동안 바인딩은 아무 권한도 주지 않지만, 같은 이름의 역할이 다시 만들어지면 바인딩의 주체가 그 권한을 바로 얻어요.",
    remedy: "바인딩을 지우거나 올바른 역할을 가리키게 고치세요.",
  },
  {
    id: "bindingMissingSubject",
    category: "permissions",
    title: "없는 ServiceAccount를 가리키는 바인딩",
    why: "누군가 같은 이름의 ServiceAccount를 만들면 바인딩이 그 ServiceAccount에 권한을 줘요. 삭제된 앱의 권한이 남아 있는 경우가 많아요.",
    remedy: "바인딩을 지우거나 주체를 올바른 ServiceAccount로 바꾸세요.",
  },
  {
    id: "privileged",
    category: "workloads",
    title: "privileged 컨테이너",
    why: "privileged 컨테이너는 호스트의 거의 모든 장치와 권한을 가져서 컨테이너를 뚫으면 노드를 통째로 장악할 수 있어요.",
    remedy: "필요한 capability만 추가하고 privileged를 끄세요. 노드 에이전트처럼 꼭 필요하면 전용 네임스페이스로 분리하세요.",
  },
  {
    id: "hostPath",
    category: "workloads",
    title: "hostPath 볼륨",
    why: "노드의 파일 시스템을 마운트하면 컨테이너가 다른 Pod의 데이터, kubelet 설정, 컨테이너 런타임 소켓에 닿을 수 있어요(런타임 소켓은 노드 장악과 같아요).",
    remedy: "emptyDir·PVC·ConfigMap으로 바꾸세요. 꼭 필요하면 특정 경로만 readOnly로 마운트하세요.",
  },
  {
    id: "hostNetwork",
    category: "workloads",
    title: "hostNetwork 사용",
    why: "노드의 네트워크를 그대로 쓰면 NetworkPolicy가 적용되지 않고 노드에서만 열려 있는 포트(IMDS, kubelet)에 닿을 수 있어요.",
    remedy: "꼭 필요한 경우가 아니면 끄세요(노드 에이전트 등).",
  },
  {
    id: "hostPid",
    category: "workloads",
    title: "hostPID 사용",
    why: "노드의 모든 프로세스가 보이고 다른 프로세스의 환경 변수·메모리를 볼 수 있어서 비밀 값이 새어 나갈 수 있어요.",
    remedy: "꼭 필요한 경우가 아니면 끄세요.",
  },
  {
    id: "runsAsRoot",
    category: "workloads",
    title: "root로 실행",
    why: "root로 실행하는 컨테이너는 취약점이 하나만 있어도 컨테이너 안에서 모든 파일을 바꾸고 더 쉽게 탈출해요.",
    remedy: "이미지에 비root 사용자를 만들고 runAsNonRoot: true와 runAsUser를 지정하세요. 이미지에 따라 코드 수정이 필요해서 자동으로 고치지 않아요.",
  },
  {
    id: "privilegeEscalation",
    category: "workloads",
    title: "allowPrivilegeEscalation이 false가 아님",
    why: "기본값 true라서 setuid 프로그램이나 파일 capability로 프로세스가 부모보다 큰 권한을 얻을 수 있어요. 대부분의 앱은 필요 없어요.",
    remedy: "securityContext에 allowPrivilegeEscalation: false를 쓰세요(privileged나 CAP_SYS_ADMIN 컨테이너는 쓸 수 없어요).",
  },
  {
    id: "resourcesMissing",
    category: "workloads",
    title: "request·limit 없음",
    why: "request가 없으면 스케줄러가 자리를 잘못 잡고, limit가 없으면 한 Pod가 노드 자원을 다 써서 이웃을 죽일 수 있어요(서비스 거부).",
    remedy: "사용량(사용량 그래프)을 보고 request·limit를 정하세요. 값은 서비스마다 달라서 자동으로 고치지 않아요.",
  },
  {
    id: "probesMissing",
    category: "workloads",
    title: "probe 없음",
    why: "readinessProbe가 없으면 준비되지 않은 Pod에도 트래픽이 가고, livenessProbe가 없으면 멈춘 프로세스가 재시작되지 않아요.",
    remedy: "앱의 상태 확인 엔드포인트로 readiness·liveness probe를 정하세요. 자동으로 고치지 않아요.",
  },
  {
    id: "imageLatest",
    category: "workloads",
    title: "latest 또는 태그 없는 이미지",
    why: "latest는 같은 이름이 가리키는 이미지가 바뀌어서 어떤 버전이 도는지 알 수 없고, 롤백과 취약점 추적이 어려워요. 공급망 공격에도 약해요.",
    remedy: "버전 태그나 다이제스트(@sha256:…)로 고정하세요.",
  },
  {
    id: "saTokenAutomount",
    category: "workloads",
    title: "default ServiceAccount 토큰 자동 마운트",
    why: "API를 부르지 않는 Pod에도 토큰이 들어가면, 컨테이너가 뚫렸을 때 그 토큰으로 API를 부를 수 있어요. default ServiceAccount는 이름만 같을 뿐 모든 앱이 공유해요.",
    remedy: "default ServiceAccount의 automountServiceAccountToken을 false로 하고, API가 필요한 앱은 전용 ServiceAccount를 쓰세요.",
  },
  {
    id: "noNetworkPolicy",
    category: "workloads",
    title: "NetworkPolicy 없는 네임스페이스",
    why: "정책이 없으면 모든 Pod가 서로 통신할 수 있어서 한 Pod가 뚫리면 옆으로 퍼지기 쉬워요.",
    remedy: "기본 차단(default-deny) 정책을 만들고 필요한 통신만 허용하세요. CNI의 정책 기능이 켜져 있어야 동작해요. 서비스가 끊길 수 있어 자동으로 만들지 않아요.",
  },
  {
    id: "imdsHopLimit",
    category: "workloads",
    title: "노드 IMDS hop limit 2 이상",
    why: "hop limit이 2 이상이면 컨테이너 안의 프로세스도 인스턴스 메타데이터에 닿아 노드 IAM 역할의 자격 증명을 가져갈 수 있어요(Pod가 노드 역할을 쓰게 돼요).",
    remedy: "시작 템플릿의 metadata_options.http_put_response_hop_limit을 1로 하고 노드를 교체하세요. Pod의 AWS 권한은 IRSA나 Pod Identity로 주세요.",
  },
];

export const CHECK_BY_ID: Record<CheckId, CheckInfo> = Object.fromEntries(CHECKS.map((c) => [c.id, c])) as Record<CheckId, CheckInfo>;
