// 구독 만들기·시험 발행·편집기·로깅 편집의 글. 백엔드가 주는 글(경고, 영향)은 여기 두지 않는다.

export const PREVIEW = "미리 보기…";
export const CANCEL = "취소";
export const EDIT = "편집";
export const EDIT_CANCEL = "편집 취소";
export const NEED_FIX = "입력을 고친 뒤에 미리 볼 수 있어요";

// 구독 만들기
export const SUBSCRIBE_OPEN = "구독 만들기…";
export const SUBSCRIBE_TITLE = "구독 만들기";
export const SUBSCRIBE_PROTOCOL = "프로토콜";
export const SUBSCRIBE_ENDPOINT = "엔드포인트";
export const SUBSCRIBE_PICK = "엔드포인트 고르기";
export const SUBSCRIBE_PICK_NONE = "고르세요";
export const SUBSCRIBE_ARN_OTHER = "또는 ARN 직접 입력(다른 계정·리전)";
export const SUBSCRIBE_OTHER_NOTE = "다른 계정·리전의 리소스는 구독 요청만 보내요. 그쪽 큐 정책이나 함수 권한은 이 앱이 건드리지 않아요";
export const SUBSCRIBE_LOADING = "목록을 불러오는 중…";
export const SUBSCRIBE_URL = "주소";
export const SUBSCRIBE_EMAIL = "이메일 주소";
export const SUBSCRIBE_RAW = "raw 전달(SNS 봉투 없이 본문만)";
export const SUBSCRIBE_RAW_OFF = "이 프로토콜은 raw 전달을 지원하지 않아요";
export const SUBSCRIBE_FILTER = "필터 정책(JSON, 비우면 필터 없음)";
export const SUBSCRIBE_SCOPE = "필터 범위";
export const SUBSCRIBE_DLQ = "DLQ(RedrivePolicy)";
export const SUBSCRIBE_DLQ_NONE = "DLQ 없음";
export const SUBSCRIBE_DLQ_OFF = "이 프로토콜의 구독에는 DLQ를 붙일 수 없어요";
export const SUBSCRIBE_DLQ_RULE = (fifo: boolean) => (fifo ? "FIFO 주제의 DLQ는 FIFO 큐만 고를 수 있어요" : "표준 주제의 DLQ는 표준 큐만 고를 수 있어요");
export const SUBSCRIBE_PENDING = "이메일·HTTP(S)는 만든 뒤 확인 대기로 남아요. 받는 쪽이 확인해야 메시지를 받아요";
export const SUBSCRIBE_NEED_ENDPOINT = "엔드포인트를 정하세요";
export const SUBSCRIBE_BAD_FILTER = (message: string) => `필터 정책이 올바른 JSON이 아니에요 · ${message}`;
export const SCOPE_LABEL: Record<"MessageAttributes" | "MessageBody", string> = { MessageAttributes: "메시지 속성", MessageBody: "본문(JSON)" };
export const PROTOCOL_LABEL: Record<string, string> = { sqs: "SQS 큐", lambda: "Lambda 함수", https: "HTTPS", http: "HTTP(암호화 안 됨)", email: "이메일", "email-json": "이메일(JSON)" };

// 구독 해지·raw·편집 단추
export const UNSUBSCRIBE_OPEN = "해지…";
export const UNSUBSCRIBE_WHY_PENDING = "확인 대기 중인 구독은 해지할 수 없어요(확인하지 않으면 3일 뒤 저절로 지워져요)";
export const RAW_TURN_ON = "raw 전달 켜기…";
export const RAW_TURN_OFF = "raw 전달 끄기…";
export const RAW_WHY_PROTOCOL = "SQS·HTTP(S) 구독만 raw 전달을 쓸 수 있어요";
export const EDIT_FILTER = "필터 정책 편집";
export const EDIT_DELIVERY = "배달 정책 편집";
export const EDIT_WHY_PENDING = "확인된 구독만 바꿀 수 있어요";
export const EDIT_WHY_PROTOCOL = "HTTP(S) 구독만 배달 정책이 있어요";

// 편집기(필터·배달 정책·주제 정책)
export const EDITOR_BAD_JSON = (message: string) => `JSON 형식이 올바르지 않아요 · ${message}`;
export const EDITOR_EMPTY_HINT_FILTER = "비우고 미리 보면 필터 정책을 지워요";
export const EDITOR_EMPTY_HINT_DELIVERY = "비우고 미리 보면 배달 정책을 지워요";
export const EDITOR_EMPTY = "내용을 입력하세요";
export const FILTER_EDITOR = "필터 정책 편집기";
export const DELIVERY_EDITOR = "배달 정책 편집기";
export const POLICY_EDITOR = "주제 정책 편집기";
export const POLICY_EDIT = "정책 편집";
export const POLICY_NONE_TO_EDIT = "정책을 읽지 못해서 편집할 수 없어요";
export const DELIVERY_NOTE = "HTTP(S) 재시도·속도 제한을 정해요. 예: {\"healthyRetryPolicy\": {\"numRetries\": 5}}";

// 변경 미리보기에 붙는 것
export const FILTER_IMPACT = "최근 표본의 판정";
export const FILTER_IMPACT_COLS = { sample: "표본", before: "지금", after: "바꾼 뒤" } as const;
export const FILTER_IMPACT_NONE = "필터 시험 화면에서 쓴 표본이 없어요. 표본을 시험해 두면 바뀌는 판정을 여기서 볼 수 있어요";
export const FILTER_IMPACT_LOADING = "표본을 판정하는 중…";
export const FILTER_IMPACT_FAILED = "표본을 판정하지 못했어요";
export const VERDICT = { accept: "받음", reject: "걸러짐", none: "필터 없음(받음)", unknown: "판정 불가" } as const;
export const VERDICT_CHANGED = "바뀜";
export const POLICY_CHECK = "정책 검사";
export const POLICY_CHECK_LOADING = "정책을 검사하는 중…";

// 시험 발행
export const PUBLISH_OPEN = "시험 발행…";
export const PUBLISH_TITLE = "시험 발행";
export const PUBLISH_MESSAGE = "메시지";
export const PUBLISH_SUBJECT = "제목(선택)";
export const PUBLISH_STRUCTURE = "MessageStructure=json(프로토콜마다 다른 본문)";
export const PUBLISH_STRUCTURE_NOTE = "메시지는 JSON이어야 하고 `default` 키가 있어야 해요";
export const PUBLISH_ATTRIBUTES = "메시지 속성";
export const PUBLISH_ATTR_ADD = "속성 추가";
export const PUBLISH_ATTR_REMOVE = "행 지우기";
export const PUBLISH_GROUP = "메시지 그룹 ID";
export const PUBLISH_DEDUP = "중복 제거 ID";
export const PUBLISH_DEDUP_AUTO = "이 주제는 내용 기반 중복 제거가 켜져 있어 비워도 돼요";
export const PUBLISH_DEDUP_NEEDED = "내용 기반 중복 제거가 꺼져 있어 필요해요";
export const PUBLISH_NEED_MESSAGE = "메시지를 입력하세요";
export const PUBLISH_NEED_GROUP = "FIFO 주제에는 메시지 그룹 ID가 필요해요";
export const PUBLISH_NEED_DEDUP = "중복 제거 ID가 필요해요";
export const PUBLISH_BAD_STRUCTURE = "MessageStructure=json 메시지는 `default` 키가 있는 JSON이어야 해요";
export const PUBLISH_BAD_ATTR = "속성의 이름·값을 채우세요";
export const PUBLISH_LOG_NOTE = "변경 기록에는 MessageId, 크기, 속성 이름, 본문의 SHA-256만 남겨요(본문은 남기지 않아요)";

// 배달 상태 로깅
export const LOGGING_TITLE = (protocol: string) => `${protocol} 배달 상태 로깅`;
export const LOGGING_SUCCESS = "성공 로그 역할";
export const LOGGING_FAILURE = "실패 로그 역할";
export const LOGGING_RATE = "성공 로그 표본 비율(%)";
export const LOGGING_NO_ROLE = "역할 없음(끄기)";
export const LOGGING_ROLES_LOADING = "역할 목록을 불러오는 중…";
export const LOGGING_ROLES_NOTE = "SNS(sns.amazonaws.com)를 신뢰하는 기존 역할만 고를 수 있어요. 이 앱은 역할을 만들지 않아요";
export const LOGGING_ROLES_EMPTY = "SNS를 신뢰하는 역할이 없어요. IAM에서 역할을 만든 뒤 고르세요";
export const LOGGING_BAD_RATE = "표본 비율은 0~100 사이의 정수여야 해요";
