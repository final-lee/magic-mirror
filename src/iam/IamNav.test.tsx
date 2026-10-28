import { fireEvent, render, screen, within } from "@testing-library/react";
import { IamNav } from "./IamNav";

const counts = { findings: 4, users: 3, groups: 2, roles: 5, policies: 7 };

test("lists the menu in order with the counts", () => {
  render(<IamNav view="users" counts={counts} onSelect={vi.fn()} />);
  const items = screen.getAllByRole("button");
  const labels = ["점검", "사용자", "그룹", "역할", "정책", "할당", "누가 할 수 있나", "변경 기록"];
  expect(items).toHaveLength(labels.length);
  labels.forEach((label, i) => expect(within(items[i]).getByText(label)).toBeInTheDocument());
  expect(items.map((b) => within(b).queryByTestId("nav-count")?.textContent ?? null)).toEqual(["4", "3", "2", "5", "7", null, null, null]);
});

test("the current view is marked", () => {
  render(<IamNav view="roles" counts={counts} onSelect={vi.fn()} />);
  expect(screen.getByRole("button", { name: /역할/ })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: /사용자/ })).not.toHaveAttribute("aria-current");
});

test("clicking an item selects its view", () => {
  const onSelect = vi.fn();
  render(<IamNav view="users" counts={counts} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: /누가 할 수 있나/ }));
  expect(onSelect).toHaveBeenCalledWith("whoCan");
  fireEvent.click(screen.getByRole("button", { name: /점검/ }));
  expect(onSelect).toHaveBeenLastCalledWith("findings");
});

test("open findings stand out; zero findings do not", () => {
  const { rerender } = render(<IamNav view="users" counts={counts} onSelect={vi.fn()} />);
  expect(within(screen.getByRole("button", { name: /점검/ })).getByTestId("nav-count")).toHaveClass("alert");
  rerender(<IamNav view="users" counts={{ ...counts, findings: 0 }} onSelect={vi.fn()} />);
  expect(within(screen.getByRole("button", { name: /점검/ })).getByTestId("nav-count")).not.toHaveClass("alert");
});

test("the assignments item shows the number of queued changes, and nothing while the tray is empty", () => {
  const { rerender } = render(<IamNav view="assignments" counts={counts} onSelect={vi.fn()} />);
  const item = () => screen.getByRole("button", { name: /할당/ });
  expect(within(item()).queryByTestId("nav-count")).not.toBeInTheDocument();
  rerender(<IamNav view="assignments" counts={{ ...counts, assignments: 3 }} onSelect={vi.fn()} />);
  expect(within(item()).getByTestId("nav-count")).toHaveTextContent("3");
  expect(item()).toHaveAttribute("aria-current", "page");
});

test("clicking the assignments item selects its view", () => {
  const onSelect = vi.fn();
  render(<IamNav view="users" counts={counts} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: /할당/ }));
  expect(onSelect).toHaveBeenCalledWith("assignments");
});
