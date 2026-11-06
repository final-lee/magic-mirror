import { describe, expect, it } from "vitest";
import { runPool } from "./queries";

describe("runPool", () => {
  it("never runs more than the limit at once and finishes every item", async () => {
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      seen.push(n);
      running--;
    }, () => false);
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("stops starting new items once told to stop", async () => {
    const seen: number[] = [];
    let stop = false;
    await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      seen.push(n);
      if (n === 2) stop = true;
      await new Promise((r) => setTimeout(r, 1));
    }, () => stop);
    expect(seen.length).toBeLessThan(6);
    expect(seen).toContain(2);
  });
});
