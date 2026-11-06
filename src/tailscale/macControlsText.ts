export const SEC_CONNECT = "연결";
export const SEC_CONNECT_DESC = "Tailscale 연결을 켜고 끄거나 계정을 로그인·로그아웃해요. 실행하기 전에 명령을 미리 보여줘요.";
export const CONNECT = "Tailscale 연결…";
export const DISCONNECT = "연결 해제…";
export const DISCONNECT_WARNING = "연결을 해제하면 이 앱이 테일넷 서버에 접속하지 못할 수 있어요.";
export const LOGIN = "로그인…";
export const LOGOUT = "로그아웃…";
export const LOGOUT_WARNING = "로그아웃하면 이 기기의 노드 키가 만료돼요.";
export const UPDATE_CHECK = "업데이트 확인";
export const UPDATE = "업데이트…";
export const SEC_PREFS = "설정";
export const SEC_PREFS_DESC = "이 Mac의 Tailscale 동작이에요. 바꾸면 실행할 명령을 먼저 보여줘요.";
export const PREFS_EMPTY = "읽어 온 설정이 없어요";
export const COL_PREF = "설정";
export const COL_VALUE = "현재 값";
export const COL_CHANGE = "변경";
export const TURN_ON = "켜기…";
export const TURN_OFF = "끄기…";
export const APPLY = "변경…";
export const CANCEL = "취소";
export const CONFIRM = "실행";
export const UNDO = "되돌리기";
export const undoPreference = (label: string) => `${UNDO}: ${label}…`;
export const NO_EXIT = "안 쓰기";
export const EXIT_LABEL = "Exit node 고르기";
export const EXIT_SUGGESTED = "추천";
export const USE_SUGGESTED = "추천 노드 선택";
export const EXIT_LIST_ERROR = "Exit node 목록을 읽지 못했어요";
export const EMPTY_VALUE = "비어 있음";
export const SEC_ACCOUNTS = "계정";
export const SEC_ACCOUNTS_DESC = "이 Mac에 로그인한 Tailscale 계정이에요. 다른 계정으로 전환할 수 있어요.";
export const ACCOUNTS_EMPTY = "로그인한 계정이 없어요";
export const COL_ACCOUNT = "계정";
export const COL_TAILNET = "테일넷";
export const COL_STATE = "상태";
export const IN_USE = "사용 중";
export const SWITCH = "전환…";
export const REMOVE = "제거…";
export const SEC_METRICS = "메트릭";
export const SEC_METRICS_DESC = "Tailscale 데몬이 내보내는 지표예요.";
export const METRICS = "메트릭 보기";
export const FILTER = "메트릭 필터";
export const TYPE_CONFIRM = "확인하려면 다음을 입력해 주세요";
export const RESULT = "결과";
export const SEC_STATUS = "상태";
export const SEC_STATUS_DESC = "이 Mac의 Tailscale 연결과 기기 정보예요.";

/** `tailscale set --<키>` 설정 이름 → 화면에 보이는 한국어 이름. 원래 이름은 tooltip으로 보여줘요. */
export const PREF_LABELS: Record<string, string> = {
  "accept-dns": "Tailscale DNS 사용",
  "accept-routes": "서브넷 경로 받기",
  "advertise-connector": "앱 커넥터로 광고",
  "advertise-exit-node": "Exit node로 광고",
  "advertise-routes": "광고할 서브넷 경로",
  "auto-update": "자동 업데이트",
  "exit-node": "Exit node",
  "exit-node-allow-lan-access": "Exit node 중 로컬 네트워크 허용",
  hostname: "기기 이름 지정",
  nickname: "계정 별명",
  operator: "운영자 계정",
  "relay-server-port": "릴레이 서버 포트",
  "relay-server-static-endpoints": "릴레이 서버 고정 주소",
  "report-posture": "기기 상태 보고",
  "shields-up": "들어오는 연결 막기",
  ssh: "Tailscale SSH 서버",
  "update-check": "새 버전 알림",
  webclient: "웹 클라이언트",
};
export const prefLabel = (key: string) => PREF_LABELS[key] ?? key;
