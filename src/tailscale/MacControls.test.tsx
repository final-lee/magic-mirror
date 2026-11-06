import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import { MacControls } from "./MacControls";

vi.mock("./api", () => ({ tailscaleApi: { localRead: vi.fn(), localApply: vi.fn() } }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(tailscaleApi.localRead).mockImplementation(async (kind) => kind === "prefs" ? '{"accept-dns":true}' : '[{"id":"7d02","nickname":"me@example.com","tailnet":"example.com","account":"me@example.com","selected":false}]');
  vi.mocked(tailscaleApi.localApply).mockResolvedValue("");
});

test("previews a preference change and offers its previous value as undo", async () => {
  renderWithClient(<MacControls tailnet="example.net" />);
  fireEvent.click(await screen.findByRole("button", { name: "Tailscale DNS 사용 끄기" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("tailscale set '--accept-dns=false'");
  expect(tailscaleApi.localApply).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "실행" }));
  await waitFor(() => expect(tailscaleApi.localApply).toHaveBeenCalledWith("preference", "--accept-dns=false", "example.net"));
  fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
  fireEvent.click(screen.getByRole("button", { name: "되돌리기: Tailscale DNS 사용" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("tailscale set '--accept-dns=true'");
});

test("logout warns about the node key and requires typed confirmation", () => {
  renderWithClient(<MacControls tailnet="example.net" />);
  fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("tailscale logout");
  expect(within(dialog).getByRole("button", { name: "실행" })).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "logout" } });
  expect(within(dialog).getByRole("button", { name: "실행" })).toBeEnabled();
});

test("account list JSON selects the account ID in the command", async () => {
  renderWithClient(<MacControls tailnet="example.net" />);
  fireEvent.click(await screen.findByRole("button", { name: "전환" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("tailscale switch '7d02'");
});

test("preferences show Korean labels with the current state and offer an exit node picker with the suggestion", async () => {
  vi.mocked(tailscaleApi.localRead).mockImplementation(async (kind) => ({
    prefs: '{"accept-routes":false,"exit-node":""}',
    accounts: "[]",
    exits: " IP  HOSTNAME  COUNTRY\n 100.1.1.1  exit-a.example.ts.net  -\n\n# To use an exit node, use `tailscale set --exit-node=`",
    suggestion: "Suggested exit node: exit-a.example.ts.net.\n",
  })[kind] ?? "");
  renderWithClient(<MacControls tailnet="example.net" />);
  expect(await screen.findByText("서브넷 경로 받기")).toBeInTheDocument();
  expect(screen.queryByText("accept-routes")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "서브넷 경로 받기 켜기" })).toHaveTextContent("켜기");
  fireEvent.click(await screen.findByRole("button", { name: "추천 노드 선택" }));
  expect(screen.getByRole("combobox", { name: "Exit node 고르기" })).toHaveValue("100.1.1.1");
  fireEvent.click(screen.getByRole("button", { name: "Exit node 변경" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("tailscale set '--exit-node=100.1.1.1'");
});
