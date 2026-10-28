import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginPrompt } from "./LoginPrompt";
import { LOGIN_NAME_INVALID, LOGIN_NAME_TOO_LONG } from "./loginName";

// 눈에 보이지 않는 문자는 코드 포인트로 쓴다
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);
const NUL = String.fromCodePoint(0);

function setup(props: Partial<React.ComponentProps<typeof LoginPrompt>> = {}) {
  const onSubmit = vi.fn();
  render(<LoginPrompt onSubmit={onSubmit} {...props} />);
  return { onSubmit, input: screen.getByRole("textbox", { name: "DB 사용자" }) as HTMLInputElement };
}

test("has the title, the intro and the button, word for word", () => {
  setup();
  expect(screen.getByRole("heading", { name: "DB 사용자" })).toBeInTheDocument();
  expect(screen.getByText("IAM 인증으로 접속할 DB 사용자 이름을 입력하세요(예: iam_admin). 이 대상에 대해 기억해 둘게요")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "연결" })).toBeInTheDocument();
});

test("starts empty with the cursor in the field, and the button waits for a name", () => {
  const { input } = setup();
  expect(input).toHaveValue("");
  expect(input).toHaveFocus();
  expect(screen.getByRole("button", { name: "연결" })).toBeDisabled();
  fireEvent.change(input, { target: { value: "   " } });
  expect(screen.getByRole("button", { name: "연결" })).toBeDisabled();
});

test("submits the name without the spaces around it, by button or by Enter", async () => {
  const user = userEvent.setup();
  const { onSubmit, input } = setup();
  await user.type(input, "  iam_admin ");
  await user.click(screen.getByRole("button", { name: "연결" }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith("iam_admin");

  await user.type(input, "{Enter}");
  expect(onSubmit).toHaveBeenCalledTimes(2);
  expect(onSubmit).toHaveBeenLastCalledWith("iam_admin");
});

test("does not submit an empty name, not even with Enter", async () => {
  const user = userEvent.setup();
  const { onSubmit, input } = setup();
  await user.type(input, "   {Enter}");
  expect(onSubmit).not.toHaveBeenCalled();
});

test("does not submit an empty name when the form is submitted without going through the button", () => {
  const { onSubmit, input } = setup();
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  expect(onSubmit).not.toHaveBeenCalled();
});

test("opens with the name it is given, and 취소 only exists when there is something to go back to", async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  const first = setup({ initial: "iam_admin", onCancel });
  expect(first.input).toHaveValue("iam_admin");
  await user.click(screen.getByRole("button", { name: "취소" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(first.onSubmit).not.toHaveBeenCalled();
});

test("the first prompt has no 취소", () => {
  setup();
  expect(screen.queryByRole("button", { name: "취소" })).not.toBeInTheDocument();
});

describe("names the backend refuses", () => {
  const typed = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });
  const connect = () => screen.getByRole("button", { name: "연결" });

  test("a name with a space inside says why under the field, keeps 연결 off and submits nothing", async () => {
    const user = userEvent.setup();
    const { onSubmit, input } = setup();
    await user.type(input, "iam admin");
    const message = screen.getByText(LOGIN_NAME_INVALID);
    expect(message).toBeInTheDocument();
    // 입력칸 아래에 있고, 입력칸과 이어져 있다
    expect(input.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(LOGIN_NAME_INVALID);
    expect(connect()).toBeDisabled();
    await user.type(input, "{Enter}");
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a name over 63 bytes gets the length message, counted in bytes", () => {
    const { onSubmit, input } = setup();
    typed(input, `${"가".repeat(21)}a`); // 22글자지만 64바이트
    expect(screen.getByText(LOGIN_NAME_TOO_LONG)).toBeInTheDocument();
    expect(connect()).toBeDisabled();
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a name of exactly 63 bytes is accepted", async () => {
    const user = userEvent.setup();
    const { onSubmit, input } = setup();
    typed(input, "가".repeat(21));
    expect(screen.queryByText(LOGIN_NAME_TOO_LONG)).not.toBeInTheDocument();
    await user.click(connect());
    expect(onSubmit).toHaveBeenCalledWith("가".repeat(21));
  });

  test("the length message comes before the character message, as in the backend", () => {
    const { input } = setup();
    typed(input, `${"a".repeat(40)} ${"b".repeat(40)}`);
    expect(screen.getByText(LOGIN_NAME_TOO_LONG)).toBeInTheDocument();
    expect(screen.queryByText(LOGIN_NAME_INVALID)).not.toBeInTheDocument();
  });

  test.each(['a"b', "a<b", "a>b", "a#b", "a&b", "a%b", "a+b", `a${IDEOGRAPHIC_SPACE}b`, `a${NUL}b`])("%j is refused", (name) => {
    const { onSubmit, input } = setup();
    typed(input, name);
    expect(screen.getByText(LOGIN_NAME_INVALID)).toBeInTheDocument();
    expect(connect()).toBeDisabled();
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("the spaces around a name are not part of it: they neither show a message nor stop the name", async () => {
    const user = userEvent.setup();
    const { onSubmit, input } = setup();
    typed(input, "  iam_admin  ");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    await user.click(connect());
    expect(onSubmit).toHaveBeenCalledWith("iam_admin");
  });

  test("a space inside is refused even when there are spaces around it too", () => {
    const { input } = setup();
    typed(input, "  iam admin  ");
    expect(screen.getByText(LOGIN_NAME_INVALID)).toBeInTheDocument();
    expect(connect()).toBeDisabled();
  });

  test("there is no message for an empty field or for spaces only, just a button that waits", () => {
    const { input } = setup();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    typed(input, "   ");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(connect()).toBeDisabled();
  });

  test("the message goes away when the name is fixed, and then the name can be submitted", async () => {
    const user = userEvent.setup();
    const { onSubmit, input } = setup();
    typed(input, "iam admin");
    expect(screen.getByRole("alert")).toHaveTextContent(LOGIN_NAME_INVALID);
    typed(input, "iam_admin");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    expect(input).not.toHaveAttribute("aria-describedby");
    await user.click(connect());
    expect(onSubmit).toHaveBeenCalledWith("iam_admin");
  });

  test("a remembered name that is not valid shows its message as soon as the prompt opens", () => {
    const { onSubmit } = setup({ initial: "iam admin", onCancel: vi.fn() });
    expect(screen.getByText(LOGIN_NAME_INVALID)).toBeInTheDocument();
    expect(connect()).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
