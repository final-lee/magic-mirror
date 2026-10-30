import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { watchRegistry, LINGER_MS } from "./watchRegistry";
import { targetKey } from "./targets";
import { useK8sWatch } from "./useK8sWatch";
import { NAMESPACES } from "./targets";
import type { K8sRow } from "./types";

type Channel = { onmessage: (m: unknown) => void };
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class { onmessage: ((m: unknown) => void) | null = null } }));

const row = (uid: string, name: string, namespace: string | null = null): K8sRow => ({ uid, name, namespace, resourceVersion: "1", createdAt: null, labels: {}, values: {} });

let n = 0;
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(1);
});

test("subscribes, sorts rows by name then namespace, and reports ready", async () => {
  const T = { profile: "app", region: "r", cluster: `hook${n++}` };
  const { result, unmount } = renderHook(() => useK8sWatch(T, "ctx", "prod-ro", NAMESPACES, null, true));
  expect(result.current.status).toBe("loading");
  await act(async () => {});
  const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "k8s_watch")!;
  expect(call[1]).toMatchObject({ target: T, kind: NAMESPACES, namespace: null, profile: "prod-ro" });
  const ch = (call[1] as { onEvent: Channel }).onEvent;
  act(() => ch.onmessage({ type: "reset", rows: [row("3", "b", "z"), row("2", "b", "a"), row("1", "a")] }));
  expect(result.current.status).toBe("ready");
  expect(result.current.rows.map((r) => r.uid)).toEqual(["1", "2", "3"]);
  unmount();
});

test("does nothing while disabled", async () => {
  const T = { profile: "app", region: "r", cluster: `hook${n++}` };
  renderHook(() => useK8sWatch(T, "ctx", "p", NAMESPACES, null, false));
  await act(async () => {});
  expect(invoke).not.toHaveBeenCalled();
});

const watchCalls = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "k8s_watch");
const unwatchCalls = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "k8s_unwatch");

test("drop then re-enable refills the rows", async () => {
  const T = { profile: "app", region: "r", cluster: `hook${n++}` };
  vi.mocked(invoke).mockResolvedValue(1);
  const { result, rerender } = renderHook(({ on }) => useK8sWatch(T, "ctx", "p", NAMESPACES, null, on), { initialProps: { on: true } });
  await act(async () => {});
  const send = (m: unknown) => act(() => (watchCalls()[watchCalls().length - 1][1] as { onEvent: Channel }).onEvent.onmessage(m));
  send({ type: "reset", rows: [row("1", "a")] });
  expect(result.current.rows).toHaveLength(1);
  act(() => watchRegistry.dropTarget(targetKey(T)));
  rerender({ on: false });
  rerender({ on: true });
  await act(async () => {});
  expect(watchCalls()).toHaveLength(2);
  send({ type: "reset", rows: [row("2", "b")] });
  expect(result.current.rows.map((r) => r.uid)).toEqual(["2"]);
});

test("a drop while enabled resubscribes", async () => {
  const T = { profile: "app", region: "r", cluster: `hook${n++}` };
  vi.mocked(invoke).mockResolvedValue(1);
  renderHook(() => useK8sWatch(T, "ctx", "p", NAMESPACES, null, true));
  await act(async () => {});
  act(() => watchRegistry.dropTarget(targetKey(T)));
  await act(async () => {});
  expect(watchCalls()).toHaveLength(2);
});

test("different contexts watch separately", async () => {
  const T = { profile: "app", region: "r", cluster: `hook${n++}` };
  vi.mocked(invoke).mockResolvedValue(1);
  renderHook(() => useK8sWatch(T, "a", "p", NAMESPACES, null, true));
  renderHook(() => useK8sWatch(T, "b", "p", NAMESPACES, null, true));
  await act(async () => {});
  expect(watchCalls()).toHaveLength(2);
});

test("unmount lingers then unwatches; a key change moves to a new watch while the old lingers", async () => {
  vi.useFakeTimers();
  try {
    const T = { profile: "app", region: "r", cluster: `hook${n++}` };
    vi.mocked(invoke).mockResolvedValue(5);
    const { rerender, unmount } = renderHook(({ ns }) => useK8sWatch(T, "ctx", "p", NAMESPACES, ns, true), { initialProps: { ns: "a" as string | null } });
    await act(async () => {});
    rerender({ ns: "b" });
    await act(async () => {});
    expect(watchCalls()).toHaveLength(2);
    expect(unwatchCalls()).toHaveLength(0);
    await act(async () => void (await vi.advanceTimersByTimeAsync(LINGER_MS)));
    expect(unwatchCalls()).toHaveLength(1);
    unmount();
    expect(unwatchCalls()).toHaveLength(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(LINGER_MS)));
    expect(unwatchCalls()).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
