import { fireEvent, render, screen } from "@testing-library/react";
import { K8sNav, type NavBookmark } from "./K8sNav";
import { NAV_NETWORK } from "./network/text";
import { BOOKMARK_MISSING, CHANGE_LOG, NAV_ALL, NAV_BOOKMARKS_LABEL, NAV_EVENTS, NAV_FORWARDS, NAV_LABEL, NAV_MY_PERMISSIONS, NAV_OVERVIEW, bookmarkRemove } from "./text";

const bm = (label: string, plural: string, missing = false): NavBookmark => ({ key: `apps/${plural}`, label, title: missing ? BOOKMARK_MISSING : plural, missing });
const BMS = [bm("Deployment", "deployments"), bm("StatefulSet", "statefulsets"), bm("DaemonSet", "daemonsets")];

function setup(props: Partial<Parameters<typeof K8sNav>[0]> = {}) {
  const p = { view: "workloads" as const, onSelect: vi.fn(), bookmarks: [], onMoveBookmark: vi.fn(), onRemoveBookmark: vi.fn(), ...props };
  render(<K8sNav {...p} />);
  return p;
}
const labels = () => Array.from(screen.getByRole("navigation", { name: NAV_LABEL }).querySelectorAll("button .iam-nav-label")).map((l) => l.textContent);

test("items in order, marks the current one, selects on click", () => {
  const p = setup();
  expect(labels()).toEqual([NAV_OVERVIEW, NAV_ALL, NAV_EVENTS, NAV_NETWORK, NAV_FORWARDS, NAV_MY_PERMISSIONS, CHANGE_LOG]);
  expect(screen.getByRole("button", { name: NAV_ALL })).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: NAV_EVENTS }));
  expect(p.onSelect).toHaveBeenCalledWith("events");
});

test("bookmarks sit above the overview in their saved order; clicking one opens it, the cross removes it", () => {
  const p = setup({ bookmarks: BMS, view: "bookmark:apps/statefulsets" });
  expect(screen.getByRole("group", { name: NAV_BOOKMARKS_LABEL })).toBeInTheDocument();
  expect(labels()).toEqual(["Deployment", "StatefulSet", "DaemonSet", NAV_OVERVIEW, NAV_ALL, NAV_EVENTS, NAV_NETWORK, NAV_FORWARDS, NAV_MY_PERMISSIONS, CHANGE_LOG]);
  expect(screen.getByRole("button", { name: "StatefulSet" })).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: "Deployment" }));
  expect(p.onSelect).toHaveBeenCalledWith("bookmark:apps/deployments");
  fireEvent.click(screen.getByRole("button", { name: bookmarkRemove("DaemonSet") }));
  expect(p.onRemoveBookmark).toHaveBeenCalledWith("apps/daemonsets");
  expect(p.onSelect).toHaveBeenCalledTimes(1);
});

test("a bookmark this cluster does not serve is disabled and says why", () => {
  setup({ bookmarks: [bm("Widget", "widgets", true)] });
  const b = screen.getByRole("button", { name: "Widget" });
  expect(b).toBeDisabled();
  expect(b).toHaveAttribute("title", BOOKMARK_MISSING);
});

describe("dragging a bookmark", () => {
  // 항목 높이 30px: 0-30, 30-60, 60-90
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const i = Array.from(this.parentElement?.children ?? []).indexOf(this);
      return { top: i * 30, height: 30, bottom: i * 30 + 30, left: 0, right: 100, width: 100, x: 0, y: i * 30, toJSON: () => ({}) } as DOMRect;
    });
  });
  afterEach(() => vi.restoreAllMocks());
  const item = (label: string) => screen.getByRole("button", { name: label }).parentElement as HTMLElement;

  test("moves it below the item it is dropped past, previews while dragging, and does not open it", () => {
    const p = setup({ bookmarks: BMS });
    fireEvent.mouseDown(item("Deployment"), { button: 0, clientY: 15 });
    fireEvent.mouseMove(window, { clientY: 80 });
    expect(labels().slice(0, 3)).toEqual(["StatefulSet", "DaemonSet", "Deployment"]);
    fireEvent.mouseUp(window, { clientY: 80 });
    fireEvent.click(screen.getByRole("button", { name: "Deployment" }));
    expect(p.onMoveBookmark).toHaveBeenCalledWith(0, 2);
    expect(p.onSelect).not.toHaveBeenCalled();
  });

  test("a press without movement is a click, and Escape cancels a drag", () => {
    const p = setup({ bookmarks: BMS });
    fireEvent.mouseDown(item("DaemonSet"), { button: 0, clientY: 75 });
    fireEvent.mouseUp(window, { clientY: 75 });
    fireEvent.click(screen.getByRole("button", { name: "DaemonSet" }));
    expect(p.onSelect).toHaveBeenCalledWith("bookmark:apps/daemonsets");
    fireEvent.mouseDown(item("DaemonSet"), { button: 0, clientY: 75 });
    fireEvent.mouseMove(window, { clientY: 5 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseUp(window, { clientY: 5 });
    expect(labels().slice(0, 3)).toEqual(["Deployment", "StatefulSet", "DaemonSet"]);
    expect(p.onMoveBookmark).not.toHaveBeenCalled();
  });
});
