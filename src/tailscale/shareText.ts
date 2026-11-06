export const TITLE = "공유";
export const SERVE = "Serve 상태";
export const FUNNEL = "Funnel 상태";
export const SEC_SERVE = "공유 중인 경로";
export const SEC_SERVE_DESC = "이 Mac이 테일넷(Serve)이나 인터넷(Funnel)에 공유하는 주소예요. 줄마다 지우거나 Funnel을 끌 수 있어요.";
export const ROWS_EMPTY = "공유 중인 경로가 없어요";
export const ROWS_PARSE_ERROR = "공유 상태를 표로 읽지 못했어요. 원문 보기에서 확인해 주세요.";
export const COL_ADDRESS = "주소";
export const COL_PROTO = "방식";
export const COL_PATH = "경로";
export const COL_TARGET = "대상";
export const COL_FUNNEL = "Funnel";
export const THIS_DEVICE = "이 기기";
export const KIND: Record<string, string> = {
  proxy: "프록시",
  path: "파일·폴더",
  text: "텍스트",
  redirect: "리디렉션",
  tcp: "TCP 전달",
  "tls-tcp": "TLS 종단 TCP",
  none: "—",
};
export const REMOVE = "제거…";
export const FUNNEL_OFF = "Funnel 끄기…";
export const removeLabel = (target: string) => `제거: ${target}`;
export const funnelOffLabel = (target: string) => `Funnel 끄기: ${target}`;
export const NOT_REMOVABLE = "이 앱에서는 지울 수 없는 경로예요";
export const FOREGROUND = "임시";
export const RAW = "원문 보기";
export const ON = "켜짐";
export const OFF_STATE = "꺼짐";
export const SEC_SERVICES = "Services";
export const SEC_SERVICES_DESC = "이 기기가 접근할 수 있는 Tailscale Service예요. 아래에서 이 기기를 Service 호스트로 광고하거나 내릴 수 있어요.";
export const SERVICES_EMPTY = "접근할 수 있는 Services가 없어요";
export const COL_SERVICE = "이름";
export const COL_HOST = "호스트";
export const COL_SERVICE_ADDRS = "주소";
export const COL_PORTS = "포트";
export const SERVICES_FORM = "호스트 광고와 내리기";
export const TAILDROP_DESC = "테일넷의 다른 기기와 파일을 주고받아요.";
export const TARGETS = "Taildrop 대상";
export const TARGETS_EMPTY = "파일을 보낼 수 있는 기기가 없어요";
export const COL_DEVICE = "기기";
export const COL_IP = "IP 주소";
export const COL_STATUS = "상태";
export const ONLINE = "온라인";
export const OFFLINE = "오프라인";
export const lastSeen = (age: string) => `마지막 접속 ${age} 전`;
export const SEND_GROUP = "보내기";
export const RECEIVE_GROUP = "받기";
export const RECEIVE_HINT = "다른 기기가 보낸 파일을 이 폴더로 받아요.";
export const CERT_DESC = "이 기기의 MagicDNS 이름으로 HTTPS 인증서와 키를 받아 폴더에 저장해요.";
export const MAPPING_DESC = "로컬 포트·경로·URL을 테일넷이나 인터넷에 공유해요. 실행하기 전에 명령을 미리 보여줘요.";
export const REFRESH = "새로고침";
export const MAPPING = "공유 경로 추가";
export const SCOPE = "공개 범위";
export const LOCAL = "테일넷";
export const PUBLIC = "인터넷 (Funnel)";
export const SERVICE = "Service 이름 (svc:이름)";
export const PORT = "공개 포트";
export const PROTOCOL = "프로토콜";
export const TARGET = "로컬 포트·경로·URL";
export const PATH = "공개 경로 (선택)";
export const ADD = "공유…";
export const OFF = "이 경로 끄기…";
export const RESET_SERVE = "Serve 초기화…";
export const RESET_FUNNEL = "Funnel 초기화…";
export const ADVERTISE = "서비스 광고…";
export const DRAIN = "서비스 드레인…";
export const CLEAR = "서비스 설정 지우기…";
export const FILES = "보낼 파일 절대 경로 (한 줄에 하나)";
export const PEER = "받을 기기";
export const SEND = "파일 보내기…";
export const FOLDER = "폴더 절대 경로";
export const RECEIVE = "파일 받기…";
export const DOMAIN = "인증서 도메인";
export const CERT = "인증서 받기…";
export const PREVIEW = "명령 미리보기";
export const CONFIRM = "실행";
export const CANCEL = "닫기";
export const TYPE_CONFIRM = "확인하려면 입력해 주세요";
export const DONE = "명령을 실행했어요";
export const PICK_FILES = "파일 선택…";
export const PICK_FOLDER = "폴더 선택…";
export const TAILDROP_SECTION = "Taildrop";
export const CERT_SECTION = "HTTPS 인증서";
