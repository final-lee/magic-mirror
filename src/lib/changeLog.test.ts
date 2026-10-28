import { act, renderHook } from "@testing-library/react";
import { arrange, batchKey, usePrepare, type LogLine } from "./changeLog";

// 변경 기록 화면(IAM, PostgreSQL)이 함께 쓰는 조각. 화면마다의 시험은 이 조각을 쓰는 모습을 본다.

interface Entry {
  id: string;
  batchId?: string;
}
const entry = (id: string, batchId?: string): Entry => ({ id, ...(batchId ? { batchId } : {}) });

/** 줄을 읽기 쉬운 글로: 묶음 머리는 "[묶음]", 묶음 안의 기록은 "  id", 홀로 있는 기록은 "id" */
const read = (lines: LogLine<Entry>[]) =>
  lines.map((l) => (l.kind === "batch" ? `[${l.batchId}] ${l.entries.map((e) => e.id).join(",")}` : `${l.inBatch ? "  " : ""}${l.entry.id}`));

describe("arrange", () => {
  test("entries without a batch stay as they came, one line each", () => {
    expect(read(arrange([entry("a"), entry("b"), entry("c")]))).toEqual(["a", "b", "c"]);
  });

  test("no entries, no lines", () => {
    expect(arrange([])).toEqual([]);
  });

  test("a batch gets a header, and its entries follow it", () => {
    expect(read(arrange([entry("a", "b1"), entry("b", "b1")]))).toEqual(["[b1] a,b", "  a", "  b"]);
  });

  test("the header sits where the batch's newest entry is, and the entries around it keep their order", () => {
    expect(read(arrange([entry("x"), entry("a", "b1"), entry("b", "b1"), entry("y")]))).toEqual(["x", "[b1] a,b", "  a", "  b", "y"]);
  });

  test("brings a batch together even when other entries came in between", () => {
    expect(read(arrange([entry("a", "b1"), entry("x"), entry("b", "b1"), entry("y"), entry("c", "b1")]))).toEqual(["[b1] a,b,c", "  a", "  b", "  c", "x", "y"]);
  });

  test("two batches get a header each, in the order of their newest entries", () => {
    expect(read(arrange([entry("a", "b1"), entry("c", "b2"), entry("b", "b1"), entry("d", "b2")]))).toEqual(["[b1] a,b", "  a", "  b", "[b2] c,d", "  c", "  d"]);
  });

  test("a batch with one entry still has its header", () => {
    expect(read(arrange([entry("a", "b1")]))).toEqual(["[b1] a", "  a"]);
  });

  test("an empty batch id is no batch", () => {
    expect(read(arrange([{ id: "a", batchId: "" }, entry("b")]))).toEqual(["a", "b"]);
  });

  test("keeps the entries it was given and does not change the array", () => {
    const given = [entry("a", "b1"), entry("x"), entry("b", "b1")];
    const copy = structuredClone(given);
    const lines = arrange(given);
    expect(given).toEqual(copy);
    const header = lines[0];
    expect(header.kind === "batch" && header.entries[0]).toBe(given[0]);
  });
});

test("a batch's busy and error key cannot be an entry id", () => {
  expect(batchKey("b1")).toBe("batch:b1");
  expect(batchKey("b1")).not.toBe(batchKey("b2"));
});

describe("usePrepare", () => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  test("starts idle", () => {
    const h = renderHook(() => usePrepare());
    expect(h.result.current.busy).toBeNull();
    expect(h.result.current.errors).toEqual({});
  });

  test("the key is busy while its task runs, and not afterwards", async () => {
    const h = renderHook(() => usePrepare());
    const gate = deferred();
    let run!: Promise<void>;
    act(() => {
      run = h.result.current.prepare("log-1", () => gate.promise);
    });
    expect(h.result.current.busy).toBe("log-1");
    await act(async () => {
      gate.resolve();
      await run;
    });
    expect(h.result.current.busy).toBeNull();
    expect(h.result.current.errors).toEqual({});
  });

  test("a task that fails leaves its error, as it was thrown, under its key and frees the slot", async () => {
    const h = renderHook(() => usePrepare());
    const thrown = { kind: "other", message: "되돌릴 수 없는 변경이에요" };
    await act(async () => h.result.current.prepare("log-1", () => Promise.reject(thrown)));
    expect(h.result.current.busy).toBeNull();
    expect(h.result.current.errors).toEqual({ "log-1": thrown });
    const task = vi.fn().mockResolvedValue(undefined);
    await act(async () => h.result.current.prepare("log-2", task));
    expect(task).toHaveBeenCalledTimes(1);
    expect(h.result.current.errors).toEqual({ "log-1": thrown }); // 다른 키의 오류는 그대로다
  });

  test("running a key again clears its old error before the task starts", async () => {
    const h = renderHook(() => usePrepare());
    await act(async () => h.result.current.prepare("log-1", () => Promise.reject(new Error("x"))));
    expect("log-1" in h.result.current.errors).toBe(true);
    const gate = deferred();
    let run!: Promise<void>;
    act(() => {
      run = h.result.current.prepare("log-1", () => gate.promise);
    });
    expect("log-1" in h.result.current.errors).toBe(false);
    await act(async () => {
      gate.resolve();
      await run;
    });
    expect(h.result.current.errors).toEqual({});
  });

  test("only one task runs at a time: another key asked for meanwhile does nothing", async () => {
    const h = renderHook(() => usePrepare());
    const gate = deferred();
    const other = vi.fn().mockResolvedValue(undefined);
    let run!: Promise<void>;
    act(() => {
      run = h.result.current.prepare("log-1", () => gate.promise);
    });
    await act(async () => h.result.current.prepare("log-2", other));
    expect(other).not.toHaveBeenCalled();
    expect(h.result.current.busy).toBe("log-1");
    await act(async () => {
      gate.resolve();
      await run;
    });
  });

  test("a double press of the same key runs the task once", async () => {
    const h = renderHook(() => usePrepare());
    const gate = deferred();
    const task = vi.fn(() => gate.promise);
    let run!: Promise<void>;
    act(() => {
      run = h.result.current.prepare("log-1", task);
      void h.result.current.prepare("log-1", task);
    });
    expect(task).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve();
      await run;
    });
  });
});
