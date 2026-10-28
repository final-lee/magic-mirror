import { fireEvent, render, screen, within } from "@testing-library/react";
import { PgNav } from "./PgNav";

test("lists the six menu items in order", () => {
  render(<PgNav view="roles" counts={{}} onSelect={vi.fn()} />);
  expect(screen.getByRole("navigation", { name: "PostgreSQL 메뉴" })).toBeInTheDocument();
  const items = screen.getAllByRole("button");
  const labels = ["점검", "역할", "권한", "기본 권한", "누가 할 수 있나", "세션"];
  expect(items).toHaveLength(labels.length);
  labels.forEach((label, i) => expect(within(items[i]).getByText(label)).toBeInTheDocument());
});

test("only the 점검 item shows a count, and only once it is known", () => {
  const { rerender } = render(<PgNav view="roles" counts={{}} onSelect={vi.fn()} />);
  expect(screen.queryByTestId("nav-count")).not.toBeInTheDocument();
  rerender(<PgNav view="roles" counts={{ findings: 5 }} onSelect={vi.fn()} />);
  expect(screen.getAllByTestId("nav-count")).toHaveLength(1);
  expect(within(screen.getByRole("button", { name: /점검/ })).getByTestId("nav-count")).toHaveTextContent("5");
});

test("open findings stand out; zero findings still show 0 without the alert look", () => {
  const { rerender } = render(<PgNav view="roles" counts={{ findings: 5 }} onSelect={vi.fn()} />);
  expect(screen.getByTestId("nav-count")).toHaveClass("alert");
  rerender(<PgNav view="roles" counts={{ findings: 0 }} onSelect={vi.fn()} />);
  expect(screen.getByTestId("nav-count")).toHaveTextContent("0");
  expect(screen.getByTestId("nav-count")).not.toHaveClass("alert");
});

test("the current view is marked", () => {
  render(<PgNav view="privileges" counts={{}} onSelect={vi.fn()} />);
  expect(screen.getByRole("button", { name: /^권한/ })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: /기본 권한/ })).not.toHaveAttribute("aria-current");
  expect(screen.getByRole("button", { name: /역할/ })).not.toHaveAttribute("aria-current");
});

test("clicking an item selects its view", () => {
  const onSelect = vi.fn();
  render(<PgNav view="roles" counts={{}} onSelect={onSelect} />);
  const views = [
    ["점검", "findings"],
    ["역할", "roles"],
    ["권한", "privileges"],
    ["기본 권한", "defaults"],
    ["누가 할 수 있나", "whoCan"],
    ["세션", "sessions"],
  ] as const;
  for (const [label, view] of views) {
    fireEvent.click(within(screen.getByRole("navigation")).getByText(label).closest("button")!);
    expect(onSelect).toHaveBeenLastCalledWith(view);
  }
  expect(onSelect).toHaveBeenCalledTimes(6);
});
