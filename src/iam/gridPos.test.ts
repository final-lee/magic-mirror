import { cellsBetween, parsePos, posKey } from "./gridPos";

describe("cellsBetween", () => {
  test("a cell to itself has nothing in between", () => {
    expect(cellsBetween({ r: 2, c: 1 }, { r: 2, c: 1 })).toEqual([]);
  });

  test("along a row it lists every cell after the start up to the end, in order", () => {
    expect(cellsBetween({ r: 2, c: 1 }, { r: 2, c: 4 })).toEqual([
      { r: 2, c: 2 },
      { r: 2, c: 3 },
      { r: 2, c: 4 },
    ]);
    expect(cellsBetween({ r: 2, c: 4 }, { r: 2, c: 2 })).toEqual([
      { r: 2, c: 3 },
      { r: 2, c: 2 },
    ]);
  });

  test("down and up a column", () => {
    expect(cellsBetween({ r: 1, c: 3 }, { r: 4, c: 3 })).toEqual([
      { r: 2, c: 3 },
      { r: 3, c: 3 },
      { r: 4, c: 3 },
    ]);
    expect(cellsBetween({ r: 4, c: 3 }, { r: 2, c: 3 })).toEqual([
      { r: 3, c: 3 },
      { r: 2, c: 3 },
    ]);
  });

  test("a diagonal goes through the cells on the diagonal", () => {
    expect(cellsBetween({ r: 1, c: 0 }, { r: 3, c: 2 })).toEqual([
      { r: 2, c: 1 },
      { r: 3, c: 2 },
    ]);
  });

  test("a shallow line moves one cell at a time in its long direction and never skips one", () => {
    expect(cellsBetween({ r: 0, c: 0 }, { r: 1, c: 3 })).toEqual([
      { r: 0, c: 1 },
      { r: 1, c: 2 },
      { r: 1, c: 3 },
    ]);
  });

  test("whatever the two cells, the result steps to a neighbour each time and ends on the second cell", () => {
    for (let r1 = 0; r1 < 6; r1++)
      for (let c1 = 0; c1 < 6; c1++)
        for (let r2 = 0; r2 < 6; r2++)
          for (let c2 = 0; c2 < 6; c2++) {
            const cells = cellsBetween({ r: r1, c: c1 }, { r: r2, c: c2 });
            if (r1 === r2 && c1 === c2) {
              expect(cells).toEqual([]);
              continue;
            }
            expect(cells[cells.length - 1]).toEqual({ r: r2, c: c2 });
            let prev = { r: r1, c: c1 };
            for (const cell of cells) {
              expect(Math.abs(cell.r - prev.r)).toBeLessThanOrEqual(1);
              expect(Math.abs(cell.c - prev.c)).toBeLessThanOrEqual(1);
              expect(cell).not.toEqual(prev);
              prev = cell;
            }
          }
  });
});

describe("posKey and parsePos", () => {
  test("a position survives the round trip, header positions (-1) included", () => {
    for (const pos of [
      { r: 0, c: 0 },
      { r: 12, c: 3 },
      { r: -1, c: 2 },
      { r: 5, c: -1 },
    ]) {
      expect(parsePos(posKey(pos.r, pos.c))).toEqual(pos);
    }
  });
});
