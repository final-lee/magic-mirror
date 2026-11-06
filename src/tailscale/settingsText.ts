export const TITLE = "설정";
export const LOADING = "설정을 불러오고 있어요";
export const RELOAD = "다시 불러오기";
export const CONTACTS = "연락처";
export const PREVIEW = "변경 미리보기";
export const PREVIEW_OPEN = "변경 미리보기…";
export const SAVE = "적용";
export const CANCEL = "취소";
export const RESEND = "확인 메일 다시 보내기…";
export const UNDO = "이전 값으로 되돌리기…";
export const SAVED = "적용했어요";
export const FIELDS: Record<string, string> = {
  aclsExternallyManagedOn: "정책을 외부에서 관리해요. 켜면 앱에서도 정책을 수정할 수 없어요.",
  aclsExternalLink: "외부 정책 관리 주소예요.",
  adminConsoleSessionTimeoutMinutes: "관리 콘솔 세션 시간(분)이에요. 0이면 제한이 없어요.",
  devicesApprovalOn: "새 기기의 승인이 필요해요.",
  devicesAutoUpdatesOn: "기기 자동 업데이트를 켜요.",
  devicesKeyDurationDays: "기기 키의 만료 기간(일)이에요.",
  usersApprovalOn: "새 사용자의 승인이 필요해요.",
  usersRoleAllowedToJoinExternalTailnets: "외부 테일넷에 참여할 수 있는 역할이에요.",
  networkFlowLoggingOn: "네트워크 흐름 로그를 켜요.",
  regionalRoutingOn: "지역 라우팅 상태예요. 경로 선택에서 바꿔요.",
  routeSelection: "경로 선택 방식이에요.",
  postureIdentityCollectionOn: "기기 포스처 신원을 수집해요.",
  httpsEnabled: "HTTPS 인증서 발급을 켜요.",
};
export const TITLES: Record<string, string> = {
  aclsExternallyManagedOn: "외부 정책 관리", aclsExternalLink: "외부 정책 관리 주소",
  adminConsoleSessionTimeoutMinutes: "관리 콘솔 세션 시간", devicesApprovalOn: "새 기기 승인 필요",
  devicesAutoUpdatesOn: "기기 자동 업데이트", devicesKeyDurationDays: "기기 키 만료 기간",
  usersApprovalOn: "새 사용자 승인 필요", usersRoleAllowedToJoinExternalTailnets: "외부 테일넷 참여 역할",
  networkFlowLoggingOn: "네트워크 흐름 로그", regionalRoutingOn: "지역 라우팅",
  routeSelection: "경로 선택", postureIdentityCollectionOn: "기기 포스처 신원 수집", httpsEnabled: "HTTPS 인증서",
};
export const GROUPS: Record<string, string[]> = {
  "기기": ["devicesApprovalOn", "devicesAutoUpdatesOn", "devicesKeyDurationDays"],
  "사용자": ["usersApprovalOn", "usersRoleAllowedToJoinExternalTailnets"],
  "네트워크": ["regionalRoutingOn", "routeSelection", "httpsEnabled"],
  "보안·로그": ["aclsExternallyManagedOn", "aclsExternalLink", "networkFlowLoggingOn", "postureIdentityCollectionOn"],
  "콘솔": ["adminConsoleSessionTimeoutMinutes"],
};
export const VALUES: Record<string, string> = {
  none: "없음", admin: "관리자", member: "멤버",
  "active-passive-failover": "활성·대기 장애 조치", "regional-routing": "지역 라우팅",
  "regional-routing-failover": "지역 라우팅 장애 조치", magicroute: "매직 라우트",
};
export const CONTACT_NAMES: Record<string, string> = { account: "계정", support: "지원", security: "보안" };
export const GROUP_DESCRIPTION = (group: string) => `${group} 설정을 확인하고 변경해요.`;
export const CONTACTS_DESCRIPTION = "연락처 이메일과 확인 상태를 관리해요.";
export const SETTING = "설정";
export const CURRENT = "현재 값";
export const CHANGE = "변경";
export const KIND = "종류";
export const EMAIL = "이메일";
export const VERIFICATION = "확인 여부";
export const ACTIONS = "동작";
export const UNSET = "설정되지 않음";
export const ON = "켜짐";
export const OFF = "꺼짐";
export const TURN_OFF = "끄기…";
export const TURN_ON = "켜기…";
export const VERIFIED = "확인됨";
export const VERIFICATION_PENDING = "확인 대기";
export const UNKNOWN = "알 수 없음";
