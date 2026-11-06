export const CREATE = "키 만들기";
export const EDIT = "키 편집";
export const TYPE = "종류";
export const DESCRIPTION = "설명";
export const REUSABLE = "재사용";
export const EPHEMERAL = "임시 기기";
export const PREAUTHORIZED = "사전 승인";
export const EXPIRY = "유효 기간 (초)";
export const TAGS = "태그";
export const SCOPES = "권한";
export const EXTRA_SCOPES = "추가 권한 (쉼표로 구분)";
export const ISSUER = "발급자 URL";
export const SUBJECT = "주체 패턴";
export const AUDIENCE = "대상 (선택)";
export const CLAIMS = "추가 클레임 규칙 (JSON 객체)";
export const PREVIEW = "요청 미리보기";
export const APPLY = "적용";
export const CANCEL = "취소";
export const CLOSE = "닫기";
export const DONE = "완료했어요";
export const COPY = "복사";
export const SECRET = "이 비밀값은 한 번만 보여요. 안전한 곳에 보관해 주세요.";
export const NEED_TAG = "기기 또는 auth key 쓰기 권한에는 태그가 필요해요.";
export const BAD_CLAIMS = "클레임 규칙을 JSON 객체로 입력해 주세요.";
export const UNDO = "되돌리기";
export const GROUP_ALL = "전체";
export const GROUP_DEVICES = "기기";
export const GROUP_KEYS = "키";
export const GROUP_POLICY_USERS = "정책과 사용자";
export const GROUP_SETTINGS_INTEGRATIONS = "설정과 연동";
export const GROUP_LOGS_SERVICES = "로그와 Services";
export const SCOPE_NAMES: Record<string, string> = {
  all: "전체 권한", devices: "기기", "devices:core": "기기 기본 정보", "devices:routes": "기기 경로",
  "devices:posture_attributes": "기기 보안 속성", device_invites: "기기 초대",
  auth_keys: "인증 키", oauth_keys: "OAuth 키", federated_keys: "연합 키", api_access_tokens: "API 액세스 토큰",
  policy_file: "정책 파일", users: "사용자", feature_settings: "기능 설정", networking_settings: "네트워크 설정",
  account_settings: "계정 설정", webhooks: "웹훅", oauth_apps: "OAuth 앱", log_streaming: "로그 스트리밍",
  "logs:configuration": "설정 로그", "logs:network": "네트워크 로그", services: "서비스", tailnets: "테일넷",
};
export const SCOPE_DESCRIPTION = "이 키가 사용할 권한을 선택해요.";
export const BASIC_INFO = "기본 정보";
export const BASIC_DESCRIPTION = "키의 종류와 사용 조건을 설정해요.";
export const AUTH_KEY = "인증 키";
export const OAUTH_CLIENT = "OAuth 클라이언트";
export const FEDERATED_ID = "연합 ID";
export const COMMA_HELP = "쉼표로 구분해요.";
export const FEDERATED_SETTINGS = "연합 ID 설정";
export const FEDERATED_DESCRIPTION = "신뢰할 발급자와 주체를 지정해요.";
export function scopeLabel(scope: string): string {
  const read = scope.endsWith(":read");
  const key = read ? scope.slice(0, -5) : scope;
  return `${SCOPE_NAMES[key] ?? key} ${read ? "읽기" : "관리"}`;
}
