import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appUsers, sampleTargetInfo } from "./fixtures";
import { defaultLogin, LoginPrompt } from "./LoginPrompt";

function setup(info = sampleTargetInfo(), props: Partial<React.ComponentProps<typeof LoginPrompt>> = {}) {
  const onSubmit = vi.fn();
  render(<LoginPrompt info={info} initial={null} onSubmit={onSubmit} {...props} />);
  return { onSubmit };
}
const mode = (label: string) => screen.getByRole("radio", { name: new RegExp(`^${label}`) });

describe("the mode that is preselected from what is known about the cache", () => {
  const plain = { users: null, userGroupIds: [] as string[], authTokenEnabled: false };

  test("a user group → a user from its list, preferring one that is not 'default'", () => {
    expect(defaultLogin(sampleTargetInfo(), null)).toEqual({ mode: "user", user: "app-reader", database: 0 });
  });

  test("an IAM user in the list → IAM mode (when the cache supports it)", () => {
    const users = [appUsers[2]];
    expect(defaultLogin(sampleTargetInfo({ users }), null)).toEqual({ mode: "iam", user: "app-iam", database: 0 });
    expect(defaultLogin(sampleTargetInfo({ users, iamSupported: false }), null).mode).toBe("user");
  });

  test("a user group that could not be read → user mode with the name typed in", () => {
    expect(defaultLogin(sampleTargetInfo({ users: null }), null)).toEqual({ mode: "user", user: "", database: 0 });
  });

  test("an AUTH token → password", () => {
    expect(defaultLogin(sampleTargetInfo({ ...plain, authTokenEnabled: true }), null).mode).toBe("password");
  });

  test("neither → none", () => {
    expect(defaultLogin(sampleTargetInfo(plain), null).mode).toBe("none");
  });

  test("a remembered login wins over all of that", () => {
    const saved = { mode: "iam" as const, user: "app-iam", database: 2 };
    expect(defaultLogin(sampleTargetInfo(), saved)).toEqual(saved);
  });
});

test("shows the four modes with the preselected one on, and the users of the group", () => {
  setup();
  expect(screen.getByRole("radiogroup", { name: "로그인 방식" })).toBeInTheDocument();
  expect(mode("사용자")).toBeChecked();
  expect(mode("로그인 없음")).not.toBeChecked();
  expect(mode("AUTH 토큰")).not.toBeChecked();
  expect(mode("IAM")).not.toBeChecked();
  const users = screen.getByRole("radiogroup", { name: "사용자" });
  expect(users).toHaveTextContent("app-reader");
  expect(users).toHaveTextContent("app-iam");
  expect(screen.getByRole("radio", { name: /app-reader/ })).toBeChecked();
});

test("choosing an IAM user switches to IAM, and a password user back to the user mode", async () => {
  const user = userEvent.setup();
  setup();
  await user.click(screen.getByRole("radio", { name: /app-iam/ }));
  expect(mode("IAM")).toBeChecked();
  expect(screen.queryByLabelText("비밀번호")).not.toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: /app-reader/ }));
  expect(mode("사용자")).toBeChecked();
  expect(screen.getByLabelText("비밀번호")).toBeInTheDocument();
});

test("a user that needs no password hides the password field", async () => {
  const user = userEvent.setup();
  setup();
  await user.click(screen.getByRole("radio", { name: /default/ }));
  expect(mode("사용자")).toBeChecked();
  expect(screen.queryByLabelText("비밀번호")).not.toBeInTheDocument();
});

test("IAM is off when the cache does not support it", () => {
  setup(sampleTargetInfo({ iamSupported: false }));
  expect(mode("IAM")).toBeDisabled();
});

test("the user mode sends the user and the typed password, and asks to remember it by default", async () => {
  const user = userEvent.setup();
  const { onSubmit } = setup();
  await user.type(screen.getByLabelText("비밀번호"), "s3cret");
  await user.click(screen.getByRole("button", { name: "연결" }));
  expect(onSubmit).toHaveBeenCalledWith({ mode: "user", user: "app-reader", database: 0, password: "s3cret", rememberPassword: true });
});

test("without remembering the password is sent but not kept", async () => {
  const user = userEvent.setup();
  const { onSubmit } = setup();
  await user.type(screen.getByLabelText("비밀번호"), "s3cret");
  await user.click(screen.getByRole("checkbox", { name: "비밀번호 기억하기" }));
  await user.click(screen.getByRole("button", { name: "연결" }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ password: "s3cret", rememberPassword: false }));
});

test("an empty password field sends null so the keychain copy is used", async () => {
  const user = userEvent.setup();
  const { onSubmit } = setup();
  await user.click(screen.getByRole("button", { name: "연결" }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ password: null, rememberPassword: false }));
});

test("the AUTH token mode sends no user", async () => {
  const user = userEvent.setup();
  const { onSubmit } = setup(sampleTargetInfo({ users: null, userGroupIds: [], authTokenEnabled: true }));
  await user.type(screen.getByLabelText("AUTH 토큰"), "tok");
  await user.click(screen.getByRole("button", { name: "연결" }));
  expect(onSubmit).toHaveBeenCalledWith({ mode: "password", user: "", database: 0, password: "tok", rememberPassword: true });
});

test("the none mode needs nothing", async () => {
  const user = userEvent.setup();
  const { onSubmit } = setup(sampleTargetInfo({ users: null, userGroupIds: [], authTokenEnabled: false }));
  expect(screen.queryByLabelText("비밀번호")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "연결" }));
  expect(onSubmit).toHaveBeenCalledWith({ mode: "none", user: "", database: 0, password: null, rememberPassword: false });
});

test("when the user list could not be read the name is typed in, and the button waits for it", async () => {
  const user = userEvent.setup();
  const { onSubmit } = setup(sampleTargetInfo({ users: null }));
  expect(screen.getByText("사용자 목록을 읽지 못했어요. 이름을 직접 입력하세요")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "연결" })).toBeDisabled();
  await user.type(screen.getByRole("textbox", { name: "사용자 이름" }), "  me ");
  await user.click(screen.getByRole("button", { name: "연결" }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ mode: "user", user: "me" }));
});

test("a standalone cache asks for the database number, a cluster or serverless one does not", async () => {
  const user = userEvent.setup();
  const { onSubmit } = setup();
  fireEvent.change(screen.getByRole("spinbutton", { name: "DB 번호" }), { target: { value: "3" } });
  await user.click(screen.getByRole("button", { name: "연결" }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ database: 3 }));
});

test.each([{ clusterMode: true }, { serverless: true }])("no database number for %o", (over) => {
  setup(sampleTargetInfo(over));
  expect(screen.queryByRole("spinbutton", { name: "DB 번호" })).not.toBeInTheDocument();
});

test("shows why the login was asked for again", () => {
  setup(sampleTargetInfo(), { message: "비밀번호가 맞지 않아요" });
  expect(screen.getByRole("alert")).toHaveTextContent("비밀번호가 맞지 않아요");
});

test("starts from the remembered login", () => {
  setup(sampleTargetInfo(), { initial: { mode: "iam", user: "app-iam", database: 1 } });
  expect(mode("IAM")).toBeChecked();
  expect(screen.getByRole("radio", { name: /app-iam/ })).toBeChecked();
  expect(screen.getByRole("spinbutton", { name: "DB 번호" })).toHaveValue(1);
});

test("[취소] only when there is somewhere to go back to", async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  const view = render(<LoginPrompt info={sampleTargetInfo()} initial={null} onSubmit={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "취소" })).not.toBeInTheDocument();
  view.rerender(<LoginPrompt info={sampleTargetInfo()} initial={null} onSubmit={vi.fn()} onCancel={onCancel} />);
  await user.click(screen.getByRole("button", { name: "취소" }));
  expect(onCancel).toHaveBeenCalled();
});
