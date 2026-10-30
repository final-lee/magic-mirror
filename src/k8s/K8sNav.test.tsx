import { fireEvent, render, screen } from "@testing-library/react";
import { K8sNav } from "./K8sNav";
import { NAV_EVENTS, NAV_LABEL, NAV_MY_PERMISSIONS, NAV_OVERVIEW, NAV_WORKLOADS } from "./text";

test("four items in order, marks the current one, selects on click", () => {
  const onSelect = vi.fn();
  render(<K8sNav view="workloads" onSelect={onSelect} />);
  const nav = screen.getByRole("navigation", { name: NAV_LABEL });
  expect(Array.from(nav.querySelectorAll("button .iam-nav-label")).map((l) => l.textContent)).toEqual([NAV_OVERVIEW, NAV_WORKLOADS, NAV_EVENTS, NAV_MY_PERMISSIONS]);
  expect(screen.getByRole("button", { name: NAV_WORKLOADS })).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: NAV_EVENTS }));
  expect(onSelect).toHaveBeenCalledWith("events");
});
