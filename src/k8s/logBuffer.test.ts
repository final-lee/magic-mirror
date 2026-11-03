import { EMPTY_BUFFER, appendLines, type LogEntry } from "./logBuffer";

const entry = (text: string): LogEntry => ({ source: "web-1/app", ts: null, text });
const n = (from: number, count: number) => Array.from({ length: count }, (_, i) => entry(`l${from + i}`));
const all = (b: { chunks: { lines: LogEntry[] }[] }) => b.chunks.flatMap((c) => c.lines);

test("fills the last chunk first and leaves full chunks untouched", () => {
  const a = appendLines(EMPTY_BUFFER, n(0, 3), 100, 4);
  const b = appendLines(a, n(3, 3), 100, 4);
  expect(b.chunks.map((c) => c.lines)).toEqual([n(0, 4), n(4, 2)]);
  const c = appendLines(b, n(6, 1), 100, 4);
  expect(c.chunks[0]).toBe(b.chunks[0]);
  expect(c.chunks.map((x) => x.id)).toEqual([0, 1]);
  expect(c.size).toBe(7);
  expect(c.received).toBe(7);
});

test("drops whole old chunks past the limit and always keeps at least the limit", () => {
  let b = EMPTY_BUFFER;
  for (let i = 0; i < 25; i += 5) b = appendLines(b, n(i, 5), 10, 4);
  expect(b.received).toBe(25);
  expect(b.trimmed).toBe(true);
  expect(b.size).toBeGreaterThanOrEqual(10);
  expect(b.size).toBeLessThan(14);
  expect(all(b)).toEqual(n(25 - b.size, b.size));
  // id는 지운 뒤에도 이어진다(React key가 겹치지 않는다)
  expect(b.chunks[0].id).toBeGreaterThan(0);
});

test("an empty batch returns the same buffer", () => {
  const a = appendLines(EMPTY_BUFFER, [entry("x")]);
  expect(appendLines(a, [])).toBe(a);
});
