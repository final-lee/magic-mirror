import { fireEvent, render, screen, within } from "@testing-library/react";
import { ResourceTable } from "./ResourceTable";
import { makeResource, sampleServices } from "../test/utils";

const columns = sampleServices[0].types[0].columns;
const items = [
  makeResource("i-2", { name: "web-2", id: "i-2", state: "stopped" }),
  makeResource("i-1", { name: "web-1", id: "i-1", state: "running" }),
  makeResource("i-3", { name: "batch", id: "i-3", state: "running" }),
];

function rowNames() {
  return screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);
}

test("sorts by first column ascending, toggles on header click", () => {
  render(<ResourceTable columns={columns} items={items} filter="" selectedId={null} onSelect={() => {}} onOpen={() => {}} />);
  expect(rowNames()).toEqual(["batch", "web-1", "web-2"]);
  fireEvent.click(screen.getByRole("columnheader", { name: /Name/ }));
  expect(rowNames()).toEqual(["web-2", "web-1", "batch"]);
  fireEvent.click(screen.getByRole("columnheader", { name: /State/ }));
  expect(rowNames()[0]).toMatch(/batch|web-1/);
});

test("filters by name or id, case-insensitive", () => {
  render(<ResourceTable columns={columns} items={items} filter="WEB" selectedId={null} onSelect={() => {}} onOpen={() => {}} />);
  expect(rowNames()).toEqual(["web-1", "web-2"]);
});

test("filters by id", () => {
  render(<ResourceTable columns={columns} items={items} filter="i-3" selectedId={null} onSelect={() => {}} onOpen={() => {}} />);
  expect(rowNames()).toEqual(["batch"]);
});

test("click selects, double click opens", () => {
  const onSelect = vi.fn();
  const onOpen = vi.fn();
  render(<ResourceTable columns={columns} items={items} filter="" selectedId={null} onSelect={onSelect} onOpen={onOpen} />);
  const row = screen.getByText("web-1").closest("tr")!;
  fireEvent.click(row);
  expect(onSelect).toHaveBeenCalledWith("i-1");
  fireEvent.doubleClick(row);
  expect(onOpen).toHaveBeenCalledWith("i-1");
});

test("arrow keys move selection in sorted order, Enter opens", () => {
  const onSelect = vi.fn();
  const onOpen = vi.fn();
  render(<ResourceTable columns={columns} items={items} filter="" selectedId="i-3" onSelect={onSelect} onOpen={onOpen} />);
  const table = screen.getByTestId("resource-table");
  fireEvent.keyDown(table, { key: "ArrowDown" });
  expect(onSelect).toHaveBeenLastCalledWith("i-1");
  fireEvent.keyDown(table, { key: "ArrowUp" });
  expect(onSelect).toHaveBeenLastCalledWith("i-3");
  fireEvent.keyDown(table, { key: "Enter" });
  expect(onOpen).toHaveBeenCalledWith("i-3");
});

test("selected row is marked", () => {
  render(<ResourceTable columns={columns} items={items} filter="" selectedId="i-2" onSelect={() => {}} onOpen={() => {}} />);
  expect(screen.getByText("web-2").closest("tr")).toHaveAttribute("aria-selected", "true");
});

test("shows empty message when nothing matches", () => {
  render(<ResourceTable columns={columns} items={items} filter="zzz" selectedId={null} onSelect={() => {}} onOpen={() => {}} />);
  expect(screen.getByText("표시할 리소스가 없어요")).toBeInTheDocument();
});
