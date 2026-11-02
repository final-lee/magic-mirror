import { bucketTick, bucketTitle, dataAge, formatDelta, formatMoney, formatPct, rangeLabel } from "./format";

describe("formatMoney", () => {
  test("USD amounts round to cents with grouping, negatives keep the sign", () => {
    expect(formatMoney("1234.5678", "USD")).toBe("$1,234.57");
    expect(formatMoney("-0.5", "USD")).toBe("-$0.50");
    expect(formatMoney("0", "USD")).toBe("$0.00");
  });

  test("a unit that is not a currency code is written after the number", () => {
    expect(formatMoney("12.3", "Credits")).toBe("12.30 Credits");
  });

  test("an unparsable amount shows as zero instead of NaN", () => {
    expect(formatMoney("abc", "USD")).toBe("$0.00");
  });
});

test("deltas and percentages carry an explicit sign except at zero; a missing percentage is a dash", () => {
  expect(formatDelta("10.5", "USD")).toBe("+$10.50");
  expect(formatDelta("-4", "USD")).toBe("-$4.00");
  expect(formatDelta("0", "USD")).toBe("$0.00");
  expect(formatPct(21)).toBe("+21.0%");
  expect(formatPct(-3.25)).toBe("-3.3%");
  expect(formatPct(null)).toBe("—");
});

test("data age switches from minutes to hours at one hour", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  expect(dataAge("2026-11-02T11:59:30Z", now)).toBe("방금 받은 데이터");
  expect(dataAge("2026-11-02T11:01:00Z", now)).toBe("59분 전 데이터");
  expect(dataAge("2026-11-02T11:00:00Z", now)).toBe("1시간 전 데이터");
  expect(dataAge("2026-11-02T05:30:00Z", now)).toBe("6시간 전 데이터");
});

describe("rangeLabel", () => {
  test("the exclusive end becomes the last day shown", () => {
    expect(rangeLabel({ start: "2026-10-01", end: "2026-10-30" })).toBe("10월 1일 ~ 10월 29일");
    expect(rangeLabel({ start: "2026-03-01", end: "2026-04-01" })).toBe("3월 1일 ~ 3월 31일");
  });

  test("a one-day range is one date, and a range across years names both years", () => {
    expect(rangeLabel({ start: "2026-10-01", end: "2026-10-02" })).toBe("10월 1일");
    expect(rangeLabel({ start: "2025-12-03", end: "2026-01-02" })).toBe("2025년 12월 3일 ~ 2026년 1월 1일");
  });
});

test("chart ticks and titles follow the granularity", () => {
  expect(bucketTick("2026-10-09", "daily")).toBe("9");
  expect(bucketTick("2026-05-01", "monthly")).toBe("5월");
  expect(bucketTitle("2026-10-09", "daily")).toBe("10월 9일");
  expect(bucketTitle("2026-05-01", "monthly")).toBe("2026년 5월");
});
