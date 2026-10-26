import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithClient } from "../test/utils";
import { iamApi } from "./api";
import { BADGES } from "./fixtures";
import { PolicyPicker } from "./PolicyPicker";
import type { PolicyRef } from "./types";

vi.mock("./api", () => ({ iamApi: { listPolicies: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(iamApi);

const ref = (name: string, extra: Partial<PolicyRef> = {}): PolicyRef => ({
  arn: `arn:aws:iam::aws:policy/${name}`,
  name,
  scope: "aws",
  description: null,
  badges: [BADGES.awsManaged],
  ...extra,
});
const readOnly = ref("ReadOnlyAccess", { description: "AWS 서비스를 읽기 전용으로 볼 수 있어요" });
const admin = ref("AdministratorAccess", { badges: [BADGES.awsManaged, BADGES.admin] });
const appDeploy = ref("app-deploy", { arn: "arn:aws:iam::123456789012:policy/app-deploy", scope: "local", badges: [] });

function setup(extra: Partial<React.ComponentProps<typeof PolicyPicker>> = {}) {
  const props = { onPick: vi.fn(), onClose: vi.fn() };
  const utils = renderWithClient(<PolicyPicker profile="prod" targetName="bob" attachedArns={[]} {...props} {...extra} />);
  return { props, ...utils };
}
const search = () => screen.getByRole("searchbox", { name: "정책 검색" });
const option = (name: RegExp | string) => screen.findByRole("option", { name });

beforeEach(() => {
  vi.clearAllMocks();
  m.listPolicies.mockResolvedValue([readOnly, admin, appDeploy]);
});

describe("listing", () => {
  test("opens with the search box focused and lists policies with scope, badges and description", async () => {
    setup();
    expect(screen.getByRole("dialog", { name: "정책 붙이기" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("붙일 정책을 고르세요 (대상: bob)")).toBeInTheDocument();
    expect(search()).toHaveFocus();
    const first = await option(/ReadOnlyAccess/);
    expect(m.listPolicies).toHaveBeenCalledWith("prod", "");
    expect(within(first).getByText("AWS 관리형")).toBeInTheDocument();
    expect(within(first).getByText("AWS 서비스를 읽기 전용으로 볼 수 있어요")).toBeInTheDocument();
    const adminOption = await option(/AdministratorAccess/);
    expect(within(adminOption).getByText("관리자급")).toHaveClass("danger");
    // 범위 칸이 이미 알려 주는 AWS 관리형 배지는 되풀이하지 않는다
    expect(screen.queryByText("AWS 관리형", { selector: ".iam-badge" })).not.toBeInTheDocument();
    expect(within(await option(/app-deploy/)).getByText("고객 관리형")).toBeInTheDocument();
  });

  test("shows a loading message first and an empty message when nothing matches", async () => {
    let resolve!: (v: PolicyRef[]) => void;
    m.listPolicies.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    expect(screen.getByText("정책을 불러오는 중…")).toBeInTheDocument();
    resolve([]);
    expect(await screen.findByText("조건에 맞는 정책이 없어요")).toBeInTheDocument();
  });

  test("shows the error with a retry", async () => {
    m.listPolicies.mockRejectedValueOnce({ kind: "accessDenied", action: "iam:ListPolicies" });
    setup();
    expect(await screen.findByText("권한 없음 (iam:ListPolicies)")).toBeInTheDocument();
  });

  test("tells that the list is capped at 100", async () => {
    m.listPolicies.mockResolvedValue(Array.from({ length: 100 }, (_, i) => ref(`policy-${i}`)));
    setup();
    expect(await screen.findByText(/최대 100개까지만 보여줘요/)).toBeInTheDocument();
  });
});

describe("searching", () => {
  test("typing searches by name after a short pause, not on every keystroke", async () => {
    setup();
    await option(/ReadOnlyAccess/);
    fireEvent.change(search(), { target: { value: "R" } });
    fireEvent.change(search(), { target: { value: "Re" } });
    fireEvent.change(search(), { target: { value: "Read" } });
    await waitFor(() => expect(m.listPolicies).toHaveBeenCalledWith("prod", "Read"));
    expect(m.listPolicies).not.toHaveBeenCalledWith("prod", "R");
    expect(m.listPolicies).not.toHaveBeenCalledWith("prod", "Re");
    expect(m.listPolicies).toHaveBeenCalledTimes(2);
  });

  test("the query is trimmed", async () => {
    setup();
    await option(/ReadOnlyAccess/);
    fireEvent.change(search(), { target: { value: "  Admin " } });
    await waitFor(() => expect(m.listPolicies).toHaveBeenCalledWith("prod", "Admin"));
  });
});

describe("choosing", () => {
  test("clicking a policy hands it over", async () => {
    const { props } = setup();
    fireEvent.click(await option(/ReadOnlyAccess/));
    expect(props.onPick).toHaveBeenCalledWith(readOnly);
  });

  test("policies that are already attached are shown but cannot be chosen", async () => {
    const { props } = setup({ attachedArns: [readOnly.arn] });
    const row = await option(/ReadOnlyAccess/);
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(within(row).getByText("이미 붙어 있어요")).toBeInTheDocument();
    fireEvent.click(row);
    expect(props.onPick).not.toHaveBeenCalled();
    fireEvent.click(await option(/AdministratorAccess/));
    expect(props.onPick).toHaveBeenCalledWith(admin);
  });

  test("arrow keys move through the enabled policies and Enter chooses; Enter alone chooses nothing", async () => {
    const { props } = setup({ attachedArns: [readOnly.arn] });
    await option(/AdministratorAccess/);
    await userEvent.keyboard("{Enter}");
    expect(props.onPick).not.toHaveBeenCalled();
    await userEvent.keyboard("{ArrowDown}");
    expect(await option(/AdministratorAccess/)).toHaveAttribute("aria-selected", "true"); // 붙어 있는 첫 항목은 건너뛴다
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(await option(/app-deploy/)).toHaveAttribute("aria-selected", "true"); // 끝에서 멈춘다
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(props.onPick).toHaveBeenCalledWith(admin);
  });
});

describe("closing", () => {
  test("Tab stays inside the picker: search box → 취소 → search box", async () => {
    setup();
    await option(/ReadOnlyAccess/);
    expect(search()).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
    await userEvent.tab();
    expect(search()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
  });

  test("Escape and 취소 close it", async () => {
    const { props } = setup();
    await option(/ReadOnlyAccess/);
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
    expect(props.onPick).not.toHaveBeenCalled();
  });
});
