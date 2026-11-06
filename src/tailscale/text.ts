import type { TsCheckStatus } from "./types";

export const DIAGNOSE = "Tailscale 진단";
export const RUNNING = "진단하는 중…";
export const REDIAGNOSE = "다시 진단";
export const ENABLE_ROUTES = "경로 받기 켜기";
export const ENABLE_ROUTES_OPEN = "경로 받기 켜기…";
export const UNDO = "되돌리기";
export const UNDO_OPEN = "되돌리기…";
export const APPLY = "적용";
export const CANCEL = "취소";
export const EFFECT_ENABLE = "이 Mac이 테일넷의 서브넷 경로를 받아요. 다른 기기 설정은 바뀌지 않아요.";
export const EFFECT_DISABLE = "이 Mac이 테일넷의 서브넷 경로를 받지 않아요. 다른 기기 설정은 바뀌지 않아요.";
export const TAILNET = "테일넷";
export const ADDRESS_UNKNOWN = "주소를 확인하지 못했어요";
export const STATUS: Record<TsCheckStatus, { mark: string; label: string }> = {
  ok: { mark: "✓", label: "정상" },
  warn: { mark: "!", label: "주의" },
  fail: { mark: "✗", label: "실패" },
  skip: { mark: "–", label: "건너뜀" },
};

export const backendState = (state: string | null | undefined) => ({
  Running: "연결됨",
  Stopped: "꺼짐",
  NeedsLogin: "로그인 필요",
  NeedsMachineAuth: "기기 승인 필요",
  Starting: "연결 중",
  NoState: "상태 없음",
} as Record<string, string>)[state ?? ""] ?? state ?? UNKNOWN;
export const LOADING = "Tailscale 상태를 읽는 중이에요…";
export const CLI_MISSING = "Tailscale 앱을 설치하면 이 Mac의 연결 상태를 볼 수 있어요.";
export const TABS_LABEL = "Tailscale 보기";
export const TAB_MAC = "이 Mac";
export const TAB_PEERS = "기기";
export const TAB_POLICY = "정책";
export const ROUTES_TITLE = "경로";
export const FINDING_DEVICES = "지적 있는 기기";
export const REFRESH = "다시 읽기";
export const TAB_DIAGNOSIS = "진단";
export const UNKNOWN = "알 수 없음";
export const NONE = "안 씀";
export const ON = "켜짐";
export const OFF = "꺼짐";
export const BACKEND_STATE = "연결 상태";
export const MAGIC_DNS = "MagicDNS 접미사";
export const USER = "사용자";
export const DEVICE_NAME = "기기 이름";
export const DNS_NAME = "DNS 이름";
export const IPS = "IP 주소";
export const CLI_VERSION = "CLI 버전";
export const CLI_PATH = "CLI 경로";
export const KEY_EXPIRY = "키 만료";
export const ACCEPT_ROUTES = "경로 받기";
export const ACCEPT_DNS = "DNS 받기";
export const EXIT_NODE = "exit node";
export const SHIELDS_UP = "shields up";
export const SSH = "Tailscale SSH 서버";
export const AUTO_UPDATE = "자동 업데이트";
export const ADVERTISE_ROUTES = "광고하는 경로";
export const ADVERTISE_EXIT = "exit node 광고";
export const ALL = "모두";
export const ONLINE = "온라인";
export const OFFLINE = "오프라인";
export const SUBNET_ROUTER = "서브넷 라우터";
export const PEERS_LOADING = "연결 상태를 확인하고 있어요.";
export const CLI_DESCRIPTION = "이 Mac에서 보이는 기기만 보여요.";
export const ACTIVE_EXIT = "사용 중 exit node";
export const FILTER = "기기 검색";
export const NO_MATCH = "조건에 맞는 기기가 없어요.";
export const NAME = "이름";
export const OS = "OS";
export const STATE = "상태";
export const CONNECTION = "연결";
export const ROLE = "역할";
export const TAGS = "태그";
export const OWNER = "소유자";
export const DIRECT = "직접";
export const relay = (name: string) => `릴레이 ${name}`;
export const lastSeen = (date: string) => `마지막 접속: ${date}`;
export const ACL_NOTE = "이 Mac의 ACL로 보이는 기기만 나와요.";
export const ADDRESS_LABEL = "URL 또는 호스트[:포트]";
export const DIAGNOSE_BUTTON = "진단";
export const COPY_IP = "IP 주소 복사";

export const TAB_CONNECT = "연결";
export const API_REQUIRED = "연결 탭에서 Tailscale API를 연결해 주세요";
export const API_REQUIRED_BUTTON = "연결 탭 열기";
export const API_LOADING = "Tailscale API 연결을 확인하는 중이에요…";
export const CONNECT_HELP = "Tailscale 관리 콘솔의 Settings → Trust credentials에서 만들 수 있어요. 자격 증명은 이 Mac의 키체인에만 저장해요.";
export const CONNECT_SCOPE_HELP = "OAuth 클라이언트에는 스코프 all:read를 권장해요. 쓰기가 필요한 작업이 있으면 그 쓰기 스코프(예: devices:core, policy_file)도 더해 주세요. 쓸 때만 그 스코프의 토큰을 따로 받아요.";
export const CONNECT_TOKEN_HELP = "API 액세스 토큰은 모든 요청에 그대로 쓰고, 스코프를 따로 고르지 않아요. 만료되면 새로 넣어 주세요.";
export const TAILNET_LABEL = "테일넷 이름";
export const KIND_LABEL = "자격 증명 종류";
export const KIND_OAUTH = "OAuth 클라이언트";
export const KIND_OAUTH_NOTE = "권장";
export const KIND_TOKEN = "API 액세스 토큰";
export const CLIENT_ID = "클라이언트 ID";
export const CLIENT_SECRET = "클라이언트 시크릿";
export const API_TOKEN = "API 액세스 토큰 값";
export const CONNECT = "연결";
export const CONNECTING = "연결하는 중…";
export const CHANGE = "바꾸기";
export const FORGET = "지우기";
export const CANCEL_CHANGE = "취소";
export const NOT_CONNECTED = "아직 연결하지 않았어요";
export const connected = (tailnet: string, kind: string) => `연결됨: ${tailnet} (${kind})`;
export const connectResult = (devices: number) => `기기 ${devices}대를 읽었어요`;
export const MAGIC_DNS_RESULT = "MagicDNS 접미사";
export const TAILNET_MISMATCH = "이 Mac의 테일넷과 달라요";
export const tailnetMismatch = (mine: string) => `${TAILNET_MISMATCH} (이 Mac: ${mine})`;
