import { describe, expect, it } from "vitest";
import { segments } from "./Spark";

describe("segments", () => {
  it("breaks the line at missing values instead of connecting across them", () => {
    expect(segments([1, 2, null, 3, null, null, 4, 5])).toEqual([[[0, 1], [1, 2]], [[3, 3]], [[6, 4], [7, 5]]]);
    expect(segments([null, null])).toEqual([]);
  });
});
