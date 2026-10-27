/// <reference types="vite/client" />
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { invoke, onSsoExpired, reportSsoExpired } from "./invoke";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const raw = vi.mocked(tauriInvoke);

// 시각만 가짜로 둔다(타이머는 그대로라 비동기 대기가 멈추지 않는다)
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

test("an ssoExpired failure with a profile is reported and still rethrown", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("list_resources", { profile: "prod", region: "x" })).rejects.toEqual({ kind: "ssoExpired" });
  expect(seen).toEqual(["prod"]);
  off();
});

test("other failures, calls without a profile and successes are not reported", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "accessDenied", action: "a" });
  await expect(invoke("get_account", { profile: "prod" })).rejects.toBeTruthy();
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("list_profiles")).rejects.toBeTruthy();
  raw.mockResolvedValueOnce("123");
  await expect(invoke("get_account", { profile: "prod" })).resolves.toBe("123");
  expect(seen).toEqual([]);
  off();
});

test("unsubscribed listeners are not called", async () => {
  const seen: string[] = [];
  onSsoExpired((p) => seen.push(p))();
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("get_account", { profile: "prod" })).rejects.toBeTruthy();
  expect(seen).toEqual([]);
});

test("the report carries the time the call started, not the time it failed", async () => {
  vi.setSystemTime(1_000);
  const seen: Array<[string, number]> = [];
  const off = onSsoExpired((p, startedAt) => seen.push([p, startedAt]));
  raw.mockImplementationOnce(async () => {
    vi.setSystemTime(9_000); // 실패는 한참 뒤에 돌아온다
    throw { kind: "ssoExpired" };
  });
  await expect(invoke("get_account", { profile: "prod" })).rejects.toEqual({ kind: "ssoExpired" });
  expect(seen).toEqual([["prod", 1_000]]);
  off();
});

test("a report made without a start time is stamped with now", () => {
  vi.setSystemTime(2_000);
  const seen: Array<[string, number]> = [];
  const off = onSsoExpired((p, startedAt) => seen.push([p, startedAt]));
  reportSsoExpired("prod");
  reportSsoExpired("dev", 500);
  expect(seen).toEqual([
    ["prod", 2_000],
    ["dev", 500],
  ]);
  off();
});

test("a throwing listener neither changes the caller's error nor starves the other listeners", async () => {
  const seen: string[] = [];
  const offBad = onSsoExpired(() => {
    throw new Error("listener bug");
  });
  const offGood = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("get_account", { profile: "prod" })).rejects.toEqual({ kind: "ssoExpired" });
  expect(seen).toEqual(["prod"]);
  offBad();
  offGood();
});

test("only the wrapper imports invoke from @tauri-apps/api/core", () => {
  const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.*", "!/src/api/invoke.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  });
  // 패턴이 빗나가 아무 파일도 못 읽으면 검사가 헛돌기 때문에, 래퍼를 쓰는 파일이 잡혔는지 먼저 본다
  expect(Object.keys(sources)).toContain("/src/api/client.ts");
  const core = String.raw`["']@tauri-apps/api/core["']`;
  const direct = [
    new RegExp(String.raw`import\s+(?:type\s+)?\{[^}]*\binvoke\b[^}]*\}\s*from\s*${core}`), // import { invoke } / { invoke as x }
    new RegExp(String.raw`import\s*\*\s*as\s+\w+\s+from\s*${core}`), // import * as core (core.invoke)
    new RegExp(String.raw`import\s*\(\s*${core}\s*\)`), // await import(...)
    new RegExp(String.raw`require\(\s*${core}\s*\)`),
  ];
  const offenders = Object.entries(sources)
    .filter(([, text]) => direct.some((re) => re.test(text)))
    .map(([path]) => path);
  expect(offenders).toEqual([]);
});
