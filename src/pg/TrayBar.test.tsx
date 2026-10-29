import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { addBobToWriters, defaultAuditRead, grantAuditRead, pgTarget, removeBobFromWriters, revokeAuditRead, sampleOverview } from "./fixtures";
import { draftItem, type PgDraftItem } from "./draft";
import { TrayBar } from "./TrayBar";
import type { PgChange } from "./types";
import { usePgDraft, type PgDraft } from "./usePgDraft";

const ov = sampleOverview();

const item = (change: PgChange): PgDraftItem => {
  const made = draftItem(change);
  if (!made) throw new Error("not a tray change");
  return made;
};

const READ_AUDIT = "권한 주기: app_read · audit 스키마의 모든 테이블 SELECT";
const BOB_IN = "그룹에 넣기: bob → app_write";

let draft!: PgDraft;
function Harness({ database = "orders", start }: { database?: string; start: ReturnType<typeof vi.fn> }) {
  draft = usePgDraft(pgTarget, ov);
  return <TrayBar draft={draft} database={database} start={start} />;
}

function setup(database?: string) {
  const start = vi.fn();
  const utils = render(<Harness database={database} start={start} />);
  return { start, ...utils };
}

const put = (...changes: PgChange[]) => act(() => draft.paint(changes.map(item)));
const summary = () => screen.queryByText(/^변경 \d+개 · /)?.textContent ?? null;

test("shows nothing while the tray is empty", () => {
  const { container } = setup();
  expect(container).toBeEmptyDOMElement();
  expect(summary()).toBeNull();
});

describe("the summary", () => {
  test("is 변경 1개 and the label for one item", () => {
    setup();
    put(grantAuditRead);
    expect(summary()).toBe(`변경 1개 · ${READ_AUDIT}`);
  });

  test("is the number, the first label and how many more for several, in the order they were put in", () => {
    setup();
    put(addBobToWriters, grantAuditRead, defaultAuditRead);
    expect(summary()).toBe(`변경 3개 · ${BOB_IN} 외 2개`);
  });

  test("follows the tray as items go and come", () => {
    setup();
    put(grantAuditRead, addBobToWriters);
    expect(summary()).toBe(`변경 2개 · ${READ_AUDIT} 외 1개`);
    act(() => draft.remove(draft.items[0].key));
    expect(summary()).toBe(`변경 1개 · ${BOB_IN}`);
  });
});

describe("the list of changes", () => {
  test("is folded at first, opens from the summary, and closes from it", () => {
    setup();
    put(grantAuditRead, addBobToWriters);
    const toggle = screen.getByRole("button", { name: /^변경 2개/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "담긴 변경" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("list", { name: "담긴 변경" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent?.replace("×", ""))).toEqual([READ_AUDIT, BOB_IN]);
    fireEvent.click(toggle);
    expect(screen.queryByRole("list", { name: "담긴 변경" })).not.toBeInTheDocument();
  });

  test("lets the user take one change out by its ×", () => {
    setup();
    put(grantAuditRead, addBobToWriters);
    fireEvent.click(screen.getByRole("button", { name: /^변경 2개/ }));
    fireEvent.click(screen.getByRole("button", { name: `${READ_AUDIT} 취소` }));
    expect(draft.items.map((d) => d.label)).toEqual([BOB_IN]);
    expect(summary()).toBe(`변경 1개 · ${BOB_IN}`);
  });

  test("comes back folded once the tray has been empty", () => {
    setup();
    put(grantAuditRead);
    fireEvent.click(screen.getByRole("button", { name: /^변경 1개/ }));
    act(() => draft.clear());
    put(addBobToWriters);
    expect(screen.getByRole("button", { name: /^변경 1개/ })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("모두 취소", () => {
  test("empties the tray, and the bar goes with it", () => {
    const { container } = setup();
    put(grantAuditRead, addBobToWriters);
    fireEvent.click(screen.getByRole("button", { name: "모두 취소" }));
    expect(draft.items).toEqual([]);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("미리보기", () => {
  test("opens the batch in the database of the tray, with the changes in the order they were put in", () => {
    const { start } = setup("analytics"); // the tab shows analytics, but the tray belongs to orders
    put(grantAuditRead, addBobToWriters);
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("orders", [grantAuditRead, addBobToWriters], { onApplied: draft.removeApplied });
  });

  test("uses the database of the tab when the tray has none: only cluster-wide changes", () => {
    const { start } = setup("analytics");
    put(addBobToWriters);
    expect(draft.database).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(start).toHaveBeenCalledWith("analytics", [addBobToWriters], { onApplied: draft.removeApplied });
  });

  test("takes the applied changes out of the tray when the batch is applied, and only those", () => {
    const { start } = setup();
    put(grantAuditRead, addBobToWriters, defaultAuditRead);
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    const { onApplied } = start.mock.calls[0][2];
    // the user added one more change while the preview was open; it was not part of the batch
    put({ ...defaultAuditRead, grantee: "app_write" });
    act(() => onApplied([grantAuditRead, addBobToWriters, defaultAuditRead]));
    expect(draft.items.map((d) => d.label)).toEqual(["기본 권한 주기: app_owner → app_write"]);
  });

  test("does not touch the tray by itself: nothing leaves it until the batch is applied", () => {
    setup();
    put(grantAuditRead);
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(draft.items).toHaveLength(1);
  });

  test("sends the changes as they were queued: a revoke goes as a revoke", () => {
    const { start } = setup();
    put(revokeAuditRead, removeBobFromWriters);
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(start.mock.calls[0][1]).toEqual([revokeAuditRead, removeBobFromWriters]);
  });
});

test("uses the markup and the classes of the tray of the assignment table", () => {
  const { container } = setup();
  put(grantAuditRead);
  fireEvent.click(screen.getByRole("button", { name: /^변경 1개/ }));
  const tray = container.firstElementChild as HTMLElement;
  expect(tray).toHaveClass("asg-tray");
  expect(tray.querySelector(".asg-tray-list")).toBeInTheDocument();
  expect(tray.querySelector(".asg-tray-bar")).toBeInTheDocument();
  expect(tray.querySelector(".asg-tray-toggle")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "미리보기" })).toHaveClass("btn", "small", "primary");
  expect(screen.getByRole("button", { name: "모두 취소" })).toHaveClass("btn", "small");
});
