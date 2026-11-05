import type { KvAuthMode, KvFeature, KvType } from "./types";

/** 탭 제목 */
export const tabTitle = (id: string) => `⚡ ${id}`;

export const TARGET_LOADING = "대상을 확인하는 중이에요";
export const CONNECTING = "연결하는 중이에요";
export const LOADING = "불러오는 중…";
export const READING = "읽는 중…";
export const REREAD = "다시 읽기";
export const COPY = "복사";
export const COPIED = "복사했어요";
export const COPY_FAILED = "복사하지 못했어요";
export const DASH = "—";

export const CONNECTION = {
  connecting: { dot: "yellow", label: "연결 중…" },
  connected: { dot: "green", label: "연결됨" },
  failed: { dot: "red", label: "연결 안 됨" },
} as const;

export const MODE_LABEL = { cluster: "클러스터 모드", standalone: "단일 엔드포인트", serverless: "서버리스" } as const;
export const NODE_COUNT = (n: number) => `노드 ${n}개`;
export const LOGIN_LABEL = "로그인";
export const LOGIN_CHANGE = "바꾸기";
export const FORGET_PASSWORD = "저장한 비밀번호 지우기";
export const PASSWORD_FORGOTTEN = "저장한 비밀번호를 지웠어요";
export const DATABASE_LABEL = "DB 번호";
export const databaseOption = (n: number) => `DB ${n}`;

// 메뉴
export const NAV_LABEL = "Valkey·Redis 메뉴";
export const NAV_ICON = { keys: "🔑", bull: "🐂", overview: "📊", slowlog: "🐢", clients: "👥", bigkeys: "🐘" } as const;
/** 서버리스에서 막힌 기능을 끄면서 밝히는 이유 */
export const UNSUPPORTED: Record<KvFeature, string> = {
  slowlog: "서버리스 캐시는 Slow log를 볼 수 없어요",
  clients: "서버리스 캐시는 클라이언트 목록을 볼 수 없어요",
  memory: "서버리스 캐시는 메모리 사용량을 볼 수 없어요",
  encoding: "서버리스 캐시는 인코딩을 볼 수 없어요",
};
export const NOT_AVAILABLE = "볼 수 없음";
export const NAV_BACK = "뒤로";
export const NAV_FORWARD = "앞으로";
export const CRUMB_LABEL = "현재 위치";
export const INFO_GROUP = "연결 정보";

// 로그인
export const LOGIN_TITLE = "로그인";
export const LOGIN_INTRO = "이 캐시에 접속할 방식을 고르세요. 방식과 사용자는 이 대상에 대해 기억해 둘게요";
export const MODE_GROUP = "로그인 방식";
export const MODES: Record<KvAuthMode, { label: string; hint: string }> = {
  none: { label: "로그인 없음", hint: "AUTH를 보내지 않아요" },
  password: { label: "AUTH 토큰", hint: "사용자 이름 없이 토큰만" },
  user: { label: "사용자", hint: "RBAC 사용자 이름과 비밀번호" },
  iam: { label: "IAM", hint: "연결할 때마다 토큰을 새로 만들어요" },
};
export const IAM_UNSUPPORTED = "IAM 인증은 TLS가 켜진 Valkey 7.2+ · Redis OSS 7.0+ 캐시에서만 돼요";
export const USER_GROUP = "사용자";
export const USER_INPUT = "사용자 이름";
export const USERS_UNREADABLE = "사용자 목록을 읽지 못했어요. 이름을 직접 입력하세요";
export const AUTH_LABEL = { iam: "IAM", password: "비밀번호", "no-password": "비밀번호 없음" } as const;
export const TOKEN_LABEL = "AUTH 토큰";
export const PASSWORD_LABEL = "비밀번호";
export const PASSWORD_HINT = "비워 두면 키체인에 저장한 것을 써요";
export const REMEMBER_PASSWORD = "비밀번호 기억하기";
export const CONNECT = "연결";
export const CANCEL = "취소";
export const LOGIN_REQUIRED_DEFAULT = "이 캐시는 로그인이 필요해요";

// 키
export const PATTERN_LABEL = "패턴";
export const PATTERN_READ = "읽기";
export const TYPE_GROUP = "타입";
export const TYPE_ALL = "모든 타입";
export const KEY_TYPES: KvType[] = ["string", "hash", "list", "set", "zset", "stream", "json"];
export const DELIMITER_LABEL = "구분자";
export const KEYS_READ = (read: number, total: number | null) => (total === null ? `읽은 키 ${read.toLocaleString("ko-KR")}개` : `읽은 키 ${read.toLocaleString("ko-KR")}개 / 전체 약 ${total.toLocaleString("ko-KR")}개`);
export const MORE = "더 읽기";
export const READ_ALL = "끝까지 읽었어요";
export const KEYS_EMPTY = "키가 없어요";
export const KEYS_NO_MATCH = "조건에 맞는 키가 없어요";
export const KEY_TREE = "키 목록";
export const FOLDER_COUNT = (n: number) => `${n.toLocaleString("ko-KR")}`;
export const BINARY_NAME = "바이너리";
export const FIND_PLACEHOLDER = "읽은 키에서 찾기";
export const NO_EXPIRY = "만료 없음";

// 값 상세
export const DETAIL_LABEL = "상세";
export const KEY_COPY_LABEL = "키 이름";
export const KEY_COPY_LABEL_BINARY = "키 이름(바이너리, base64)";
export const ROW_TYPE = "타입";
export const ROW_TTL = "TTL";
export const ROW_LENGTH = "길이";
export const ROW_MEMORY = "메모리";
export const ROW_ENCODING = "인코딩";
export const LENGTH_UNIT: Record<KvType, string> = { string: "바이트", hash: "필드", list: "원소", set: "원소", zset: "원소", stream: "항목", json: "바이트", other: "" };
export const TRUNCATED = "앞 1MiB만 보여요";
export const VIEW_JSON = "JSON";
export const VIEW_TEXT = "텍스트";
export const VIEW_HEX = "16진수";
export const VIEW_BASE64 = "Base64";
export const VIEW_GROUP = "보기 방식";
export const EXPAND_ALL = "모두 펼치기";
export const COLLAPSE_ALL = "모두 접기";
export const HEX_TRUNCATED = (shown: string) => `앞 ${shown}만 16진수로 보여요. 복사는 전부 해요`;
export const BINARY_VALUE = "바이너리";
export const BYTES = (n: number) => `${n.toLocaleString("ko-KR")}바이트`;
export const COL_FIELD = "필드";
export const COL_VALUE = "값";
export const COL_INDEX = "인덱스";
export const COL_MEMBER = "멤버";
export const COL_RANK = "순위";
export const COL_SCORE = "점수";
export const COL_ID = "ID";
export const COL_ENTRY = "필드·값";
export const STREAM_LENGTH = "길이";
export const STREAM_GROUPS = "그룹 수";
export const STREAM_FIRST = "첫 ID";
export const STREAM_LAST = "마지막 ID";
export const VALUE_READ = (read: number, total: number | null) => (total === null ? `${read.toLocaleString("ko-KR")}개 읽음` : `${read.toLocaleString("ko-KR")}개 읽음 / 전체 ${total.toLocaleString("ko-KR")}개`);
export const OTHER_TYPE = (name: string) => `이 타입(${name})의 값은 보여 줄 수 없어요`;
export const EMPTY_COLLECTION = "비어 있어요";

// 개요
export const OVERVIEW_LABEL = "개요";
export const CARD_MEMORY = "메모리";
export const CARD_HITS = "히트율";
export const CARD_OPS = "초당 명령";
export const CARD_CLIENTS = "연결 클라이언트";
export const CARD_KEYS = "키";
export const CARD_EVICTED = "축출·만료 키";
export const CARD_UPTIME = "가동 시간";
export const CARD_LAG = "복제 지연";
export const SECTION_NODES = "노드";
export const SECTION_KEYSPACE = "키스페이스";
export const SERVERLESS_NODE_NOTE = "서버리스 캐시는 노드 하나로 보여요";
export const COL = {
  role: "역할",
  address: "주소",
  shard: "샤드",
  slots: "슬롯",
  memory: "메모리",
  clients: "연결",
  ops: "초당 명령",
  lag: "복제 지연",
  uptime: "가동 시간",
  version: "버전",
  db: "DB",
  keys: "키",
  expires: "만료 설정",
};
export const ROLE_LABEL = { primary: "기본", replica: "복제" } as const;
export const PEAK = "피크";
export const FRAGMENTATION = "단편화";
export const HITS_MISSES = (h: string, m: string) => `히트 ${h} · 미스 ${m}`;
export const OPS_NOTE = "기본 노드 합계";
export const EVICTED = "축출";
export const EXPIRED = "만료";
export const LAG_SECONDS = (s: number) => `${s}초`;

// Slow log·클라이언트
export const SLOWLOG_LABEL = "Slow log 목록";
export const SLOWLOG_COLS = { time: "시각", node: "노드", took: "걸린 시간", command: "명령", client: "클라이언트" };
export const SLOWLOG_EMPTY = "느린 명령이 없어요";
export const SLOWLOG_NO_MATCH = "조건에 맞는 항목이 없어요";
export const COMMAND_LIMIT = 200;
export const CLIENTS_LABEL = "클라이언트 목록";
export const CLIENTS_COLS = { addr: "주소", name: "이름", user: "사용자", db: "DB", age: "나이", idle: "유휴", cmd: "마지막 명령", flags: "플래그", node: "노드" };
export const CLIENTS_EMPTY = "연결된 클라이언트가 없어요";
export const OWN_CLIENT = "이 앱";
export const CLIENTS_TABLE = "표";
export const CLIENT_MAP_TITLE = "클라이언트 지도";
export const CLIENT_MAP_CONNS = (n: string) => `연결 ${n}`;
export const CLIENT_MAP_HOSTS = (n: number) => `호스트 ${n}`;
export const CLIENT_MAP_LEGEND = "호스트 → 연결 이름(🐂 Bull 큐) · 선 굵기는 연결 수";
export const CLIENT_MAP_LEGEND_NODES = "호스트 → 연결 이름(🐂 Bull 큐) → 노드 · 선 굵기는 연결 수";

// 큰 키
export const BIGKEYS_INTRO = "SCAN으로 최대 5,000개 키를 훑으며 키마다 메모리를 재서 상위 50개를 찾아요. 서버에 부담이 가지 않게 샘플링해요";
export const BIGKEYS_FIND = "찾기";
export const BIGKEYS_STOP = "중단";
export const BIGKEYS_RUNNING = (scanned: number, total: number) => (total > 0 ? `${scanned.toLocaleString("ko-KR")} / ${total.toLocaleString("ko-KR")}개 훑는 중…` : `${scanned.toLocaleString("ko-KR")}개 훑는 중…`);
export const BIGKEYS_STOPPING = "중단하는 중…";
export const BIGKEYS_DONE = (scanned: number) => `${scanned.toLocaleString("ko-KR")}개를 훑었어요`;
export const BIGKEYS_STOPPED = (scanned: number) => `${scanned.toLocaleString("ko-KR")}개를 훑고 중단했어요`;
export const BIGKEYS_BASIS_LENGTH = "서버리스는 MEMORY를 쓸 수 없어 길이(원소 수·바이트)로 대신했어요";
export const BIGKEYS_BASIS_MEMORY = "MEMORY USAGE 기준(샘플링)";
export const BIGKEYS_EMPTY = "찾은 키가 없어요";
export const BIGKEYS_LABEL = "큰 키 목록";
export const BIGKEYS_COLS = { rank: "순위", key: "키", type: "타입", size: "크기" };
export const BIGKEYS_ELEMENTS = (n: number) => `${n.toLocaleString("ko-KR")}개`;
export const EMPTY_LABEL = "(빈 이름)";
export const BIGKEYS_IDLE = "[찾기]를 누르면 시작해요";

// 🐂 그래프
export const TRANSITIONS_TITLE = "상태 전이";
export const TRANSITIONS_WINDOW = "구간";
export const TRANSITIONS_EVENTS = (events: string, moves: string) => `이벤트 ${events}개 · 전이 ${moves}회`;
export const TRANSITIONS_TRIMMED = (minutes: number) => `스트림에 남은 최근 ${minutes}분만 보여요`;
export const TRANSITIONS_TRUNCATED = (events: string) => `이벤트가 많아 앞쪽 ${events}개만 읽었어요. 가장 최근 쪽이 빠졌을 수 있어요`;
export const TRANSITIONS_EMPTY = "이 구간에 이벤트가 없어요. events 스트림이 꺼져 있거나 비어 있을 수 있어요";
export const TRANSITIONS_NEW_SUB = "추가된 작업";
export const TRANSITIONS_NOW = (n: string, label: string) => `지금 ${label} ${n}`;
export const TRANSITIONS_OTHER = "그 밖의 이벤트";
export const FLOW_GRAPH = "흐름 그래프";
export const FLOW_BIG = "크게 보기";
export const FLOW_CLOSE = "닫기";
export const MAP_CARDS = "카드";
export const MAP_MAP = "지도";
export const MAP_VIEW = "보기 방식";
export const MAP_LOADING = "큐 지도를 그리는 중이에요…";
export const MAP_SAMPLED = (n: string) => `작업 ${n}개의 부모 키를 읽어 큐를 이었어요`;
export const MAP_NO_WORKERS = "워커를 읽을 수 없어 워커 호스트는 그리지 않아요";
export const MAP_EMPTY = "그릴 큐가 없어요";
export const TOPOLOGY_TITLE = "토폴로지";
export const TOPOLOGY_LOADING_CLIENTS = "클라이언트를 읽는 중이에요…";
export const TOPOLOGY_NO_CLIENTS = "클라이언트 목록을 읽지 못해 클라이언트 호스트는 그리지 않아요";
