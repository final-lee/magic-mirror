import type { LbKind, MatchedBy, NetworkSection, SourceKind, Unmatched } from "./types";

// ── 화면 ──
export const NAV_NETWORK = "네트워크";
export const NETWORK_LABEL = "네트워크";
export const TAB_LOAD_BALANCERS = "로드밸런서";
export const TAB_NODES_SUBNETS = "노드·서브넷";
export const TAB_POD_IPS = "Pod IP";
export const TAB_POLICIES = "NetworkPolicy";
export const NETWORK_TABS_LABEL = "네트워크 보기";
export const LOADING = "네트워크 정보를 불러오는 중…";
export const REFRESH = "새로고침";
export const OPEN_VPC = "VPC 다이어그램 열기";
export const OPEN_VPC_UNKNOWN = "클러스터의 VPC를 알 수 없어요. EKS 정보를 읽지 못했어요";
export const OPEN_VPC_TITLE = "클러스터의 노드와 로드 밸런서를 강조해서 VPC 다이어그램을 열어요";
export const CLOSE = "닫기";
export const NONE = "없음";
export const DASH = "—";

// ── 읽지 못한 부분 ──
export const SECTION_LABELS: Record<NetworkSection, string> = {
  cluster: "클러스터 VPC", services: "Service", ingresses: "Ingress", nodes: "노드", pods: "Pod", policies: "NetworkPolicy",
  namespaces: "네임스페이스", instances: "EC2 인스턴스", subnets: "서브넷", loadBalancers: "로드 밸런서", listeners: "리스너",
  targetGroups: "대상 그룹", targetHealth: "대상 상태",
};
export const GAPS_LABEL = "읽지 못한 부분";
export const gapLine = (sections: string[]) => `이 부분을 읽지 못했어요: ${sections.join(", ")}`;

// ── 로드 밸런서 ──
export const LB_LIST_LABEL = "Service·Ingress와 로드 밸런서";
export const LB_EMPTY = "로드 밸런서를 쓰는 Service(LoadBalancer)나 Ingress가 없어요";
export const LB_TABLE_LABEL = "로드 밸런서 목록";
export const H_SOURCE = "종류";
export const H_NAME = "이름";
export const H_ADDRESS = "주소";
export const H_LOAD_BALANCER = "로드 밸런서";
export const H_LISTENERS = "리스너";
export const H_TARGET_HEALTH = "대상 상태";
export const H_MATCH = "짝";
export const SOURCE_LABELS: Record<SourceKind, string> = { service: "Service", ingress: "Ingress" };
export const LB_KIND_LABELS: Record<LbKind, string> = { application: "ALB", network: "NLB", gateway: "GWLB" };
export const MATCHED_BY_LABELS: Record<MatchedBy, string> = {
  hostname: "주소(호스트명)로 찾음",
  tag: "컨트롤러 태그로 찾음",
  both: "주소와 태그가 모두 맞음",
};
export const UNMATCHED_LABELS: Record<Unmatched, string> = {
  pending: "주소가 아직 없어요",
  notFound: "ELBv2에서 찾지 못했어요(클래식 로드 밸런서일 수 있어요)",
  awsUnavailable: "AWS를 읽지 못해 찾아보지 못했어요",
};
export const UNMATCHED_SHORT: Record<Unmatched, string> = { pending: "주소 없음", notFound: "찾지 못함", awsUnavailable: "AWS 읽기 실패" };
export const HEALTHY = "정상";
export const UNHEALTHY = "비정상";
export const OTHER_STATE = "그 밖";
export const NO_TARGETS = "대상 없음";
export const healthSummary = (healthy: number, unhealthy: number, other: number) =>
  [`${HEALTHY} ${healthy}`, unhealthy > 0 ? `${UNHEALTHY} ${unhealthy}` : null, other > 0 ? `${OTHER_STATE} ${other}` : null].filter(Boolean).join(" · ");
export const UNCLAIMED_TITLE = "이 클러스터 태그가 붙었지만 짝이 없는 로드 밸런서";
export const UNCLAIMED_NOTE = "어떤 Service·Ingress도 가리키지 않아요. 지워진 객체의 잔재이거나 다른 이름으로 만든 것일 수 있어요.";
export const H_STACK = "stack 태그";
export const H_TYPE = "유형";
export const H_SCHEME = "범위";

// ── 로드 밸런서 상세 ──
export const DETAIL_LABEL = "네트워크 상세";
export const OPEN_IN_WORKLOADS = "워크로드에서 열기";
export const OPEN_LB_IN_VPC = "VPC 다이어그램에서 보기";
export const SEC_SUMMARY = "요약";
export const SEC_LOAD_BALANCER = "로드 밸런서";
export const SEC_LISTENERS = "리스너";
export const SEC_TARGET_GROUPS = "대상 그룹";
export const SEC_RULES = "규칙";
export const L_CLASS = "클래스";
export const L_HOSTNAMES = "주소";
export const L_PORTS = "포트";
export const L_RULES = "규칙";
export const L_MATCH = "짝 찾은 방법";
export const L_NAME = "이름";
export const L_DNS = "DNS";
export const L_TYPE = "유형";
export const L_SCHEME = "범위";
export const L_STATE = "상태";
export const L_VPC = "VPC";
export const L_ZONES = "AZ·서브넷";
export const L_SECURITY_GROUPS = "보안 그룹";
export const L_GROUP = "Ingress 그룹";
export const H_PROTOCOL_PORT = "프로토콜:포트";
export const H_TLS_POLICY = "TLS 정책";
export const H_DEFAULT_ACTION = "기본 동작";
export const H_RULE_COUNT = "규칙";
export const H_PRIORITY = "우선순위";
export const H_CONDITIONS = "조건";
export const H_ACTION = "동작";
export const H_TARGET = "대상";
export const H_PORT = "포트";
export const H_ZONE = "AZ";
export const H_STATE = "상태";
export const H_REASON = "사유";
export const H_LINK = "쿠버네티스";
export const NO_LISTENERS = "리스너가 없어요";
export const NO_TARGET_GROUPS = "대상 그룹이 없어요";
export const ruleCount = (n: number) => `규칙 ${n}개`;
export const healthCheckText = (protocol: string | null, port: string | null, path: string | null) =>
  [protocol, path ?? (port && port !== "traffic-port" ? port : null)].filter(Boolean).join(" ");
export const HEALTH_CHECK_OFF = "상태 확인 끔";
export const L_HEALTH_CHECK = "상태 확인";
export const targetGroupTitle = (name: string, protocol: string | null, port: number | null, type: string | null) =>
  `${name}${protocol ? ` · ${protocol}${port ? `:${port}` : ""}` : ""}${type ? ` · ${type}` : ""}`;
export const STATE_LABELS: Record<string, string> = {
  healthy: "정상", unhealthy: "비정상", initial: "등록 중", draining: "해제 중", unused: "사용 안 함", unavailable: "확인 불가",
};
export const openLink = (kind: string, name: string) => `${kind} ${name}을 워크로드에서 열기`;
export const subjectGap = (subject: string, section: string) => `${section} (${subject})`;

// ── 노드·서브넷 ──
export const NODES_TITLE = "노드";
export const SUBNETS_TITLE = "서브넷";
export const NODES_TABLE_LABEL = "노드 목록";
export const SUBNETS_TABLE_LABEL = "서브넷 목록";
export const NODES_EMPTY = "노드가 없어요";
export const SUBNETS_EMPTY = "서브넷 정보가 없어요";
export const H_NODE = "노드";
export const H_READY = "준비";
export const H_INSTANCE = "인스턴스";
export const H_INSTANCE_TYPE = "인스턴스 유형";
export const H_INSTANCE_STATE = "EC2 상태";
export const H_SUBNET = "서브넷";
export const H_INTERNAL_IP = "내부 IP";
export const H_CIDR = "CIDR";
export const H_FREE_IPS = "남은 IP";
export const H_NODE_COUNT = "노드";
export const H_POD_COUNT = "Pod";
export const READY = "Ready";
export const NOT_READY = "NotReady";
export const FARGATE = "Fargate";
export const FARGATE_TITLE = "Fargate 노드는 EC2 인스턴스가 없어요";
export const UNUSED_SUBNET = "노드·Pod 없음";
export const SUBNET_NOTE = "남은 IP는 서브넷 기준이에요. VPC CNI가 노드마다 미리 잡아 둔 IP도 사용 중으로 세어져요.";
export const freeIps = (available: number | null, capacity: number | null) =>
  available === null ? DASH : capacity ? `${available} / ${capacity} (${Math.round((available / capacity) * 100)}%)` : `${available}`;

// ── Pod IP ──
export const POD_IP_TITLE = "서브넷별 Pod";
export const PODS_TABLE_LABEL = "Pod IP 목록";
export const PODS_EMPTY = "IP가 있는 Pod가 없어요";
export const NOT_VPC_CNI = "VPC CNI(aws-node)가 없어서 Pod IP는 서브넷에 속하지 않아요. Pod IP 목록만 보여요.";
export const VPC_CNI_NOTE = "VPC CNI라서 Pod IP를 서브넷에 이었어요. hostNetwork Pod는 노드 IP를 쓰니 세지 않아요.";
export const SUBNETS_UNKNOWN = "서브넷 정보를 읽지 못해 Pod IP를 서브넷에 잇지 못했어요.";
export const outsideNote = (n: number) => `어느 서브넷에도 속하지 않는 Pod IP가 ${n}개 있어요(보조 CIDR이나 읽지 못한 서브넷일 수 있어요).`;
export const PODS_PARTIAL = "Pod가 많아서 일부만 읽었어요. 서브넷별 개수는 읽은 Pod 기준이에요.";
export const H_POD = "Pod";
export const H_NAMESPACE = "네임스페이스";
export const H_IP = "IP";
export const H_HOST_NETWORK = "hostNetwork";
export const HOST_NETWORK_MARK = "노드 IP";
export const POD_FILTER_LABEL = "Pod 찾기";
export const POD_FILTER_PLACEHOLDER = "Pod 이름·IP·노드·서브넷";
export const podsShown = (shown: number, total: number) => `${total}개 중 ${shown}개를 보여요. 검색으로 좁혀 보세요.`;

// ── NetworkPolicy ──
export const POLICY_TABLE_LABEL = "NetworkPolicy 목록";
export const POLICY_EMPTY = "NetworkPolicy가 없어요";
export const NS_WITHOUT_TITLE = "NetworkPolicy가 없는 네임스페이스";
export const NS_WITHOUT_NONE = "모든 네임스페이스에 NetworkPolicy가 있어요";
export const NS_SYSTEM_NOTE = "시스템 네임스페이스는 흐리게 보여요";
export const nsWithoutCount = (n: number) => `${n}개 (시스템 네임스페이스 제외)`;
export const H_POLICY = "이름";
export const H_POD_SELECTOR = "대상 Pod";
export const H_DIRECTIONS = "방향";
export const H_INGRESS = "인그레스 규칙";
export const H_EGRESS = "이그레스 규칙";
export const ALL_PODS = "네임스페이스의 모든 Pod";
export const ALL_NAMESPACES = "모든 네임스페이스";
export const ALL_PEERS_PODS = "모든 Pod";
export const DIRECTION_LABELS: Record<string, string> = { Ingress: "들어오는 트래픽", Egress: "나가는 트래픽" };
export const ANY_PORT = "모든 포트";
export const ANYWHERE = "모든 곳";
export const POLICY_NOTE = "목록과 규칙 요약만 보여요. 실제로 막히는 트래픽은 계산하지 않아요.";
export const SEC_POLICY_SUMMARY = "요약";
export const SEC_POLICY_INGRESS = "들어오는 트래픽(Ingress)";
export const SEC_POLICY_EGRESS = "나가는 트래픽(Egress)";
export const DENY_ALL = "모두 차단 — 허용하는 규칙이 없어요";
export const ALLOW_ALL = "모두 허용";
export const NOT_ISOLATED = "이 방향은 정책이 다루지 않아요(제한 없음)";
export const policyPods = (selector: string) => (selector === "" ? ALL_PODS : selector);
export const peerPod = (selector: string) => (selector === "" ? "모든 Pod" : `Pod ${selector}`);
export const peerNamespace = (selector: string) => (selector === "" ? "모든 네임스페이스" : `네임스페이스 ${selector}`);
export const peerIp = (cidr: string, except: string[]) => (except.length > 0 ? `IP ${cidr} (제외 ${except.join(", ")})` : `IP ${cidr}`);
export const ruleFrom = (direction: "ingress" | "egress", peers: string) => (direction === "ingress" ? `출발: ${peers}` : `도착: ${peers}`);
export const rulePorts = (ports: string) => `포트: ${ports}`;
export const ruleNumber = (n: number) => `규칙 ${n}`;
export const OPEN_POLICY_IN_WORKLOADS = "워크로드에서 열기(YAML)";
