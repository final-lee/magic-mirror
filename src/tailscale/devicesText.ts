export const FINDINGS: Record<string, string> = {
  expired: "키 만료됨",
  expiring: "키 만료 임박",
  expiryDisabled: "키 만료 꺼짐",
  stale: "30일 넘게 안 보임",
  untaggedLinux: "태그 없는 Linux",
  update: "업데이트 있음",
  unauthorized: "승인 대기",
};
export const ALL = "모두";
export const ONLINE = "온라인";
export const OFFLINE = "오프라인";
export const ROUTER = "서브넷 라우터";
export const EXIT_NODE = "Exit node";
export const DEVICES_LOADING = "기기를 불러오는 중이에요.";
export const SEARCH = "기기 검색";
export const SELECT = "선택";
export const NAME = "이름";
export const OS = "OS";
export const ADDRESS = "주소";
export const STATUS = "상태";
export const CONNECTION = "연결";
export const TAGS = "태그";
export const OWNER = "소유자";
export const FINDING = "점검";
export const NONE = "—";
export const DIRECT = "직접";
export const relay = (name: string) => `릴레이 ${name}`;
export const selectDevice = (name: string) => `${name} 선택`;
export const selectedCount = (count: number) => `${count}개 선택`;
export const ACTION = "기기 작업";
export const AUTHORIZE = "승인";
export const SET_TAGS = "태그 지정";
export const EXPIRE_KEY = "키 만료";
export const EXPIRY_OFF = "키 만료 끄기";
export const EXPIRY_ON = "키 만료 켜기";
export const RENAME = "이름 바꾸기";
export const DELETE = "삭제";
export const TAGS_INPUT = "태그 (쉼표로 구분)";
export const NEW_NAME = "새 이름";
export const SET_IP = "IPv4 바꾸기";
export const IP_INPUT = "새 IPv4 (100.64.0.0/10)";
export const PREVIEW = "미리보기";
export const CLEAR_SELECTION = "선택 해제";
export const CHANGE_LOG = "변경 기록";
export const TIME = "시각";
export const TARGET = "대상";
export const CHANGE = "변경";
export const POLICY = "정책";
export const UNDO = "되돌리기";
export const UNDONE = "되돌림";
export const UNDO_CONFIRM = "되돌리기 확인";
export const STANDARD_INPUT = "표준 입력";
export const undoDescription = (name: string | undefined) => `${name}의 변경을 이전 값으로 되돌려요.`;
export const APPLY_UNDO = "되돌림 적용";
export const CANCEL = "취소";
export const RESULT = "변경 결과";
export const CONFIRM_REQUEST = "보낼 내용 확인";
export const REQUEST_WARNING = "아래 API 요청을 보낸 뒤에는 바로 적용돼요.";
export const DEVICE = "기기";
export const REQUEST = "요청";
export const BODY = "본문";
export const selectedDevices = (count: number) => `선택한 ${count}개`;
export const DELETE_PREFIX = "삭제하려면";
export const DELETE_SUFFIX = "을 입력해 주세요";
export const APPLY = "적용";
export const RESULT_COLUMN = "결과";
export const DONE = "완료";
export const CLOSE = "닫기";
export const CONNECTION_LOADING = "연결 상태를 확인하고 있어요.";
export const ROUTES_TITLE = "기기 경로";
export const ROUTES_DESCRIPTION = "기기가 광고한 경로와 관리자가 승인한 경로를 보여줘요.";
export const ROUTES_LOADING = "경로를 불러오는 중이에요.";
export const ADVERTISED = "광고";
export const PENDING = "승인 대기";
export const VPC_TITLE = "VPC 경로 범위";
export const vpcDescription = (profile: string, region: string) => `${profile} / ${region}의 VPC CIDR과 승인된 경로를 비교해요.`;
export const VPC_LOADING = "VPC를 불러오는 중이에요.";
export const VPC = "VPC";
export const CIDR = "CIDR";
export const COVERAGE = "범위";
export const COVERAGE_FULL = "전부";
export const COVERAGE_PARTIAL = "일부";
export const COVERAGE_NONE = "없음";
export const MAP = "지도";
export const MAP_TABLE = "표";
export const MAP_SELF = "이 Mac";
export const MAP_EXIT = "인터넷 (exit node)";
export const MAP_FIT = "맞추기";
export const MAP_UNKNOWN = "알 수 없음";
export const MAP_DETAILS = "기기 상세";
export const MAP_APPROVED = "승인된 경로";
export const MAP_SHOW_TABLE = "표에서 보기";
export const MAP_ZOOM_IN = "확대";
export const MAP_ZOOM_OUT = "축소";
/** 태그가 없고 소유자의 기기도 몇 대 안 되는 기기를 모은 묶음 */
export const MAP_OTHER_GROUP = "태그 없는 기기";
