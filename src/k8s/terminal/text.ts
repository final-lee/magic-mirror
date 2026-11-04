export const NAV_TERMINAL = "터미널";
export const TERMINAL_ICON = "🖥";
export const TERMINAL_VIEW_LABEL = "앱 안 터미널";
export const TERMINAL_PINNED = "고정된 context";
export const TERMINAL_PINNED_NOTE = "이 터미널의 kubectl은 이 탭의 클러스터(이 context)만 봐요";
export const TERMINAL_TABS_LABEL = "터미널 목록";
export const TERMINAL_NEW = "새 터미널";
export const TERMINAL_EMPTY = "열린 터미널이 없어요";
export const terminalTitle = (n: number) => `터미널 ${n}`;
export const terminalClose = (title: string) => `${title} 닫기`;
export const TERMINAL_RESTART = "셸 다시 열기";
export const TERMINAL_CLOSE_TAB = "탭 닫기";
export const TERMINAL_OPENING = "여는 중…";
export const TERMINAL_COMMAND_LABEL = "실행한 명령";

export const PLUGIN_MENU = "플러그인";
export const PLUGIN_MENU_LABEL = "플러그인 목록";
export const PLUGIN_NONE = "이 종류에 쓸 수 있는 플러그인이 없어요";
export const pluginConfirmTitle = (name: string) => `플러그인 실행: ${name}`;
export const PLUGIN_RUNS_IN = "이 탭의 새 터미널에서 아래 명령을 그대로 실행해요. 이 탭의 context에 고정돼 있어요.";
export const PLUGIN_CONTEXT = "context";
export const PLUGIN_COMMAND = "명령";
export const PLUGIN_RUN = "실행";
export const PLUGIN_CANCEL = "취소";
export const PLUGIN_INVALID = "이 플러그인의 명령을 만들 수 없어요";

export const PLUGIN_TEMPLATE_SUBSTITUTION = "명령 치환과 중괄호 변수는 사용할 수 없어요";
export const PLUGIN_TEMPLATE_DOLLAR_QUOTE = "달러 따옴표 구문은 사용할 수 없어요";
export const PLUGIN_TEMPLATE_ESCAPE = "변수 앞에 역슬래시를 쓸 수 없어요";
export const PLUGIN_TEMPLATE_HEREDOC = "here 문서는 사용할 수 없어요";
export const PLUGIN_TEMPLATE_SYNTAX = "이 셸 구문에서는 변수를 사용할 수 없어요";
export const PLUGIN_TEMPLATE_VARIABLE = "변수 이름을 확인해 주세요";
export const PLUGIN_TEMPLATE_BOUNDARY = "변수는 독립된 단어 또는 따옴표 안에 넣어 주세요";
export const PLUGIN_TEMPLATE_UNCLOSED = "닫히지 않은 따옴표가 있어요";
export const PLUGIN_KEY_INVALID = "한 글자 또는 수식 키와 한 글자를 입력해 주세요";
export const PLUGIN_KEY_CONFLICT = "이미 사용 중인 단축키예요";
export const PLUGIN_SETTINGS = {
  title: "EKS 플러그인", description: "선택한 객체에 대해 로컬 셸에서 실행할 명령이에요.",
  edit: "편집", delete: "삭제", add: "플러그인 추가", name: "이름", descriptionLabel: "설명",
  kinds: "종류", kindsHelp: "* 또는 그룹/버전/Kind/복수형/namespaced(또는 cluster). 여러 종류는 쉼표로 나눠요. 코어 그룹은 core로 적어요.",
  kindsError: "종류를 확인해 주세요", command: "명령", commandHelp: "$NAMESPACE $NAME $CONTEXT $KIND $CONTAINER를 쓸 수 있어요.",
  key: "단축키", confirm: "실행 전 확인", save: "저장", cancel: "취소",
};
