import { fireEvent, render, screen, within } from "@testing-library/react";
import { adminPolicy, admins, alice, bob, ciBot, deployPolicy, devTeam, orphanPolicy, readOnlyPolicy } from "./fixtures";
import { PolicyList } from "./PolicyList";
import { PrincipalList } from "./PrincipalList";

const users = [bob, alice, ciBot];

function renderUsers(props: Partial<React.ComponentProps<typeof PrincipalList>> = {}) {
  const onSelect = vi.fn();
  const onOpen = vi.fn();
  render(<PrincipalList kind="user" items={users} filter="" selectedId={null} onSelect={onSelect} onOpen={onOpen} {...props} />);
  return { onSelect, onOpen };
}

const bodyRows = () => screen.getAllByRole("row").slice(1);

test("lists users sorted by name with badges, last used and policy count", () => {
  renderUsers();
  const rows = bodyRows();
  expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["alice", "bob", "ci-bot"]);
  const bobRow = rows[1];
  expect(within(bobRow).getByText("MFA 없음")).toHaveClass("danger");
  expect(within(bobRow).getByText("오래된 키")).toBeInTheDocument();
  expect(within(bobRow).getByText("2026-05-02")).toBeInTheDocument();
  expect(within(rows[0]).getByText("2026-10-20")).toBeInTheDocument();
  // 사용 기록이 없으면 안내 문구
  expect(within(rows[2]).getByText("기록 없음")).toBeInTheDocument();
  expect(within(rows[0]).getAllByRole("cell")[3].textContent).toBe("3");
});

test("groups show member counts instead of last used", () => {
  render(<PrincipalList kind="group" items={[devTeam, admins]} filter="" selectedId={null} onSelect={vi.fn()} onOpen={vi.fn()} />);
  expect(screen.getByRole("columnheader", { name: /구성원/ })).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: /마지막 사용/ })).not.toBeInTheDocument();
  const row = screen.getByText("dev-team").closest("tr")!;
  expect(within(row).getAllByRole("cell")[2].textContent).toBe("2");
});

test("shows the path under the name when it is not the root path", () => {
  const slr = { ...bob, name: "svc", path: "/aws-service-role/x/" };
  renderUsers({ items: [slr] });
  expect(screen.getByText("/aws-service-role/x/")).toBeInTheDocument();
});

test("filters by name or ARN, case-insensitively", () => {
  const { rerender } = render(
    <PrincipalList kind="user" items={users} filter="BOB" selectedId={null} onSelect={vi.fn()} onOpen={vi.fn()} />,
  );
  expect(screen.getAllByRole("row")).toHaveLength(2);
  expect(screen.getByText("bob")).toBeInTheDocument();
  rerender(<PrincipalList kind="user" items={users} filter="user/ci-" selectedId={null} onSelect={vi.fn()} onOpen={vi.fn()} />);
  expect(screen.getByText("ci-bot")).toBeInTheDocument();
  expect(screen.queryByText("bob")).not.toBeInTheDocument();
  rerender(<PrincipalList kind="user" items={users} filter="zzz" selectedId={null} onSelect={vi.fn()} onOpen={vi.fn()} />);
  expect(screen.getByText("조건에 맞는 사용자가 없어요")).toBeInTheDocument();
});

test("shows an empty message when there are no items", () => {
  renderUsers({ items: [] });
  expect(screen.getByText("사용자가 없어요")).toBeInTheDocument();
});

test("click selects, double click opens, Enter opens the selected row", () => {
  const { onSelect, onOpen } = renderUsers({ selectedId: bob.arn });
  fireEvent.click(screen.getByText("alice"));
  expect(onSelect).toHaveBeenCalledWith(alice.arn);
  fireEvent.doubleClick(screen.getByText("ci-bot"));
  expect(onOpen).toHaveBeenCalledWith(ciBot.arn);
  fireEvent.keyDown(screen.getByTestId("iam-list"), { key: "Enter" });
  expect(onOpen).toHaveBeenLastCalledWith(bob.arn);
});

test("arrow keys move the selection through the sorted rows", () => {
  const { onSelect } = renderUsers({ selectedId: alice.arn });
  const list = screen.getByTestId("iam-list");
  fireEvent.keyDown(list, { key: "ArrowDown" });
  expect(onSelect).toHaveBeenLastCalledWith(bob.arn);
  fireEvent.keyDown(list, { key: "ArrowUp" });
  expect(onSelect).toHaveBeenLastCalledWith(alice.arn); // 맨 위에서 더 올라가지 않는다
});

test("marks the selected row", () => {
  renderUsers({ selectedId: bob.arn });
  expect(screen.getByText("bob").closest("tr")).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("alice").closest("tr")).toHaveAttribute("aria-selected", "false");
});

test("clicking a column header sorts, clicking again reverses", () => {
  renderUsers();
  const names = () => bodyRows().map((r) => within(r).getAllByRole("cell")[0].textContent);
  fireEvent.click(screen.getByRole("columnheader", { name: /이름/ }));
  expect(names()).toEqual(["ci-bot", "bob", "alice"]);
  fireEvent.click(screen.getByRole("columnheader", { name: /마지막 사용/ }));
  // 오래된 순, 기록 없음은 방향과 상관없이 맨 아래
  expect(names()).toEqual(["bob", "alice", "ci-bot"]);
  fireEvent.click(screen.getByRole("columnheader", { name: /마지막 사용/ }));
  expect(names()).toEqual(["alice", "bob", "ci-bot"]);
});

describe("PolicyList", () => {
  const policies = [readOnlyPolicy, orphanPolicy, adminPolicy, deployPolicy];

  test("shows scope, attachment count, updated date and badges", () => {
    render(<PolicyList items={policies} filter="" selectedId={null} onSelect={vi.fn()} onOpen={vi.fn()} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual([
      "AdministratorAccess",
      "app-deploy",
      "legacy-unused",
      "ReadOnlyAccess",
    ]);
    const admin = rows[0];
    expect(within(admin).getByText("AWS 관리형")).toBeInTheDocument();
    expect(within(admin).getByText("관리자급")).toHaveClass("danger");
    expect(within(admin).getAllByRole("cell")[2].textContent).toBe("2");
    const deploy = rows[1];
    expect(within(deploy).getByText("고객 관리형")).toBeInTheDocument();
    expect(within(deploy).getByText("2026-08-01")).toBeInTheDocument();
    expect(within(rows[2]).getByText("안 붙음")).toBeInTheDocument();
  });

  test("does not repeat the AWS-managed badge next to the scope column", () => {
    render(<PolicyList items={[adminPolicy]} filter="" selectedId={null} onSelect={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getAllByText("AWS 관리형")).toHaveLength(1);
  });

  test("filters by name and opens with double click", () => {
    const onOpen = vi.fn();
    render(<PolicyList items={policies} filter="deploy" selectedId={null} onSelect={vi.fn()} onOpen={onOpen} />);
    expect(screen.getAllByRole("row")).toHaveLength(2);
    fireEvent.doubleClick(screen.getByText("app-deploy"));
    expect(onOpen).toHaveBeenCalledWith(deployPolicy.id);
  });

  test("shows an empty message", () => {
    render(<PolicyList items={[]} filter="" selectedId={null} onSelect={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText("정책이 없어요")).toBeInTheDocument();
  });
});

describe("scrolling to the selection", () => {
  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  test("scrolls the selected row into view when the list opens", () => {
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    renderUsers({ selectedId: ciBot.arn });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(scroll.mock.contexts[0]).toBe(screen.getByText("ci-bot").closest("tr"));
  });

  test("follows the selection when it moves, e.g. with the arrow keys", () => {
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    const { rerender } = render(<PrincipalList kind="user" items={users} filter="" selectedId={alice.arn} onSelect={vi.fn()} onOpen={vi.fn()} />);
    rerender(<PrincipalList kind="user" items={users} filter="" selectedId={bob.arn} onSelect={vi.fn()} onOpen={vi.fn()} />);
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(scroll.mock.contexts[1]).toBe(screen.getByText("bob").closest("tr"));
  });

  test("nothing to scroll without a selection, and no error where scrollIntoView does not exist", () => {
    renderUsers();
    renderUsers({ selectedId: alice.arn });
    expect(screen.getAllByTestId("iam-list")).toHaveLength(2);
  });
});
