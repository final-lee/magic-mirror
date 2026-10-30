import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
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
  const { result, unmount } = renderHook(() => useK8sWatch(T, "prod-ro", NAMESPACES, null, true));
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
  renderHook(() => useK8sWatch(T, "p", NAMESPACES, null, false));
  await act(async () => {});
  expect(invoke).not.toHaveBeenCalled();
});
