import { fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { DatabaseScreen } from "./DatabaseScreen";
import { sampleOverview } from "./fixtures";
import type { PgOverview } from "./types";

const noDatabase = (): PgOverview => sampleOverview({ databases: [{ name: "legacy_archive", owner: "app_owner", allowConn: false }] });

/** 본문이 어느 데이터베이스로 불렸는지, 그리고 본문이 처음부터 다시 그려지는지(자기 상태가 사라지는지)를 보는 본문 */
function Body({ database, onMount }: { database: string; onMount: (database: string) => void }) {
  const [count, setCount] = useState(0);
  // 처음 그릴 때 한 번
  useEffect(() => onMount(database), []);
  return (
    <button onClick={() => setCount((c) => c + 1)}>
      {database} {count}
    </button>
  );
}

/** 고른 데이터베이스는 PgTab이 들고 있다. 여기서는 같은 일을 하는 작은 부모를 쓴다. */
function Harness({ overview = sampleOverview(), initial, onMount = () => {}, bar, onDatabase }: { overview?: PgOverview; initial?: string; onMount?: (database: string) => void; bar?: React.ReactNode; onDatabase?: (d: string) => void }) {
  const [database, setDatabase] = useState(initial);
  return (
    <DatabaseScreen
      overview={overview}
      database={database}
      onDatabase={(next) => {
        setDatabase(next);
        onDatabase?.(next);
      }}
      bar={bar}
    >
      {(db) => <Body database={db} onMount={onMount} />}
    </DatabaseScreen>
  );
}

const picker = () => screen.getByRole("combobox", { name: "데이터베이스" });

describe("the database", () => {
  test("is the default database of the target until one is chosen, and the body is for it", () => {
    render(<Harness />);
    expect(picker()).toHaveValue("orders");
    expect(screen.getByRole("button", { name: "orders 0" })).toBeInTheDocument();
  });

  test("is the one that was chosen, when it takes connections", () => {
    render(<Harness initial="analytics" />);
    expect(picker()).toHaveValue("analytics");
    expect(screen.getByRole("button", { name: "analytics 0" })).toBeInTheDocument();
  });

  test.each(["legacy_archive", "dropped"])("falls back to the default one when the choice (%s) no longer takes connections or is gone", (initial) => {
    render(<Harness initial={initial} />);
    expect(picker()).toHaveValue("orders");
    expect(screen.getByRole("button", { name: "orders 0" })).toBeInTheDocument();
  });

  test("is chosen from the databases that accept connections", () => {
    render(<Harness />);
    expect(within(picker()).getAllByRole("option").map((o) => o.textContent)).toEqual(["analytics", "orders", "postgres"]);
  });

  test("choosing another one tells which, and the body is drawn for it from the start", () => {
    const onMount = vi.fn();
    const onDatabase = vi.fn();
    render(<Harness onMount={onMount} onDatabase={onDatabase} />);
    fireEvent.click(screen.getByRole("button", { name: "orders 0" }));
    expect(screen.getByRole("button", { name: "orders 1" })).toBeInTheDocument(); // 본문의 상태
    fireEvent.change(picker(), { target: { value: "postgres" } });
    expect(onDatabase).toHaveBeenCalledWith("postgres");
    expect(screen.getByRole("button", { name: "postgres 0" })).toBeInTheDocument(); // 상태는 사라지고 새로 시작했다
    expect(onMount.mock.calls.map((c) => c[0])).toEqual(["orders", "postgres"]);
    fireEvent.change(picker(), { target: { value: "orders" } });
    expect(screen.getByRole("button", { name: "orders 0" })).toBeInTheDocument(); // 다시 돌아와도 처음부터다
  });

  test("a body that is drawn again for the same database keeps its own state", () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "orders 0" }));
    rerender(<Harness />);
    expect(screen.getByRole("button", { name: "orders 1" })).toBeInTheDocument();
  });
});

describe("the bar", () => {
  test("has the picker and what the screen puts beside it", () => {
    render(<Harness bar={<span>옆에 놓은 것</span>} />);
    expect(screen.getByText("옆에 놓은 것")).toBeInTheDocument();
    expect(picker().closest(".pg-bar")).toContainElement(screen.getByText("옆에 놓은 것"));
  });
});

describe("a cluster with no database to connect to", () => {
  test("says so instead of the picker and the body, and keeps what the screen put in the bar", () => {
    const onMount = vi.fn();
    render(<Harness overview={noDatabase()} onMount={onMount} bar={<span>옆에 놓은 것</span>} />);
    expect(screen.getByText("연결할 수 있는 데이터베이스가 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "데이터베이스" })).not.toBeInTheDocument();
    expect(screen.getByText("옆에 놓은 것")).toBeInTheDocument();
    expect(onMount).not.toHaveBeenCalled();
  });

  test("there is no body to draw when the cluster has no database at all", () => {
    const onMount = vi.fn();
    render(<Harness overview={sampleOverview({ databases: [] })} onMount={onMount} />);
    expect(screen.getByText("연결할 수 있는 데이터베이스가 없어요")).toBeInTheDocument();
    expect(onMount).not.toHaveBeenCalled();
  });
});
