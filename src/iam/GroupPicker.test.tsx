import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { admins, alice, bob, ciBot, devTeam } from "./fixtures";
import { GroupPicker, UserPicker } from "./GroupPicker";

describe("GroupPicker", () => {
  function setup(extra: Partial<React.ComponentProps<typeof GroupPicker>> = {}) {
    const props = { onPick: vi.fn(), onClose: vi.fn() };
    render(<GroupPicker groups={[devTeam, admins]} memberOf={[]} userName="alice" {...props} {...extra} />);
    return props;
  }
  const search = () => screen.getByRole("searchbox", { name: "그룹 검색" });

  test("lists the account's groups by name with member counts, focus in the search box", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "그룹에 추가" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("넣을 그룹을 고르세요 (사용자: alice)")).toBeInTheDocument();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("admins"), expect.stringContaining("dev-team")]);
    expect(search()).toHaveFocus();
    const dev = screen.getByRole("option", { name: /dev-team/ });
    expect(within(dev).getByText("구성원 2명 · 정책 1개")).toBeInTheDocument();
    expect(within(screen.getByRole("option", { name: /admins/ })).getByText("관리자급")).toBeInTheDocument();
  });

  test("filters by name, case-insensitively, and says when nothing matches", () => {
    setup();
    fireEvent.change(search(), { target: { value: "DEV" } });
    expect(screen.getByRole("option", { name: /dev-team/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /admins/ })).not.toBeInTheDocument();
    fireEvent.change(search(), { target: { value: "nothing" } });
    expect(screen.getByText("조건에 맞는 그룹이 없어요")).toBeInTheDocument();
  });

  test("the groups the user already belongs to are shown but cannot be chosen", () => {
    const props = setup({ memberOf: ["dev-team"] });
    const dev = screen.getByRole("option", { name: /dev-team/ });
    expect(dev).toHaveAttribute("aria-disabled", "true");
    expect(within(dev).getByText("이미 소속돼 있어요")).toBeInTheDocument();
    fireEvent.click(dev);
    expect(props.onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: /admins/ }));
    expect(props.onPick).toHaveBeenCalledWith(admins);
  });

  test("an account without groups says so", () => {
    setup({ groups: [] });
    expect(screen.getByText("그룹이 없어요")).toBeInTheDocument();
  });

  test("keyboard: arrows and Enter choose, Escape closes", async () => {
    const props = setup();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}"); // 이름순이라 둘째는 dev-team
    expect(props.onPick).toHaveBeenCalledWith(devTeam);
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("UserPicker", () => {
  function setup(extra: Partial<React.ComponentProps<typeof UserPicker>> = {}) {
    const props = { onPick: vi.fn(), onClose: vi.fn() };
    render(<UserPicker users={[alice, bob, ciBot]} members={["alice"]} groupName="dev-team" {...props} {...extra} />);
    return props;
  }

  test("lists the users, marks current members, and hands over the chosen one", () => {
    const props = setup();
    expect(screen.getByRole("dialog", { name: "사용자 추가" })).toBeInTheDocument();
    expect(screen.getByText("넣을 사용자를 고르세요 (그룹: dev-team)")).toBeInTheDocument();
    const aliceOption = screen.getByRole("option", { name: /alice/ });
    expect(aliceOption).toHaveAttribute("aria-disabled", "true");
    expect(within(aliceOption).getByText("이미 구성원이에요")).toBeInTheDocument();
    expect(within(screen.getByRole("option", { name: /bob/ })).getByText("MFA 없음")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /bob/ }));
    expect(props.onPick).toHaveBeenCalledWith(bob);
  });

  test("filters users by name", () => {
    setup();
    fireEvent.change(screen.getByRole("searchbox", { name: "사용자 검색" }), { target: { value: "ci" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /ci-bot/ })).toBeInTheDocument();
  });

  test("취소 closes without choosing", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onPick).not.toHaveBeenCalled();
  });
});
