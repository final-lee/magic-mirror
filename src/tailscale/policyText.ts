import type { PolicySeverity } from "./policyTypes";

export const POLICY_LOADING = "정책을 읽는 중이에요…";
export const RELOAD = "다시 불러오기";
export const RELOAD_DISCARD = "편집을 버리고 다시 불러오기";
export const EXTERNAL_NOTICE = "이 테일넷의 정책은 다른 곳에서 관리해요. 여기서는 읽기만 할 수 있어요.";
export const EXTERNAL_OPEN = "관리하는 곳 열기";
export const NO_ETAG = "정책의 버전(ETag)을 받지 못해서 저장할 수 없어요. 다시 불러와 주세요";

export const FINDINGS = "지적";
export const FINDINGS_BASIS = "저장된 정책 기준";
export const NO_FINDINGS = "지적할 것이 없어요";
export const SEVERITY: Record<PolicySeverity, { label: string; chip: string }> = {
  high: { label: "높음", chip: "denied" },
  medium: { label: "보통", chip: "conditional" },
  low: { label: "낮음", chip: "" },
};

export const ACCESS = "누가 무엇에 닿나";
export const ACCESS_USER = "사용자";
export const ACCESS_IPPORT = "IP:포트";
export const ACCESS_KIND = "찾는 대상 종류";
export const ACCESS_USER_PLACEHOLDER = "alice@example.com";
export const ACCESS_IPPORT_PLACEHOLDER = "100.64.0.7:22";
export const ACCESS_SUBJECT = "찾을 이메일 또는 IP:포트";
export const ACCESS_RUN = "보기";
export const ACCESS_RUNNING = "찾는 중…";
export const ACCESS_DRAFT = "편집 중인 정책으로 계산해요";
export const ACCESS_SAVED = "저장된 정책으로 계산해요";
export const ACCESS_NONE = "맞는 규칙이 없어요. 규칙이 없으면 접속이 막혀요";
export const ACCESS_SOURCES = "출발지";
export const ACCESS_TARGETS = "목적지";
export const ACCESS_LINE = "줄";
export const accessResult = (count: number, subject: string) => `${subject}에 맞는 규칙 ${count}개`;

export const EDIT = "정책 편집";
export const EDITOR_LABEL = "정책 HuJSON";
export const EDIT_TIP = "주석과 마지막 쉼표를 쓸 수 있어요(HuJSON). Tab·Shift+Tab은 들여쓰기·내어쓰기예요. 다른 칸으로 나가려면 Esc를 누른 뒤 Tab을 누르세요";
export const CHECK = "검사";
export const CHECKING = "검사하는 중…";
export const PREVIEW = "미리보기…";
export const UNCHANGED = "바꾼 내용이 없어요";
export const CHECK_OK = "검사에서 문제가 발견되지 않았어요";
export const CHECK_FAILED = "검사에서 문제가 발견됐어요";
export const CHECK_WARNINGS = "경고가 있어요(저장은 할 수 있어요)";
export const CHECK_ERROR = "검사하지 못했어요";
export const SAVED = "정책을 저장했어요. 변경 기록에서 이전 정책으로 되돌릴 수 있어요";

export const SAVE_TITLE = "정책 저장 미리보기";
export const SAVE_SUMMARY = "테일넷 전체의 접근 규칙을 이 정책으로 바꿔요.";
export const CALLS = "호출할 API";
export const DIFF_LABEL = "바뀌는 내용";
export const SAVE = "저장";
export const SAVING = "저장하는 중…";
export const CANCEL = "취소";
export const REVERSIBLE = "저장하면 이전 정책 전체를 변경 기록에 남겨요. 기록에서 되돌릴 수 있어요.";
export const SAVE_FAILED = "저장하지 못했어요";
export const diffStats = (added: number, removed: number) => `+${added} −${removed}`;
export const gap = (hidden: number) => `… ${hidden}줄 같음`;
export const bodySummary = (lines: number) => `정책 전체 (${lines}줄)`;
/** 백엔드(`CHANGED_ELSEWHERE`)가 If-Match 불일치(412)에 내는 문구와 같아야 한다 */
export const CHANGED_ELSEWHERE = "다른 곳에서 정책이 바뀌었어요. 다시 불러와 주세요";
