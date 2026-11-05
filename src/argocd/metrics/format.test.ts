import { describe, expect, it } from "vitest";
import { duration, ratio, seconds } from "./format";

describe("duration", () => {
  it("picks the two most useful units and shows a dash when unknown", () => {
    expect(duration(null)).toBe("—");
    expect(duration(45_000)).toBe("45초");
    expect(duration(200_000)).toBe("3분 20초");
    expect(duration(7_500_000)).toBe("2시간 5분");
    expect(duration(2 * 3_600_000)).toBe("2시간");
    expect(duration(100 * 3_600_000)).toBe("4일 4시간");
  });
});

describe("ratio and seconds", () => {
  it("shows one decimal below 10 percent and milliseconds below a second", () => {
    expect(ratio(0.234)).toBe("23%");
    expect(ratio(0.034)).toBe("3.4%");
    expect(ratio(0)).toBe("0%");
    expect(ratio(null)).toBe("—");
    expect(seconds(0.25)).toBe("250ms");
    expect(seconds(2.5)).toBe("2.50초");
    expect(seconds(12.34)).toBe("12.3초");
  });
});
