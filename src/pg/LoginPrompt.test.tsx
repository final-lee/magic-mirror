import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginPrompt } from "./LoginPrompt";

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
