import { describe, expect, it } from "vitest";
import { appendRecords } from "./records";
import type { StreamRecord } from "./types";

const record = (id: number): StreamRecord => ({ id: String(id), event: "INSERT", time: null, keys: null, size: null, oldImage: null, newImage: null });
describe("stream record buffer", () => {
  it("keeps the newest 2000 records in arrival order", () => {
    const prior = Array.from({ length: 1999 }, (_, i) => record(i));
    const result = appendRecords(prior, [record(1999), record(2000)]);
    expect(result).toHaveLength(2000);
    expect(result[0].id).toBe("1");
    expect(result[1999].id).toBe("2000");
    expect(prior).toHaveLength(1999);
  });
});
