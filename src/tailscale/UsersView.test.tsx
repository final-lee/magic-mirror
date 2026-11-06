import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { devicesApi, tailscaleApi } from "./api";
import { UsersView } from "./UsersView";
import { useTailscaleApi } from "./useTailscaleApi";

vi.mock("./api", () => ({
  tailscaleApi: { users: vi.fn(), userInvites: vi.fn(), userApply: vi.fn() },
  devicesApi: { changes: vi.fn() },
}));
vi.mock("./useTailscaleApi", () => ({ useTailscaleApi: vi.fn() }));
const user = { id: "u1", loginName: "user@example.com", role: "member", status: "active" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useTailscaleApi).mockReturnValue({ tailnet: "example.com", connected: true, isLoading: false });
  vi.mocked(tailscaleApi.users).mockResolvedValue({ users: [user] });
  vi.mocked(tailscaleApi.userInvites).mockResolvedValue([]);
  vi.mocked(tailscaleApi.userApply).mockResolvedValue(null);
  vi.mocked(devicesApi.changes).mockResolvedValue([]);
});

test.each([
  ["역할 바꾸기", "role"],
  ["승인", "approve"],
  ["정지", "suspend"],
  ["삭제", "delete"],
])("%s previews before applying", async (label, action) => {
  renderWithClient(<UsersView />);
  const row = (await screen.findByText(user.loginName)).closest("tr")!;
  fireEvent.click(within(row).getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: label }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(new RegExp(`/users/u1/${action}`))).toBeInTheDocument();
  expect(tailscaleApi.userApply).not.toHaveBeenCalled();
  const apply = within(dialog).getByRole("button", { name: "적용" });
  if (action === "delete") {
    expect(apply).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: user.loginName } });
  }
  fireEvent.click(apply);
  await waitFor(() => expect(tailscaleApi.userApply).toHaveBeenCalledWith(expect.objectContaining({ action, id: "u1" })));
});

test("previews an email invitation before creation", async () => {
  renderWithClient(<UsersView />);
  await screen.findByText(user.loginName);
  fireEvent.change(screen.getByPlaceholderText("email"), { target: { value: "new@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "초대 만들기" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/POST \/tailnet\/-\/user-invites/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "적용" }));
  await waitFor(() => expect(tailscaleApi.userApply).toHaveBeenCalledWith(expect.objectContaining({
    action: "createInvite", value: { email: "new@example.com", role: "member" },
  })));
});

test("owner transfer requires the user's name before applying", async () => {
  renderWithClient(<UsersView />);
  const row = (await screen.findByText(user.loginName)).closest("tr")!;
  fireEvent.click(within(row).getByRole("checkbox"));
  const role = screen.getByRole("button", { name: "역할 바꾸기" }).closest(".argowf-batch")!.querySelector("select")!;
  fireEvent.change(role, { target: { value: "owner" } });
  fireEvent.click(screen.getByRole("button", { name: "역할 바꾸기" }));
  const dialog = screen.getByRole("dialog");
  const apply = within(dialog).getByRole("button", { name: "적용" });
  expect(apply).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: user.loginName } });
  fireEvent.click(apply);
  await waitFor(() => expect(tailscaleApi.userApply).toHaveBeenCalledWith(expect.objectContaining({
    action: "role", value: "owner", typed: user.loginName,
  })));
});
