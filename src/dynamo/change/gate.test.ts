import { describe, expect, it } from "vitest";
import { canApply } from "./gate";
import type { DynamoPreview } from "./types";
const preview: DynamoPreview = { title:"", calls:[], diff:null, impact:[], warnings:[], blocked:null, confirmName:"prod-table", inverse:null };
describe("change confirmation", () => {
  it("requires the exact table name", () => {
    expect(canApply(preview, "prod-table", false)).toBe(true);
    expect(canApply(preview, "prod-table ", false)).toBe(false);
    expect(canApply(preview, "PROD-TABLE", false)).toBe(false);
  });
  it("never allows blocked or pending changes", () => {
    expect(canApply({ ...preview, blocked:"reason" }, "prod-table", false)).toBe(false);
    expect(canApply(preview, "prod-table", true)).toBe(false);
    expect(canApply({ ...preview, confirmName:null }, "", false)).toBe(true);
  });
});
