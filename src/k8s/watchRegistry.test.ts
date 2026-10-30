import { invoke } from "@tauri-apps/api/core";
import { LINGER_MS, watchRegistry, type WatchSnapshot } from "./watchRegistry";
import type { K8sRow, K8sWatchMessage } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

const row = (uid: string, name = uid): K8sRow => ({ uid, name, namespace: null, resourceVersion: "1", createdAt: null, labels: {}, values: {} });
const unwatchCalls = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "k8s_unwatch").map((c) => c[1]);

let n = 0;
let key: string;
// 같은 key를 테스트끼리 공유하지 않게 매번 새로 만든다. 접두사는 dropTarget이 찾는 대상 키다.
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
  key = `p|r|c${n++}|v1/pods|*`;
});
afterEach(() => vi.useRealTimers());

function starter(id = 1) {
  const ref: { send: (m: K8sWatchMessage) => void } = { send: () => {} };
  const start = vi.fn((onMessage: (m: K8sWatchMessage) => void) => {
    ref.send = onMessage;
    return Promise.resolve(id);
  });
  return { start, ref };
}

test("shares one start and replays the current state to a later subscriber", async () => {
  const { start, ref } = starter();
  const a: WatchSnapshot[] = [];
  watchRegistry.subscribe(key, start, (s) => a.push(s));
  await Promise.resolve();
  ref.send({ type: "reset", rows: [row("1")] });
  const b: WatchSnapshot[] = [];
  watchRegistry.subscribe(key, start, (s) => b.push(s));
  expect(start).toHaveBeenCalledTimes(1);
  expect(a[0].status).toBe("loading");
  expect(b[0].status).toBe("ready");
  expect(b[0].rows.map((r) => r.uid)).toEqual(["1"]);
});

test("reset, changes, and errors", async () => {
  const { start, ref } = starter();
  let last!: WatchSnapshot;
  watchRegistry.subscribe(key, start, (s) => (last = s));
  ref.send({ type: "reset", rows: [row("1"), row("2")] });
  ref.send({ type: "changes", upserts: [row("3"), row("1", "renamed")], deletes: ["2"] });
  expect(last.rows.map((r) => r.uid).sort()).toEqual(["1", "3"]);
  expect(last.rows.find((r) => r.uid === "1")!.name).toBe("renamed");
  const error = { kind: "other", message: "x" } as never;
  ref.send({ type: "error", error, fatal: false });
  expect(last.status).toBe("ready");
  expect(last.error).toBe(error);
  expect(last.rows).toHaveLength(2);
  ref.send({ type: "error", error, fatal: true });
  expect(last.status).toBe("error");
  expect(last.rows).toHaveLength(0);
});

test("rows array identity changes only when rows change", () => {
  const { start, ref } = starter();
  let last!: WatchSnapshot;
  watchRegistry.subscribe(key, start, (s) => (last = s));
  ref.send({ type: "reset", rows: [row("1")] });
  const before = last.rows;
  ref.send({ type: "error", error: { kind: "other", message: "x" } as never, fatal: false });
  expect(last.rows).toBe(before);
  ref.send({ type: "changes", upserts: [row("2")], deletes: [] });
  expect(last.rows).not.toBe(before);
});

test("start rejection becomes an error state", async () => {
  const error = { kind: "other", message: "no" } as never;
  let last!: WatchSnapshot;
  watchRegistry.subscribe(key, () => Promise.reject(error), (s) => (last = s));
  await vi.advanceTimersByTimeAsync(0);
  expect(last.status).toBe("error");
  expect(last.error).toBe(error);
});

test("unwatches once after the 30 s linger", async () => {
  const { start } = starter(9);
  const off = watchRegistry.subscribe(key, start, () => {});
  await vi.advanceTimersByTimeAsync(0);
  off();
  await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
  expect(unwatchCalls()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(unwatchCalls()).toEqual([{ watchId: 9 }]);
  await vi.advanceTimersByTimeAsync(LINGER_MS * 2);
  expect(unwatchCalls()).toHaveLength(1);
  // 키가 지워졌으니 다시 구독하면 새로 시작한다
  watchRegistry.subscribe(key, start, () => {});
  expect(start).toHaveBeenCalledTimes(2);
});

test("resubscribing within the linger keeps rows and cancels the stop", async () => {
  const { start, ref } = starter(4);
  const off = watchRegistry.subscribe(key, start, () => {});
  await vi.advanceTimersByTimeAsync(0);
  ref.send({ type: "reset", rows: [row("1")] });
  off();
  await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
  let last!: WatchSnapshot;
  watchRegistry.subscribe(key, start, (s) => (last = s));
  expect(last.rows).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(LINGER_MS * 2);
  expect(unwatchCalls()).toEqual([]);
  expect(start).toHaveBeenCalledTimes(1);
});

test("if start has not resolved when the timer fires, unwatch when it does", async () => {
  let resolve!: (id: number) => void;
  const start = vi.fn(() => new Promise<number>((r) => (resolve = r)));
  const off = watchRegistry.subscribe(key, start, () => {});
  off();
  await vi.advanceTimersByTimeAsync(LINGER_MS);
  expect(unwatchCalls()).toEqual([]);
  resolve(5);
  await vi.advanceTimersByTimeAsync(0);
  expect(unwatchCalls()).toEqual([{ watchId: 5 }]);
});

test("dropTarget clears that target's keys without unwatch and ignores late messages", async () => {
  const { start, ref } = starter(2);
  const other = starter(3);
  const otherKey = `p|r|other${n}|v1/pods|*`;
  const target = key.split("|").slice(0, 3).join("|");
  let last!: WatchSnapshot;
  watchRegistry.subscribe(key, start, (s) => (last = s));
  watchRegistry.subscribe(otherKey, other.start, () => {});
  await vi.advanceTimersByTimeAsync(0);
  ref.send({ type: "reset", rows: [row("1")] });
  watchRegistry.dropTarget(target);
  expect(last).toMatchObject({ rows: [], status: "loading" });
  ref.send({ type: "reset", rows: [row("9")] });
  expect(last.rows).toEqual([]);
  await vi.advanceTimersByTimeAsync(LINGER_MS * 2);
  expect(unwatchCalls()).toEqual([]);
  watchRegistry.subscribe(key, start, () => {});
  expect(start).toHaveBeenCalledTimes(2);
  expect(other.start).toHaveBeenCalledTimes(1);
});
