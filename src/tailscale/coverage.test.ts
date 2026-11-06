import { describe, expect, it } from "vitest";
import { coverage } from "./coverage";

describe("VPC coverage", () => {
  it("finds full coverage from several adjacent routes", () => {
    expect(coverage("10.0.0.0/16", ["10.0.0.0/17", "10.0.128.0/17"])).toBe("전부");
  });
  it("excludes exit routes from VPC coverage", () => {
    expect(coverage("10.0.0.0/16", ["0.0.0.0/0", "::/0"])).toBe("없음");
    expect(coverage("10.0.0.0/16", ["0.0.0.0/0", "10.0.0.0/17"])).toBe("일부");
  });
  it("distinguishes partial, absent, invalid and IPv6 routes", () => {
    expect(coverage("10.0.0.0/16", ["10.0.0.0/18", "10.0.128.0/17"])).toBe("일부");
    expect(coverage("10.0.0.0/16", ["192.168.0.0/16", "::/0"])).toBe("없음");
    expect(coverage("bad", ["0.0.0.0/0"])).toBe("없음");
  });
});
