export const TAB_LOGS = "로그";
export const REFRESH = "다시 읽기";
export const LOADING = "읽는 중이에요…";
export const SECTION_ERROR = "이 구역을 읽지 못했어요";
export const NONE = "—";

export const AUDIT_TITLE = "설정 감사 로그";
export const AUDIT_RANGE = "기간";
export const auditRange = (days: number) => `최근 ${days}일`;
export const AUDIT_FILTER = "감사 로그 검색";
export const AUDIT_EMPTY = "이 기간에 기록된 설정 변경이 없어요.";
export const AUDIT_NO_MATCH = "조건에 맞는 기록이 없어요.";
export const auditTruncated = (shown: number, total: number) => `최근 ${shown}건만 보여요 (전체 ${total}건)`;
export const auditCount = (shown: number, total: number) => (shown === total ? `${total}건` : `${shown} / ${total}건`);
export const COL_TIME = "시각";
export const COL_ACTOR = "누가";
export const COL_ACTION = "동작";
export const COL_TARGET = "대상";
export const COL_ORIGIN = "경로";
export const FAILED = "실패";
export const BEFORE = "이전";
export const AFTER = "이후";

const ACTIONS: Record<string, string> = {
  LOGIN: "로그인",
  LOGOUT: "로그아웃",
  CREATE: "만들기",
  UPDATE: "바꾸기",
  DELETE: "지우기",
  CANCEL: "취소",
  REVOKE: "회수",
  APPROVE: "승인",
  SUSPEND: "정지",
  RESTORE: "복구",
  ENABLE: "켜기",
  DISABLE: "끄기",
  ACCEPT: "수락",
  EXPIRED: "만료",
  INVITE: "초대",
  JOIN: "참여",
  LEAVE: "나가기",
};
export const actionLabel = (action: string) => ACTIONS[action] ?? action;

export const FLOW_TITLE = "네트워크 흐름 로그 (최근 1시간)";
export const FLOW_OFF = "이 테일넷은 네트워크 흐름 로그가 꺼져 있어요. 관리 콘솔의 Logs에서 켜면 최근 1시간의 접속을 여기서 볼 수 있어요.";
export const FLOW_EMPTY = "최근 1시간에 기록된 흐름이 없어요.";
export const FLOW_FILTER = "흐름 검색";
export const FLOW_NO_MATCH = "조건에 맞는 흐름이 없어요.";
export const flowTruncated = (shown: number, total: number) => `전송량이 많은 ${shown}건만 보여요 (전체 ${total}건)`;
export const FLOW_NOTE = "출발 포트가 달라도 같은 출발지와 도착지는 하나로 합쳤어요. 물리 경로 트래픽은 빼요.";
export const COL_NODE = "기록한 기기";
export const COL_CLASS = "종류";
export const COL_PROTO = "프로토콜";
export const COL_SRC = "출발";
export const COL_DST = "도착";
export const COL_TX = "보냄";
export const COL_RX = "받음";
export const FLOW_CLASS: Record<string, string> = { tailnet: "테일넷", subnet: "서브넷 라우터", exit: "exit node" };

export const STREAM_TITLE = "로그 스트리밍";
export const STREAM_TYPES = { configuration: "설정 감사 로그", network: "네트워크 흐름 로그" } as const;
export const STREAM_NOT_CONFIGURED = "스트리밍을 설정하지 않았어요.";
export const STREAM_DESTINATION = "보내는 곳";
export const STREAM_URL = "주소";
export const STREAM_USER = "사용자";
export const STREAM_PERIOD = "업로드 주기";
export const streamPeriod = (minutes: number) => `${minutes}분`;
export const STREAM_COMPRESSION = "압축";
export const STREAM_LAST_ACTIVITY = "마지막 전송";
export const STREAM_SENT = "보낸 항목";
export const STREAM_REQUESTS = "요청";
export const STREAM_LAST_ERROR = "마지막 오류";
export const streamSent = (entries: number, bytes: string) => `${entries.toLocaleString("en-US")}건 (${bytes})`;
export const streamRequests = (total: number, failed: number) => `${total.toLocaleString("en-US")}회 (실패 ${failed.toLocaleString("en-US")}회)`;
export const STREAM_NO_STATUS = "아직 전송 상태가 없어요.";

export const WEBHOOK_TITLE = "웹훅";
export const WEBHOOK_EMPTY = "웹훅이 없어요.";
export const COL_ENDPOINT = "받는 곳";
export const COL_PROVIDER = "종류";
export const COL_EVENTS = "구독 이벤트";
export const COL_CREATOR = "만든 사람";
export const COL_CREATED = "만든 날";
export const WEBHOOK_NOTE = "주소의 경로에는 비밀값이 들어 있는 경우가 많아서 호스트까지만 보여요.";
