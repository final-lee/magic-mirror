import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { posKey } from "../iam/gridPos";
import { takeFocus, usePaintDrag } from "./usePaintDrag";

// 칠하는 일이 행과 열의 종류를 모르는지 본다: 행은 이름이 있는 객체, 열은 키가 있는 객체다. 칸의 상태는 이 틀이 집합 하나로 든다.
interface Row {
  name: string;
}
interface Col {
  key: string;
}

const row = (name: string): Row => ({ name });
const col = (key: string): Col => ({ key });
const cellKey = (r: Row, c: Col) => `${r.name}/${c.key}`;

interface Props {
  rows: Row[];
  columns: Col[];
  /** 첫 열의 번호 */
  firstColumn?: number;
  /** 칠할 수 없는 칸 */
  locked?: string[];
  onPress?: (r: number, c: number, trigger: HTMLElement) => void;
  onStart?: () => void;
  /** 칠한 일을 받는다(칸과 목표) */
  onPaint?: (cells: string[], want: boolean) => void;
}

function Table({ rows, columns, firstColumn = 0, locked = [], onPress = () => {}, onStart = () => {}, onPaint = () => {} }: Props) {
  const [on, setOn] = useState<Set<string>>(new Set());
  const drag = usePaintDrag<Row, Col>({
    rows,
    columns,
    rowId: (r) => r.name,
    columnId: (c) => c.key,
    firstColumn,
    editable: (r, c) => !locked.includes(cellKey(r, c)),
    wanted: (r, c) => !on.has(cellKey(r, c)),
    paint: (cells, want) => {
      const names = cells.map((cell) => cellKey(cell.row, cell.column));
      onPaint(names, want);
      setOn((current) => {
        const next = new Set(current);
        for (const name of names) {
          if (want) next.add(name);
          else next.delete(name);
        }
        return next;
      });
    },
    press: onPress,
    onStart,
  });
  return (
    <div>
      {rows.flatMap((r, ri) =>
        columns.map((c, ci) => {
          const pos = ci + firstColumn;
          return (
            <button
              key={cellKey(r, c)}
              data-pos={posKey(ri, pos)}
              aria-label={`${cellKey(r, c)}: ${on.has(cellKey(r, c)) ? "on" : "off"}`}
              onPointerDown={(e) => drag.down(e, ri, pos)}
              onPointerEnter={(e) => drag.enter(e, ri, pos)}
              onClick={(e) => drag.click(e, ri, pos)}
              onKeyDown={drag.forget}
            />
          );
        }),
      )}
    </div>
  );
}

const cell = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}: `) });
const press = (el: HTMLElement, init: PointerEventInit = {}) => fireEvent.pointerDown(el, { button: 0, buttons: 1, ...init });
const enter = (el: HTMLElement) => fireEvent.pointerEnter(el, { buttons: 1 });
const state = (name: string) => cell(name).getAttribute("aria-label")?.split(": ")[1];
const states = (...names: string[]) => names.map(state);

const rows = ["a", "b", "c", "d"].map(row);
const columns = ["x", "y", "z"].map(col);

describe("a drag over cells of any kind", () => {
  test("paints the cell that was pressed at once, then every cell it passes, with what the first one became", () => {
    const onPaint = vi.fn();
    render(<Table rows={rows} columns={columns} onPaint={onPaint} />);
    press(cell("a/x"));
    expect(onPaint).toHaveBeenLastCalledWith(["a/x"], true);
    enter(cell("b/x"));
    enter(cell("c/x"));
    fireEvent.pointerUp(window);
    expect(states("a/x", "b/x", "c/x", "d/x")).toEqual(["on", "on", "on", "off"]);
  });

  test("a drag that starts on a cell that is on turns the cells it passes off", () => {
    render(<Table rows={rows} columns={columns} />);
    press(cell("a/x"));
    enter(cell("b/x"));
    enter(cell("c/x"));
    fireEvent.pointerUp(window);
    expect(states("a/x", "b/x", "c/x")).toEqual(["on", "on", "on"]);
    press(cell("a/x")); // a is on, so the target is off
    enter(cell("b/x"));
    fireEvent.pointerUp(window);
    expect(states("a/x", "b/x", "c/x")).toEqual(["off", "off", "on"]);
  });

  test("a fast drag that skips cells still paints the ones in between", () => {
    render(<Table rows={rows} columns={columns} />);
    press(cell("a/x"));
    enter(cell("d/x")); // b and c were never entered
    fireEvent.pointerUp(window);
    expect(states("a/x", "b/x", "c/x", "d/x")).toEqual(["on", "on", "on", "on"]);
  });

  test("starting a press tells the screen (to drop its range, for one)", () => {
    const onStart = vi.fn();
    render(<Table rows={rows} columns={columns} onStart={onStart} />);
    press(cell("a/x"));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("only the primary button without Ctrl starts a paint", () => {
    const onPaint = vi.fn();
    const onStart = vi.fn();
    render(<Table rows={rows} columns={columns} onPaint={onPaint} onStart={onStart} />);
    press(cell("a/x"), { button: 2, buttons: 2 });
    press(cell("a/x"), { ctrlKey: true });
    expect(onPaint).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("a column that is numbered from -1", () => {
  test("is part of the path: cells are told apart by their number, whatever the first number is", () => {
    const onPaint = vi.fn();
    render(<Table rows={rows} columns={columns} firstColumn={-1} onPaint={onPaint} />);
    // x is column -1, y is 0, z is 1. Along the row from z to x the middle cell is y
    press(cell("a/z"));
    enter(cell("a/x"));
    fireEvent.pointerUp(window);
    expect(states("a/z", "a/y", "a/x")).toEqual(["on", "on", "on"]);
    expect(onPaint).toHaveBeenLastCalledWith(["a/y", "a/x"], true);
  });

  test("a press on the first column paints that column's cell, not another one", () => {
    const onPaint = vi.fn();
    render(<Table rows={rows} columns={columns} firstColumn={-1} onPaint={onPaint} />);
    press(cell("b/x"));
    expect(onPaint).toHaveBeenCalledWith(["b/x"], true);
  });
});

describe("a cell that cannot be painted", () => {
  test("is not painted by a press, and the click that follows is handed to press", () => {
    const onPress = vi.fn();
    const onPaint = vi.fn();
    render(<Table rows={rows} columns={columns} locked={["b/y"]} onPress={onPress} onPaint={onPaint} />);
    press(cell("b/y"));
    expect(onPaint).not.toHaveBeenCalled();
    fireEvent.click(cell("b/y"));
    expect(onPress).toHaveBeenCalledWith(1, 1, cell("b/y"));
  });

  test("is skipped by a drag that passes over it", () => {
    render(<Table rows={rows} columns={columns} locked={["b/x"]} />);
    press(cell("a/x"));
    enter(cell("c/x"));
    fireEvent.pointerUp(window);
    expect(states("a/x", "b/x", "c/x")).toEqual(["on", "off", "on"]);
  });
});

describe("a click", () => {
  test("after a press that already painted its cell is not handed to press again", () => {
    const onPress = vi.fn();
    render(<Table rows={rows} columns={columns} onPress={onPress} />);
    press(cell("a/x"));
    fireEvent.pointerUp(cell("a/x"));
    fireEvent.click(cell("a/x"));
    expect(onPress).not.toHaveBeenCalled();
  });

  test("on its own (the keyboard) is handed to press", () => {
    const onPress = vi.fn();
    render(<Table rows={rows} columns={columns} onPress={onPress} />);
    fireEvent.click(cell("c/z"));
    expect(onPress).toHaveBeenCalledWith(2, 2, cell("c/z"));
  });

  test("a key pressed in the middle of a press forgets the press, so the click that follows is a click of its own", () => {
    const onPress = vi.fn();
    render(<Table rows={rows} columns={columns} onPress={onPress} />);
    press(cell("a/x"));
    fireEvent.keyDown(cell("a/x"), { key: "ArrowDown" });
    fireEvent.click(cell("a/x"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test("after a drag that ended on another cell the first cell still answers a later click", () => {
    const onPress = vi.fn();
    render(<Table rows={rows} columns={columns} onPress={onPress} />);
    press(cell("a/x"));
    enter(cell("b/x"));
    fireEvent.pointerUp(cell("b/x"));
    fireEvent.click(cell("a/x"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("when the table changes under the drag", () => {
  test("rows that moved make it forget where it was: only the cell it entered is painted", () => {
    const { rerender } = render(<Table rows={rows} columns={columns} />);
    press(cell("a/x"));
    // two new rows come first, so a is now the third row. Joining its old place (row 0) to d (now row 5) would pass through the new rows
    rerender(<Table rows={[row("n1"), row("n2"), ...rows]} columns={columns} />);
    enter(cell("d/x"));
    fireEvent.pointerUp(window);
    expect(states("n1/x", "n2/x", "b/x", "c/x")).toEqual(["off", "off", "off", "off"]);
    expect(states("a/x", "d/x")).toEqual(["on", "on"]);
  });

  test("new arrays with the same rows and columns change nothing", () => {
    const { rerender } = render(<Table rows={rows} columns={columns} />);
    press(cell("a/x"));
    rerender(<Table rows={rows.map((r) => ({ ...r }))} columns={columns.map((c) => ({ ...c }))} />);
    enter(cell("c/x")); // b/x was never entered
    fireEvent.pointerUp(window);
    expect(states("a/x", "b/x", "c/x")).toEqual(["on", "on", "on"]);
  });
});

describe("the end of a paint", () => {
  test.each([
    ["the pointer is let go anywhere", () => fireEvent.pointerUp(window)],
    ["the pointer is cancelled", () => fireEvent.pointerCancel(window)],
    ["the window loses focus", () => fireEvent.blur(window)],
  ])("when %s, cells entered after it are left alone", (_when, end) => {
    render(<Table rows={rows} columns={columns} />);
    press(cell("a/x"));
    end();
    enter(cell("b/x"));
    expect(state("b/x")).toBe("off");
  });
});

describe("takeFocus", () => {
  test("takes the focus for the element and keeps the browser from moving it, for the primary button only", () => {
    render(<button onPointerDown={takeFocus}>x</button>);
    const button = screen.getByRole("button");
    expect(fireEvent.pointerDown(button, { button: 0 })).toBe(false); // the default was prevented
    expect(button).toHaveFocus();
    button.blur();
    expect(fireEvent.pointerDown(button, { button: 2 })).toBe(true);
    expect(button).not.toHaveFocus();
  });
});
