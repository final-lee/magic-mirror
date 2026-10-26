import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { api } from "./client";
import { useSettings } from "./queries";

vi.mock("./client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn() } }));

const m = vi.mocked(api);
const proc = (globalThis as unknown as { process: { on(e: string, f: () => void): void; off(e: string, f: () => void): void } }).process;
const stored = { enabledServices: ["ec2"], favorites: [], lastProfile: null, lastRegion: null };

test("a rejected save refetches settings and does not leave an unhandled rejection", async () => {
  const unhandled = vi.fn();
  proc.on("unhandledRejection", unhandled);
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  m.getSettings.mockResolvedValue(stored);
  m.saveSettings.mockRejectedValue({ kind: "other", message: "disk full" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useSettings(), { wrapper });
  await waitFor(() => expect(result.current.settings).toEqual(stored));
  expect(m.getSettings).toHaveBeenCalledTimes(1);

  act(() => result.current.update({ enabledServices: [] }));

  await waitFor(() => expect(m.getSettings).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(errSpy).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  expect(unhandled).not.toHaveBeenCalled();
  proc.off("unhandledRejection", unhandled);
  errSpy.mockRestore();
});
