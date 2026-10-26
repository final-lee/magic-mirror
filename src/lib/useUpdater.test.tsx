import { act, renderHook, waitFor } from "@testing-library/react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { CHECK_INTERVAL_MS, useUpdater } from "./useUpdater";

function fakeUpdate(version = "0.2.0") {
  return {
    version,
    body: "notes",
    downloadAndInstall: vi.fn(async (cb: (e: unknown) => void) => {
      cb({ event: "Started", data: { contentLength: 100 } });
      cb({ event: "Progress", data: { chunkLength: 50 } });
      cb({ event: "Finished" });
    }),
  };
}

beforeEach(() => {
  vi.mocked(check).mockReset().mockResolvedValue(null);
  vi.mocked(relaunch).mockReset().mockResolvedValue();
});
afterEach(() => vi.useRealTimers());

test("checks on start and shows the banner when an update exists", async () => {
  vi.mocked(check).mockResolvedValue(fakeUpdate() as never);
  const { result } = renderHook(() => useUpdater());
  await waitFor(() => expect(result.current.state).toMatchObject({ kind: "available", version: "0.2.0" }));
  expect(result.current.showBanner).toBe(true);
});

test("dismiss hides the banner for that version; a manual check shows it again", async () => {
  vi.mocked(check).mockResolvedValue(fakeUpdate() as never);
  const { result } = renderHook(() => useUpdater());
  await waitFor(() => expect(result.current.showBanner).toBe(true));
  act(() => result.current.dismiss());
  expect(result.current.showBanner).toBe(false);
  await act(() => result.current.checkNow());
  expect(result.current.showBanner).toBe(true);
});

test("automatic check failure stays silent; manual failure is shown", async () => {
  vi.mocked(check).mockRejectedValue(new Error("offline"));
  const { result } = renderHook(() => useUpdater());
  await waitFor(() => expect(check).toHaveBeenCalled());
  expect(result.current.state.kind).toBe("idle");
  await act(() => result.current.checkNow());
  expect(result.current.state).toMatchObject({ kind: "error" });
});

test("install downloads, then relaunches", async () => {
  const u = fakeUpdate();
  vi.mocked(check).mockResolvedValue(u as never);
  const { result } = renderHook(() => useUpdater());
  await waitFor(() => expect(result.current.state.kind).toBe("available"));
  await act(() => result.current.install());
  expect(u.downloadAndInstall).toHaveBeenCalled();
  expect(relaunch).toHaveBeenCalled();
});

test("re-checks every 6 hours", async () => {
  vi.useFakeTimers();
  renderHook(() => useUpdater());
  await act(async () => {});
  expect(check).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
  });
  expect(check).toHaveBeenCalledTimes(2);
});
