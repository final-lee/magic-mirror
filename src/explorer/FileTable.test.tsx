import { fireEvent, render, screen } from "@testing-library/react";
import { FileTable } from "./FileTable";
import { S3_COLUMNS } from "../lib/s3";
import { makeResource } from "../test/utils";
import type { SelectionState } from "./selection";

const rows = [
  makeResource("/p/b.txt", { name: "📄 b.txt", kind: "File", size: "2" }, { name: "b.txt" }),
  makeResource("/p/a.txt", { name: "📄 a.txt", kind: "File", size: "1" }, { name: "a.txt" }),
  makeResource("/p/c.txt", { name: "📄 c.txt", kind: "File", size: "3" }, { name: "c.txt" }),
];

function setup(selection: SelectionState = { selected: [], anchor: null }, extra = {}) {
  const props = {
    columns: S3_COLUMNS,
    rows,
    filter: "",
    selection,
    onSelectionChange: vi.fn(),
    onOpen: vi.fn(),
    onBack: vi.fn(),
    onDragStart: vi.fn(),
    ...extra,
  };
  render(<FileTable {...props} />);
  return props;
}

const row = (name: string) => screen.getByText(name).closest("tr")!;

test("click, meta-click and shift-click use display (sorted) order", () => {
  const p = setup({ selected: ["/p/a.txt"], anchor: "/p/a.txt" });
  fireEvent.click(row("📄 c.txt"), { shiftKey: true });
  expect(p.onSelectionChange).toHaveBeenLastCalledWith({ selected: ["/p/a.txt", "/p/b.txt", "/p/c.txt"], anchor: "/p/a.txt" });
  fireEvent.click(row("📄 b.txt"), { metaKey: true });
  expect(p.onSelectionChange).toHaveBeenLastCalledWith({ selected: ["/p/a.txt", "/p/b.txt"], anchor: "/p/b.txt" });
  fireEvent.click(row("📄 b.txt"));
  expect(p.onSelectionChange).toHaveBeenLastCalledWith({ selected: ["/p/b.txt"], anchor: "/p/b.txt" });
});

test("selected rows are marked, double click opens", () => {
  const p = setup({ selected: ["/p/a.txt", "/p/c.txt"], anchor: "/p/c.txt" });
  expect(row("📄 a.txt")).toHaveAttribute("aria-selected", "true");
  expect(row("📄 b.txt")).toHaveAttribute("aria-selected", "false");
  fireEvent.doubleClick(row("📄 b.txt"));
  expect(p.onOpen).toHaveBeenCalledWith("/p/b.txt");
});

test("keyboard: arrows move, Enter opens single selection, Backspace goes back", () => {
  const p = setup({ selected: ["/p/a.txt"], anchor: "/p/a.txt" });
  const table = screen.getByTestId("file-table");
  fireEvent.keyDown(table, { key: "ArrowDown" });
  expect(p.onSelectionChange).toHaveBeenLastCalledWith({ selected: ["/p/b.txt"], anchor: "/p/b.txt" });
  fireEvent.keyDown(table, { key: "Enter" });
  expect(p.onOpen).toHaveBeenCalledWith("/p/a.txt");
  fireEvent.keyDown(table, { key: "Backspace" });
  expect(p.onBack).toHaveBeenCalled();
});

test("dragging a selected row drags the whole selection after a small threshold", () => {
  const p = setup({ selected: ["/p/a.txt", "/p/b.txt"], anchor: "/p/b.txt" });
  fireEvent.pointerDown(row("📄 a.txt"), { clientX: 10, clientY: 10, button: 0 });
  fireEvent.pointerMove(row("📄 a.txt"), { clientX: 12, clientY: 11, buttons: 1 });
  expect(p.onDragStart).not.toHaveBeenCalled();
  fireEvent.pointerMove(row("📄 a.txt"), { clientX: 30, clientY: 10, buttons: 1 });
  expect(p.onDragStart).toHaveBeenCalledWith(["/p/a.txt", "/p/b.txt"], { clientX: 30, clientY: 10 });
});

test("dragging an unselected row drags only that row; filter hides rows", () => {
  const p = setup({ selected: ["/p/a.txt"], anchor: "/p/a.txt" });
  fireEvent.pointerDown(row("📄 c.txt"), { clientX: 0, clientY: 0, button: 0 });
  fireEvent.pointerMove(row("📄 c.txt"), { clientX: 20, clientY: 0, buttons: 1 });
  expect(p.onDragStart).toHaveBeenCalledWith(["/p/c.txt"], { clientX: 20, clientY: 0 });
});

test("empty text", () => {
  render(
    <FileTable columns={S3_COLUMNS} rows={[]} filter="" selection={{ selected: [], anchor: null }} onSelectionChange={() => {}} onOpen={() => {}} emptyText="비어 있어요" />,
  );
  expect(screen.getByText("비어 있어요")).toBeInTheDocument();
});

test("click following a drag does not change the selection", () => {
  const p = setup({ selected: ["/p/a.txt", "/p/b.txt"], anchor: "/p/b.txt" });
  fireEvent.pointerDown(row("📄 a.txt"), { clientX: 10, clientY: 10, button: 0 });
  fireEvent.pointerMove(row("📄 a.txt"), { clientX: 30, clientY: 10, buttons: 1 });
  fireEvent.pointerUp(row("📄 a.txt"));
  fireEvent.click(row("📄 a.txt"));
  expect(p.onSelectionChange).not.toHaveBeenCalled();
});

describe("deselect", () => {
  afterEach(() => vi.useRealTimers());

  test("clicking empty space clears the selection, but not rows or header", () => {
    const p = setup({ selected: ["/p/a.txt"], anchor: "/p/a.txt" });
    fireEvent.click(screen.getByText(/크기|Size|이름/, { selector: "th" }));
    expect(p.onSelectionChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("file-table"));
    expect(p.onSelectionChange).toHaveBeenCalledWith({ selected: [], anchor: null });
  });

  test("re-clicking the only selected row deselects after the delay", () => {
    vi.useFakeTimers();
    const p = setup({ selected: ["/p/a.txt"], anchor: "/p/a.txt" });
    fireEvent.click(row("📄 a.txt"), { detail: 1 });
    expect(p.onSelectionChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(p.onSelectionChange).toHaveBeenCalledWith({ selected: [], anchor: null });
  });

  test("double click after re-click opens without deselecting", () => {
    vi.useFakeTimers();
    const p = setup({ selected: ["/p/a.txt"], anchor: "/p/a.txt" });
    fireEvent.click(row("📄 a.txt"), { detail: 1 });
    fireEvent.doubleClick(row("📄 a.txt"));
    vi.advanceTimersByTime(500);
    expect(p.onOpen).toHaveBeenCalledWith("/p/a.txt");
    expect(p.onSelectionChange).not.toHaveBeenCalled();
  });

  test("meta-click on the selected row still toggles immediately", () => {
    const p = setup({ selected: ["/p/a.txt"], anchor: "/p/a.txt" });
    fireEvent.click(row("📄 a.txt"), { metaKey: true, detail: 1 });
    expect(p.onSelectionChange).toHaveBeenCalledWith({ selected: [], anchor: "/p/a.txt" });
  });
});
