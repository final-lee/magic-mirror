import { act, renderHook, waitFor } from "@testing-library/react";
import { useTransfers } from "./useTransfers";
import { explorerApi, onTransferProgress } from "./api";
import type { TransferEvent, TransferRequest } from "./types";

vi.mock("./api", () => ({
  explorerApi: { startTransfers: vi.fn() },
  onTransferProgress: vi.fn(),
}));

let emit: (ev: TransferEvent) => void = () => {};

beforeEach(() => {
  vi.mocked(explorerApi.startTransfers).mockReset().mockResolvedValue(undefined);
  vi.mocked(onTransferProgress).mockReset().mockImplementation(async (cb) => {
    emit = cb;
    return () => {};
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
