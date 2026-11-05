import { bucketLabel, defaultJobState, formatMs, orderQueues, parseJobKey, parseQueueKey, progressPercent, queueHealth, rebin } from "./bull";
import { sampleBullQueue } from "./fixtures";

const tail = (completed: number, failed: number) => ({ completed: [...Array(45).fill(0), ...Array(15).fill(completed)], failed: [...Array(45).fill(0), ...Array(15).fill(failed)] });

describe("queueHealth", () => {
  test("a busy healthy queue has no attention", () => {
    expect(queueHealth(sampleBullQueue({ recent: tail(10, 0) })).attention).toBeNull();
  });

  test("waiting jobs with no workers is a problem (danger)", () => {
    const h = queueHealth(sampleBullQueue({ workers: 0 }));
    expect(h.stalled).toBe(true);
    expect(h.attention).toBe("danger");
  });

  test("an unknown worker count is not taken for none", () => {
    expect(queueHealth(sampleBullQueue({ workers: null, recent: tail(10, 0) })).stalled).toBe(false);
  });

  test("a paused queue is not stalled but is noted when it holds work", () => {
    const h = queueHealth(sampleBullQueue({ paused: true, workers: 0 }));
    expect(h.stalled).toBe(false);
    expect(h.attention).toBe("warn");
  });

  test("a handful of failures among thousands is noise, a few percent is a warning, a quarter or more is danger", () => {
    expect(queueHealth(sampleBullQueue({ recent: tail(1000, 2) })).attention).toBeNull();
    expect(queueHealth(sampleBullQueue({ recent: tail(100, 5) }))).toMatchObject({ attention: "warn", failing: true });
    expect(queueHealth(sampleBullQueue({ recent: tail(1, 5) })).attention).toBe("danger");
  });

  test("a single failure on a queue that finished nothing is only a warning (too few to call it danger)", () => {
    const recent = { completed: Array(60).fill(0), failed: [...Array(59).fill(0), 1] };
    expect(queueHealth(sampleBullQueue({ recent })).attention).toBe("warn");
  });

  test("only the last 15 minutes count as recent", () => {
    const old = { completed: [...Array(10).fill(0), ...Array(50).fill(5)], failed: [...Array(10).fill(50), ...Array(50).fill(0)] };
    expect(queueHealth(sampleBullQueue({ recent: old })).failedRecent).toBe(0);
  });

  test("a deep backlog is a warning", () => {
    expect(queueHealth(sampleBullQueue({ counts: { ...sampleBullQueue().counts, wait: 1500 }, recent: tail(10, 0) })).attention).toBe("warn");
  });
});

test("problem queues come first: danger, then warning, then by recent failures, backlog and name", () => {
  const ok = (name: string) => sampleBullQueue({ name, recent: tail(10, 0) });
  const order = orderQueues([ok("b-ok"), sampleBullQueue({ name: "stalled", workers: 0 }), ok("a-ok"), sampleBullQueue({ name: "flaky", recent: tail(100, 5) })]).map((o) => o.queue.name);
  expect(order).toEqual(["stalled", "flaky", "a-ok", "b-ok"]);
});

test("job keys split into queue and id, even when the queue name has colons", () => {
  expect(parseJobKey("bull", "bull:emails:184")).toEqual({ queue: "emails", id: "184" });
  expect(parseJobKey("{bull}", "{bull}:team:emails:184")).toEqual({ queue: "team:emails", id: "184" });
  expect(parseJobKey("bull", "other:emails:1")).toBeNull();
  expect(parseJobKey("bull", "bull:emails:")).toBeNull();
  expect(parseQueueKey("bull", "bull:emails")).toBe("emails");
  expect(parseQueueKey("bull", "other:emails")).toBeNull();
});

test("minute buckets rebin into coarser ones, keeping the remainder", () => {
  expect(rebin([1, 2, 3, 4, 5], 2)).toEqual([3, 7, 5]);
  expect(rebin([1, 2], 1)).toEqual([1, 2]);
});

test("the job table opens on failed when there are failures, else the first state with jobs", () => {
  const counts = sampleBullQueue().counts;
  expect(defaultJobState(counts)).toBe("failed");
  expect(defaultJobState({ ...counts, failed: 0 })).toBe("wait");
  expect(defaultJobState({ ...counts, failed: 0, wait: 0, active: 0, delayed: 0 })).toBe("completed");
  expect(defaultJobState({ ...counts, failed: 0, wait: 0, active: 0, delayed: 0, completed: 0 })).toBe("wait");
});

test("durations and histogram labels", () => {
  expect(formatMs(230)).toBe("230ms");
  expect(formatMs(4200)).toBe("4.2초");
  expect(formatMs(45_000)).toBe("45초");
  expect(formatMs(190_000)).toBe("3분");
  expect(bucketLabel(1000)).toBe("≤ 1.0초");
  expect(bucketLabel(Number.MAX_SAFE_INTEGER * 4)).toBe("그 이상");
});

test("progress is a percentage only when it is a number from 0 to 100", () => {
  expect(progressPercent("42")).toBe(42);
  expect(progressPercent("42.5")).toBe(42.5);
  expect(progressPercent('{"step":3}')).toBeNull();
  expect(progressPercent("150")).toBeNull();
  expect(progressPercent(null)).toBeNull();
  expect(progressPercent("")).toBeNull();
});
