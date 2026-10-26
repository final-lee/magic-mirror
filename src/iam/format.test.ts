import { formatAgo, formatDay } from "./format";

describe("formatDay", () => {
  test("formats an ISO time as a local date", () => {
    expect(formatDay("2026-10-20T12:00:00Z")).toBe("2026-10-20");
  });
  test("returns an empty string for null and the input for garbage", () => {
    expect(formatDay(null)).toBe("");
    expect(formatDay(undefined)).toBe("");
    expect(formatDay("not a date")).toBe("not a date");
  });
});

describe("formatAgo", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  test("buckets elapsed time into days, months and years", () => {
    expect(formatAgo("2026-10-26T01:00:00Z", now)).toBe("오늘");
    expect(formatAgo("2026-10-20T12:00:00Z", now)).toBe("6일 전");
    expect(formatAgo("2026-07-26T12:00:00Z", now)).toBe("3개월 전");
    expect(formatAgo("2024-10-26T12:00:00Z", now)).toBe("2년 전");
  });
  test("treats future times as just now and tolerates null and garbage", () => {
    expect(formatAgo("2026-10-27T12:00:00Z", now)).toBe("방금");
    expect(formatAgo(null, now)).toBe("");
    expect(formatAgo("nope", now)).toBe("");
  });
});
