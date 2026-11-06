export const TITLE = "연동";
export const LOADING = "연결을 확인하고 있어요";
export const WEBHOOKS = "웹훅";
export const POSTURE = "포스처 연동";
export const APPS = "OAuth 앱";
export const STREAM = "로그 스트리밍";
export const CREATE = "만들기";
export const EDIT = "편집";
export const DELETE = "삭제";
export const TEST = "시험 전송";
export const ROTATE = "시크릿 교체";
export const DISABLE = "끄기";
export const CONFIGURE = "설정";
export const EXTERNAL_ID = "AWS external ID 만들기";
export const VALIDATE = "AWS 신뢰 정책 확인";
export const PREVIEW = "요청 미리보기";
export const APPLY = "적용";
export const CANCEL = "취소";
export const CLOSE = "닫기";
export const DONE = "완료했어요";
export const COPY = "복사";
export const ONCE = "이 비밀값은 한 번만 보여요. 안전한 곳에 보관해 주세요.";
export const TYPE_ID = "삭제하려면 ID를 입력해 주세요";
export const COMMA = "쉼표로 구분";
export const SECRET_KEEP = "비워두면 기존 비밀값을 유지해요";
export const UNDO = "되돌리기";
export const REFRESH = "새로고침";
export const PRIVATE_ENDPOINT = "테일넷 내부 엔드포인트 (device_invites·policy_file 권한도 필요해요)";
export const FIELD_LABELS: Record<string, string> = {
  endpointUrl: "엔드포인트 URL", providerType: "제공자", subscriptions: "구독 이벤트",
  provider: "제공자", cloudId: "클라우드 ID", clientId: "클라이언트 ID", tenantId: "테넌트 ID", clientSecret: "클라이언트 시크릿",
  name: "이름", description: "설명", redirectURIs: "리디렉션 URI", scopes: "권한", allowedNodeAttributes: "허용 기기 속성",
  destinationType: "대상 유형", url: "URL", user: "사용자", token: "토큰", uploadPeriodMinutes: "업로드 간격 (분)", compressionFormat: "압축",
  s3Bucket: "S3 버킷", s3Region: "S3 리전", s3KeyPrefix: "S3 접두사", s3AuthenticationType: "S3 인증", s3RoleArn: "S3 역할 ARN",
  s3AccessKeyId: "S3 액세스 키 ID", s3SecretAccessKey: "S3 시크릿 액세스 키",
};
export const STREAM_DESCRIPTION = "설정 로그와 네트워크 로그를 외부 저장소로 보내요.";
export const STREAM_HEADERS = { kind: "로그 종류", destination: "목적지", actions: "동작" };
export const NAME_HEADER = "이름";
export const IDENTIFIER = "식별자";
export const ACTIONS = "동작";
export const AWS_EXTERNAL_ID = "AWS 외부 ID";
export const AWS_DESCRIPTION = "S3 역할의 신뢰 정책에 사용할 외부 ID를 만들고 확인해요.";
export const EXTERNAL_ID_LABEL = "외부 ID";
export const ROLE_ARN = "역할 ARN";
export const STREAM_KINDS: Record<string, string> = { configuration: "설정 로그", network: "네트워크 로그" };
export const STREAM_OFF = "설정 안 됨";
export const STREAM_EDITOR = "로그 스트리밍 설정";
export const EDITOR_DESCRIPTION = "연동에 필요한 정보를 입력하고 요청을 미리 확인해요.";
export const NO_CHOICE = "선택 안 함";
export const SECTION_DESCRIPTIONS = {
  webhook: "이벤트를 외부 엔드포인트로 전달해요.",
  posture: "외부 제공자의 기기 보안 상태를 연동해요.",
  app: "테일넷에 접근하는 OAuth 앱을 관리해요.",
};
export const EMPTY = {
  webhook: "웹훅이 없어요.",
  posture: "포스처 연동이 없어요.",
  app: "OAuth 앱이 없어요.",
};
/** 제품 이름은 원래 표기를 그대로 쓰고, 일반 값만 한국어로 옮긴다. */
export const OPTION_LABELS: Record<string, string> = {
  slack: "Slack", mattermost: "Mattermost", googlechat: "Google Chat", discord: "Discord",
  falcon: "CrowdStrike Falcon", intune: "Microsoft Intune", jamfpro: "Jamf Pro", kandji: "Kandji",
  kolide: "Kolide", sentinelone: "SentinelOne",
  splunk: "Splunk", elastic: "Elastic", panther: "Panther", cribl: "Cribl", crowdstrike: "CrowdStrike",
  datadog: "Datadog", axiom: "Axiom", s3: "Amazon S3", none: "압축 안 함", zstd: "Zstandard", gzip: "gzip",
  rolearn: "역할 ARN", accesskey: "액세스 키",
};
