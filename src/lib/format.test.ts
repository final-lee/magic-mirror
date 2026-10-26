import { compareValues, formatBytes, formatDate, formatValue, stateColor } from "./format";

test("formatBytes", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(1048576)).toBe("1.0 MB");
});

test("formatDate uses local time and falls back on invalid input", () => {
  const iso = new Date(2026, 9, 26, 14, 5).toISOString();
  expect(formatDate(iso)).toBe("2026-10-26 14:05");
  expect(formatDate("not a date")).toBe("not a date");
});

test("formatValue by kind", () => {
  expect(formatValue("bytes", "2048")).toBe("2.0 KB");
  expect(formatValue("bytes", "abc")).toBe("abc");
  expect(formatValue("text", "x")).toBe("x");
  expect(formatValue("datetime", "")).toBe("");
  expect(formatValue("text", undefined)).toBe("");
});

test("stateColor", () => {
  expect(stateColor("running")).toBe("green");
  expect(stateColor("ACTIVE")).toBe("green");
  expect(stateColor("stopped")).toBe("red");
  expect(stateColor("pending")).toBe("yellow");
  expect(stateColor("weird")).toBe("gray");
});

test("compareValues sorts numbers numerically and text by locale", () => {
  expect(["10", "9", "100"].sort(compareValues)).toEqual(["9", "10", "100"]);
  expect(["b", "a", "C"].sort(compareValues)).toEqual(["a", "b", "C"]);
  expect(["", "1"].sort(compareValues)).toEqual(["", "1"]);
});
