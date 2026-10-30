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
export const SIDEBAR_ROW = "☸️ 클러스터 관리";
export const PICKER_TITLE = "EKS 클러스터";
export const PICKER_EMPTY = "이 리전에 EKS 클러스터가 없어요";

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
