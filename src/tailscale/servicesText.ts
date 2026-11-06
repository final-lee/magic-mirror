export const TITLE = "Services";
export const LOADING = "연결을 확인하고 있어요";
export const SEARCH = "Service 검색";
export const CREATE = "Service 만들기";
export const EDIT = "편집";
export const DELETE = "삭제";
export const NAME = "이름";
export const ADDRS = "주소";
export const PORTS = "포트";
export const TAGS = "태그";
export const COMMENT = "설명";
export const DISPLAY_NAME = "표시 이름";
export const HOSTS = "호스트 기기";
export const REFRESH = "새로고침";
export const PREVIEW = "요청 미리보기";
export const APPLY = "적용";
export const CANCEL = "취소";
export const CLOSE = "닫기";
export const DONE = "변경했어요";
export const UNDO = "되돌리기";
export const CONFIRM_DELETE = "삭제하려면 Service 이름을 입력해 주세요";
export const APPROVE = "승인";
export const REVOKE = "승인 취소";
export const UNKNOWN = "알 수 없어요";
export const HOST_STATUS: Record<string, string> = {
  approved: "승인됨",
  pending: "승인 대기",
  "needs-approval": "승인 대기",
  autoApproved: "자동 승인됨",
  true: "설정됨",
  false: "설정 안 됨",
};
export const EMPTY = "서비스가 없어요.";
export const HOSTS_DESCRIPTION = "이 서비스를 제공하는 기기와 승인 상태를 확인해요.";
export const NO_HOSTS = "호스트 기기가 없어요.";
export const CONFIGURED_PREFIX = "설정: ";
export const APPROVAL_LEVEL_PREFIX = "승인 수준: ";
export const EDITOR_DESCRIPTION = "서비스의 주소와 포트, 태그를 설정해요.";
export const COMMA_HELP = "쉼표로 구분해요.";
export const PORTS_HELP = "쉼표로 구분해요. 예: tcp:443";
