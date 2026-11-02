import { inlineValue, isErrorField, lineTone, parseJsonLog } from "./jsonLog";

const MS = /\.776$/;

test("ECS-style dotted keys: level, time and message come out, the rest stay in order", () => {
  const log = parseJsonLog('{"log.level":"warn","timestamp":"2026-11-02T06:40:58.776Z","service":"azit","message":"slow","duration":12}')!;
  expect(log).toMatchObject({ level: "warn", tone: "warn", message: "slow", timeRaw: "2026-11-02T06:40:58.776Z" });
  expect(log.time).toMatch(/^\d\d-\d\d \d\d:\d\d:\d\d\.776$/);
  expect(log.fields).toEqual([["service", "azit"], ["duration", 12]]);
});

test("pino numeric levels and epoch milliseconds, zap epoch seconds with a fraction", () => {
  const pino = parseJsonLog('{"level":50,"time":1793601658776,"msg":"boom","pid":1}')!;
  expect(pino).toMatchObject({ level: "error", tone: "error", message: "boom", fields: [["pid", 1]] });
  expect(pino.time).toMatch(MS);
  const zap = parseJsonLog('{"level":"info","ts":1793601658.776,"msg":"up"}')!;
  expect(zap).toMatchObject({ tone: "info", message: "up" });
  expect(zap.time).toMatch(MS);
});

test("values that are not times stay as written; unknown levels have no tone; a non-string message is a field", () => {
  const log = parseJsonLog('{"time":"later","level":"audit","message":{"a":1}}')!;
  expect(log).toMatchObject({ time: "later", level: "audit", tone: null, message: null, fields: [["message", { a: 1 }]] });
});

test("only JSON objects are read as JSON logs", () => {
  expect(parseJsonLog("plain text")).toBeNull();
  expect(parseJsonLog("[1,2]")).toBeNull();
  expect(parseJsonLog("{broken")).toBeNull();
  expect(parseJsonLog('{"a":1} trailing')).toBeNull();
  expect(parseJsonLog('  {"a":1}  ')).toMatchObject({ time: null, level: null, message: null, fields: [["a", 1]] });
});

test("error fields are the ones named after errors, not words that merely contain it", () => {
  expect(["error", "error.message", "err", "exception", "stack_trace", "error_code"].every(isErrorField)).toBe(true);
  expect(["errors", "terror", "message", "stage"].some(isErrorField)).toBe(false);
});

test("inline values: bare when safe, JSON otherwise", () => {
  expect(inlineValue("r-1")).toBe("r-1");
  expect(inlineValue("no such azit")).toBe('"no such azit"');
  expect(inlineValue("")).toBe('""');
  expect(inlineValue("a=b")).toBe('"a=b"');
  expect(inlineValue(404)).toBe("404");
  expect(inlineValue({ a: [1] })).toBe('{"a":[1]}');
  expect(inlineValue(null)).toBe("null");
});

test("line levels: JSON level field, a leading level word, or logfmt level=; words in the middle do not count", () => {
  expect(lineTone('{"severity":"ERROR","message":"x"}')).toBe("error");
  expect(lineTone("[WARNING] plugin/health: slow")).toBe("warn");
  expect(lineTone("INFO: started")).toBe("info");
  expect(lineTone('time=1 level=debug msg="x"')).toBe("debug");
  expect(lineTone("no error found")).toBeNull();
  expect(lineTone("GET /a 200")).toBeNull();
  expect(lineTone('{"msg":"no level"}')).toBeNull();
});
