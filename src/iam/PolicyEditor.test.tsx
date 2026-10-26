import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { iamApi } from "./api";
import { NEW_POLICY_TEMPLATE, PolicyEditor } from "./PolicyEditor";
import type { ValidationResult } from "./types";

vi.mock("./api", () => ({ iamApi: { validatePolicy: vi.fn() } }));

const m = vi.mocked(iamApi);

const DOC = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }] }, null, 2);
const clean: ValidationResult = { syntaxError: null, analyzerAvailable: true, findings: [] };

function setup(extra: Partial<React.ComponentProps<typeof PolicyEditor>> = {}) {
  const props = { onSubmit: vi.fn(), onCancel: vi.fn() };
  const utils = render(<PolicyEditor profile="prod" mode="edit" name="s3-scratch" title="인라인 정책 편집" document={DOC} {...props} {...extra} />);
  return { props, ...utils };
}
const editor = () => screen.getByRole("textbox", { name: "정책 JSON" }) as HTMLTextAreaElement;
const nameInput = () => screen.getByRole("textbox", { name: "정책 이름" });
const previewButton = () => screen.getByRole("button", { name: "미리보기" });
const checkButton = () => screen.getByRole("button", { name: "검사" });
const typeDoc = (value: string) => fireEvent.change(editor(), { target: { value } });
const CHANGED = DOC.replace("s3:GetObject", "s3:PutObject");

beforeEach(() => {
  vi.clearAllMocks();
  m.validatePolicy.mockResolvedValue(clean);
});

describe("editing an existing policy", () => {
  test("shows the title, the fixed name and the document in a monospace box", () => {
    setup();
    expect(screen.getByRole("heading", { name: "인라인 정책 편집" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "정책 이름" })).not.toBeInTheDocument();
    expect(screen.getByText("s3-scratch")).toBeInTheDocument();
    expect(editor()).toHaveValue(DOC);
    expect(editor()).toHaveClass("mono");
    expect(editor()).toHaveAttribute("spellcheck", "false");
  });

  test("the preview is off until something changed, then hands over the fixed name and the text", () => {
    const { props } = setup();
    expect(previewButton()).toBeDisabled();
    expect(screen.getByText("바꾼 내용이 없어요")).toBeInTheDocument();
    typeDoc(CHANGED);
    expect(previewButton()).toBeEnabled();
    fireEvent.click(previewButton());
    expect(props.onSubmit).toHaveBeenCalledWith("s3-scratch", CHANGED);
  });

  test("a change that only reformats the same JSON counts as unchanged", () => {
    setup();
    typeDoc(JSON.stringify(JSON.parse(DOC)));
    expect(previewButton()).toBeDisabled();
  });

  test("취소 leaves without submitting", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});

describe("live JSON check", () => {
  test("a syntax error shows at once, and the preview and check are off until it is fixed", () => {
    setup();
    typeDoc('{ "Version": ');
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("JSON 형식이 올바르지 않아요");
    expect(previewButton()).toBeDisabled();
    expect(checkButton()).toBeDisabled();
    typeDoc(CHANGED);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("JSON 형식이 맞아요")).toBeInTheDocument();
    expect(previewButton()).toBeEnabled();
    expect(checkButton()).toBeEnabled();
  });

  test("an empty box is not valid JSON either", () => {
    setup({ mode: "new", name: undefined, document: "" });
    expect(screen.getByRole("alert")).toHaveTextContent("내용을 입력하세요");
    expect(previewButton()).toBeDisabled();
  });

  test("JSON that is not an object (a number, an array) is refused before the backend sees it", () => {
    setup();
    typeDoc("[1, 2]");
    expect(screen.getByRole("alert")).toHaveTextContent("정책은 JSON 객체여야 해요");
    expect(previewButton()).toBeDisabled();
  });
});

describe("Tab key", () => {
  test("inserts two spaces at the caret and keeps the focus in the box", async () => {
    setup({ document: "{}" });
    editor().focus();
    editor().setSelectionRange(1, 1);
    await userEvent.keyboard("{Tab}");
    expect(editor()).toHaveValue("{  }");
    expect(editor()).toHaveFocus();
    expect(editor().selectionStart).toBe(3);
  });

  test("replaces a selection", async () => {
    setup({ document: "abcd" });
    editor().focus();
    editor().setSelectionRange(1, 3);
    await userEvent.keyboard("{Tab}");
    expect(editor()).toHaveValue("a  d");
  });

  test("Shift+Tab and Tab right after Esc move the focus on instead of trapping it", async () => {
    setup({ document: "{}" });
    editor().focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(editor()).not.toHaveFocus();
    expect(editor()).toHaveValue("{}");

    editor().focus();
    await userEvent.keyboard("{Escape}{Tab}");
    expect(editor()).not.toHaveFocus();
    expect(editor()).toHaveValue("{}");

    editor().focus();
    editor().setSelectionRange(0, 0);
    await userEvent.keyboard("{Tab}"); // Esc 효과는 한 번뿐이다
    expect(editor()).toHaveValue("  {}");
  });
});

describe("validation with the AWS policy checker", () => {
  test("sends the current text and lists the findings, most serious first", async () => {
    m.validatePolicy.mockResolvedValue({
      syntaxError: null,
      analyzerAvailable: true,
      findings: [
        { level: "suggestion", code: "PREFER_CONDITION", message: "조건을 쓰면 더 안전해요" },
        { level: "error", code: "INVALID_ACTION", message: "s3:PutObjekt는 없는 작업이에요" },
        { level: "securityWarning", code: "PASS_ROLE_WITH_STAR_IN_RESOURCE", message: "PassRole을 모든 리소스에 허용해요" },
        { level: "warning", code: "UNSUPPORTED_ARN", message: "ARN 형식을 확인하세요" },
      ],
    });
    setup();
    typeDoc(CHANGED);
    fireEvent.click(checkButton());
    expect(checkButton()).toBeDisabled();
    const list = await screen.findByRole("list", { name: "검사 결과" });
    expect(m.validatePolicy).toHaveBeenCalledWith("prod", CHANGED);
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-level"))).toEqual(["error", "securityWarning", "warning", "suggestion"]);
    expect(items[0]).toHaveTextContent("오류");
    expect(items[0]).toHaveTextContent("INVALID_ACTION");
    expect(items[0]).toHaveTextContent("s3:PutObjekt는 없는 작업이에요");
    expect(items[1]).toHaveTextContent("보안 경고");
    expect(items[2]).toHaveTextContent("경고");
    expect(items[3]).toHaveTextContent("제안");
  });

  test("scrolls the result into view when the check finishes, since the editor box is tall", async () => {
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      setup();
      fireEvent.click(checkButton());
      await screen.findByText("검사에서 문제가 발견되지 않았어요");
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
      expect(screen.getByText("검사에서 문제가 발견되지 않았어요").closest(".pe-results")).toBe(scroll.mock.contexts[0]);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  });

  test("says so when the checker found nothing", async () => {
    setup();
    fireEvent.click(checkButton());
    expect(await screen.findByText("검사에서 문제가 발견되지 않았어요")).toBeInTheDocument();
  });

  test("a syntax error from the backend is shown as such", async () => {
    m.validatePolicy.mockResolvedValue({ syntaxError: "Statement 항목이 없어요", analyzerAvailable: true, findings: [] });
    setup();
    fireEvent.click(checkButton());
    expect(await screen.findByText("Statement 항목이 없어요")).toBeInTheDocument();
    expect(screen.queryByText("검사에서 문제가 발견되지 않았어요")).not.toBeInTheDocument();
  });

  test("without the checker permission it says only the syntax was checked", async () => {
    m.validatePolicy.mockResolvedValue({ syntaxError: null, analyzerAvailable: false, findings: [] });
    setup();
    fireEvent.click(checkButton());
    expect(await screen.findByText(/access-analyzer:ValidatePolicy 권한이 없어서 JSON 문법만 확인했어요/)).toBeInTheDocument();
    expect(screen.queryByText("검사에서 문제가 발견되지 않았어요")).not.toBeInTheDocument();
  });

  test("a failing check shows the error and the editor keeps working", async () => {
    m.validatePolicy.mockRejectedValue({ kind: "network", message: "timeout" });
    setup();
    typeDoc(CHANGED);
    fireEvent.click(checkButton());
    expect(await screen.findByText("네트워크 오류: timeout")).toBeInTheDocument();
    expect(checkButton()).toBeEnabled();
    expect(previewButton()).toBeEnabled();
  });

  test("editing the text clears the old result: it would describe a different document", async () => {
    setup();
    fireEvent.click(checkButton());
    await screen.findByText("검사에서 문제가 발견되지 않았어요");
    typeDoc(CHANGED);
    expect(screen.queryByText("검사에서 문제가 발견되지 않았어요")).not.toBeInTheDocument();
  });

  test("a result that arrives after the text was edited is dropped", async () => {
    let resolve!: (v: ValidationResult) => void;
    m.validatePolicy.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    fireEvent.click(checkButton());
    typeDoc(CHANGED);
    resolve({ syntaxError: null, analyzerAvailable: true, findings: [{ level: "error", code: "X", message: "낡은 결과" }] });
    await waitFor(() => expect(checkButton()).toBeEnabled());
    expect(screen.queryByText("낡은 결과")).not.toBeInTheDocument();
  });

  test("checking does not submit anything", async () => {
    const { props } = setup();
    fireEvent.click(checkButton());
    await screen.findByText("검사에서 문제가 발견되지 않았어요");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});

describe("adding a new inline policy", () => {
  const setupNew = (extra: Partial<React.ComponentProps<typeof PolicyEditor>> = {}) =>
    setup({ mode: "new", name: undefined, title: "인라인 정책 추가", document: undefined, existingNames: ["s3-scratch"], ...extra });

  test("starts from a valid template and asks for a name", () => {
    setupNew();
    expect(editor()).toHaveValue(NEW_POLICY_TEMPLATE);
    expect(() => JSON.parse(NEW_POLICY_TEMPLATE)).not.toThrow();
    expect(nameInput()).toHaveValue("");
    expect(previewButton()).toBeDisabled();
  });

  test("a valid name enables the preview and is handed over trimmed with the text", () => {
    const { props } = setupNew();
    fireEvent.change(nameInput(), { target: { value: "  queue-access " } });
    expect(previewButton()).toBeEnabled();
    fireEvent.click(previewButton());
    expect(props.onSubmit).toHaveBeenCalledWith("queue-access", NEW_POLICY_TEMPLATE.trim());
  });

  test.each([
    ["has spaces", "my policy", /영문자, 숫자/],
    ["has a slash", "a/b", /영문자, 숫자/],
    ["is too long", "a".repeat(129), /128자/],
  ])("a name that %s is refused with the reason", (_label, value, message) => {
    setupNew();
    fireEvent.change(nameInput(), { target: { value } });
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
  });

  test("the allowed punctuation is accepted", () => {
    setupNew();
    fireEvent.change(nameInput(), { target: { value: "A_b-c.d+e=f,g@h" } });
    expect(previewButton()).toBeEnabled();
  });

  test("a name that is already taken (even in another case) is refused so nothing is overwritten by accident", () => {
    const { props } = setupNew();
    fireEvent.change(nameInput(), { target: { value: "S3-Scratch" } });
    expect(screen.getByText(/같은 이름의 인라인 정책이 이미 있어요/)).toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
    fireEvent.click(previewButton());
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  test("no complaint about an empty name until something was typed", () => {
    setupNew();
    expect(screen.queryByText(/영문자, 숫자/)).not.toBeInTheDocument();
    expect(screen.queryByText("정책 이름을 입력하세요")).not.toBeInTheDocument();
  });
});
