import { age, formatBytes, formatCpu, percent } from "./format";

test("cpu", () => {
  expect(formatCpu(250)).toBe("250m");
  expect(formatCpu(2000)).toBe("2");
  expect(formatCpu(1500)).toBe("1.5");
  expect(formatCpu(0)).toBe("0");
});

test("bytes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KiB");
  expect(formatBytes(64 * 1024 * 1024)).toBe("64 MiB");
  expect(formatBytes(7.5 * 1024 ** 3)).toBe("7.5 GiB");
});

test("percent", () => {
  expect(percent(1, 4)).toBe("25%");
  expect(percent(1, 0)).toBe("–");
});

test("age", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  expect(age("2026-10-30T11:59:20Z", now)).toBe("40s");
  expect(age("2026-10-30T11:15:00Z", now)).toBe("45m");
  expect(age("2026-10-29T00:00:00Z", now)).toBe("36h");
  expect(age("2026-10-20T12:00:00Z", now)).toBe("10d");
  expect(age(null, now)).toBe("");
});
