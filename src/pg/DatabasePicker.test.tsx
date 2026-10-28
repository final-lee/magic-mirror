import { fireEvent, render, screen, within } from "@testing-library/react";
import { DatabasePicker, pickDatabase } from "./DatabasePicker";
import { sampleOverview } from "./fixtures";
import type { PgDatabaseInfo } from "./types";

// analytics, legacy_archive (연결 불가), orders, postgres
const databases = sampleOverview().databases;
const db = (name: string, allowConn = true): PgDatabaseInfo => ({ name, owner: "postgres", allowConn });

function setup(value = "orders", list = databases) {
  const onChange = vi.fn();
  const view = render(<DatabasePicker databases={list} value={value} onChange={onChange} />);
  return { onChange, ...view };
}
const picker = () => screen.getByRole("combobox", { name: "데이터베이스" }) as HTMLSelectElement;

describe("DatabasePicker", () => {
  test("is a list named 데이터베이스 that shows the database it is given", () => {
    const { rerender, onChange } = setup("orders");
    expect(picker()).toHaveValue("orders");
    rerender(<DatabasePicker databases={databases} value="postgres" onChange={onChange} />);
    expect(picker()).toHaveValue("postgres");
  });

  test("lists only the databases that accept connections, in the order they come", () => {
    setup();
    expect(within(picker()).getAllByRole("option").map((o) => o.textContent)).toEqual(["analytics", "orders", "postgres"]);
    expect(screen.queryByRole("option", { name: "legacy_archive" })).not.toBeInTheDocument();
  });

  test("choosing a database tells which one", () => {
    const { onChange } = setup("orders");
    fireEvent.change(picker(), { target: { value: "analytics" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("analytics");
  });

  test("lists nothing it cannot connect to even when that is all there is", () => {
    setup("", [db("a", false), db("b", false)]);
    expect(within(picker()).queryAllByRole("option")).toHaveLength(0);
  });
});

describe("pickDatabase", () => {
  test("a remembered database that accepts connections wins", () => {
    expect(pickDatabase(databases, "analytics", "orders")).toBe("analytics");
  });

  test("without a remembered choice it is the default database of the target", () => {
    expect(pickDatabase(databases, undefined, "orders")).toBe("orders");
    expect(pickDatabase(databases, undefined, "postgres")).toBe("postgres");
  });

  test("a remembered database that no longer takes connections, or is gone, falls back to the default", () => {
    expect(pickDatabase(databases, "legacy_archive", "orders")).toBe("orders");
    expect(pickDatabase(databases, "dropped", "orders")).toBe("orders");
  });

  test("a default that takes no connections falls back to the first one that does", () => {
    expect(pickDatabase(databases, undefined, "legacy_archive")).toBe("analytics");
    expect(pickDatabase([db("x", false), db("y"), db("z")], undefined, "x")).toBe("y");
  });

  test("no database that takes connections means no choice", () => {
    expect(pickDatabase([db("x", false)], undefined, "x")).toBeNull();
    expect(pickDatabase([], "orders", "orders")).toBeNull();
  });
});
