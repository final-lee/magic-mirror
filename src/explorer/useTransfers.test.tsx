import { act, renderHook, waitFor } from "@testing-library/react";
import { useTransfers } from "./useTransfers";
import { explorerApi, onTransferProgress } from "./api";
import type { TransferEvent, TransferRequest } from "./types";

vi.mock("./api", () => ({
  explorerApi: { startTransfers: vi.fn() },
  onTransferProgress: vi.fn(),
}));

const unlistenFn = vi.fn();
let emit: (ev: TransferEvent) => void = () => {};

beforeEach(() => {
  vi.mocked(explorerApi.startTransfers).mockReset().mockResolvedValue(undefined);
  unlistenFn.mockReset();
  vi.mocked(onTransferProgress).mockReset().mockImplementation(async (cb) => {
    emit = cb;
    return unlistenFn;
  });
});

const req = (id: string): TransferRequest => ({
  id,
  direction: "upload",
  localPath: `/l/${id}`,
  bucket: "b",
  region: "r",
  key: `k/${id}`,
});

test("enqueue starts transfers and tracks events", async () => {
  const onSettled = vi.fn();
  const { result } = renderHook(() => useTransfers("prod", onSettled));
  await waitFor(() => expect(onTransferProgress).toHaveBeenCalled());

  await act(() => result.current.enqueue([req("1"), req("2")]));
  expect(explorerApi.startTransfers).toHaveBeenCalledWith("prod", [req("1"), req("2")]);
  expect(result.current.items.map((i) => i.event.status)).toEqual(["queued", "queued"]);

  act(() => emit({ id: "1", status: "running", transferred: 5, total: 10, error: null }));
  expect(result.current.items[0].event.transferred).toBe(5);

  act(() => emit({ id: "1", status: "done", transferred: 10, total: 10, error: null }));
  expect(onSettled).toHaveBeenCalledWith(req("1"));

  act(() => emit({ id: "2", status: "failed", transferred: 0, total: null, error: { kind: "throttled" } }));
  expect(result.current.items[1].event.status).toBe("failed");
});

test("retry restarts a failed item and clearFinished removes done items", async () => {
  const { result } = renderHook(() => useTransfers("prod", () => {}));
  await waitFor(() => expect(onTransferProgress).toHaveBeenCalled());
  await act(() => result.current.enqueue([req("1"), req("2")]));
  act(() => emit({ id: "1", status: "done", transferred: 1, total: 1, error: null }));
  act(() => emit({ id: "2", status: "failed", transferred: 0, total: null, error: { kind: "network", message: "x" } }));

  await act(() => result.current.retry("2"));
  expect(explorerApi.startTransfers).toHaveBeenLastCalledWith("prod", [req("2")]);
  expect(result.current.items.find((i) => i.request.id === "2")?.event.status).toBe("queued");

  act(() => result.current.clearFinished());
  expect(result.current.items.map((i) => i.request.id)).toEqual(["2"]);
});

test("events for unknown ids are ignored", async () => {
  const { result } = renderHook(() => useTransfers("prod", () => {}));
  await waitFor(() => expect(onTransferProgress).toHaveBeenCalled());
  act(() => emit({ id: "zzz", status: "done", transferred: 1, total: 1, error: null }));
  expect(result.current.items).toEqual([]);
});

const ev = (id: string, status: TransferEvent["status"]): TransferEvent => ({
  id,
  status,
  transferred: 0,
  total: null,
  error: null,
});

test("enqueue marks items failed when startTransfers rejects", async () => {
  vi.mocked(explorerApi.startTransfers).mockRejectedValueOnce(new Error("boom"));
  const { result } = renderHook(() => useTransfers("prod", () => {}));
  await waitFor(() => expect(onTransferProgress).toHaveBeenCalled());
  await act(() => result.current.enqueue([req("1")]));
  expect(result.current.items[0].event.status).toBe("failed");
  expect(result.current.items[0].event.error).toEqual({ kind: "other", message: "boom" });
});

test("retry marks item failed when startTransfers rejects", async () => {
  const { result } = renderHook(() => useTransfers("prod", () => {}));
  await waitFor(() => expect(onTransferProgress).toHaveBeenCalled());
  await act(() => result.current.enqueue([req("1")]));
  act(() => emit(ev("1", "failed")));
  vi.mocked(explorerApi.startTransfers).mockRejectedValueOnce({ kind: "throttled" });
  await act(() => result.current.retry("1"));
  expect(result.current.items[0].event.status).toBe("failed");
  expect(result.current.items[0].event.error).toEqual({ kind: "throttled" });
});

test("done is terminal: late running ignored and onSettled fires once", async () => {
  const onSettled = vi.fn();
  const { result } = renderHook(() => useTransfers("prod", onSettled));
  await waitFor(() => expect(onTransferProgress).toHaveBeenCalled());
  await act(() => result.current.enqueue([req("1")]));
  act(() => emit(ev("1", "done")));
  act(() => emit(ev("1", "running")));
  expect(result.current.items[0].event.status).toBe("done");
  act(() => emit(ev("1", "done")));
  expect(onSettled).toHaveBeenCalledTimes(1);
});

test("failed item ignores late running but retry re-queues it", async () => {
  const { result } = renderHook(() => useTransfers("prod", () => {}));
  await waitFor(() => expect(onTransferProgress).toHaveBeenCalled());
  await act(() => result.current.enqueue([req("1")]));
  act(() => emit(ev("1", "failed")));
  act(() => emit(ev("1", "running")));
  expect(result.current.items[0].event.status).toBe("failed");
  await act(() => result.current.retry("1"));
  act(() => emit(ev("1", "running")));
  expect(result.current.items[0].event.status).toBe("running");
});

test("unlisten is called on unmount", async () => {
  const { unmount } = renderHook(() => useTransfers("prod", () => {}));
  await waitFor(() => expect(onTransferProgress).toHaveBeenCalled());
  await act(async () => {});
  unmount();
  expect(unlistenFn).toHaveBeenCalledTimes(1);
});

test("unlisten is called when unmounted before listen resolves", async () => {
  let resolve: (fn: () => void) => void = () => {};
  vi.mocked(onTransferProgress).mockImplementationOnce(
    () => new Promise((r) => { resolve = r; }),
  );
  const { unmount } = renderHook(() => useTransfers("prod", () => {}));
  unmount();
  expect(unlistenFn).not.toHaveBeenCalled();
  await act(async () => resolve(unlistenFn));
  expect(unlistenFn).toHaveBeenCalledTimes(1);
});
