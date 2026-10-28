/// <reference types="vite/client" />
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { pgApi } from "../pg/api";
import { pgTarget } from "../pg/fixtures";
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

// pg 명령은 profile을 최상위 인자가 아니라 target 객체 안에 담는다(`{ target: { profile, region, kind, id }, … }`). 샘플 대상의 프로필은 "prod"다.
test("an ssoExpired failure of a pg command is reported with the profile inside its target", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("pg_open", { target: pgTarget, loginUser: "iam_admin" })).rejects.toEqual({ kind: "ssoExpired" });
  expect(seen).toEqual(["prod"]);
  off();
});

test("the pg wrappers report an expired session through the same path", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(pgApi.target({ ...pgTarget, profile: "dev" })).rejects.toEqual({ kind: "ssoExpired" });
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(pgApi.open({ ...pgTarget, profile: "dev" }, "iam_admin")).rejects.toEqual({ kind: "ssoExpired" });
  expect(seen).toEqual(["dev", "dev"]);
  off();
});

test("the top-level profile wins when a call has both", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("odd", { profile: "dev", target: pgTarget })).rejects.toBeTruthy();
  expect(seen).toEqual(["dev"]);
  off();
});

test("a top-level profile that is not a string does not hide the one in the target", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("odd", { profile: 7, target: pgTarget })).rejects.toBeTruthy();
  expect(seen).toEqual(["prod"]);
  off();
});

test.each([
  ["neither field", { region: "ap-northeast-2" }],
  ["a target without a profile", { target: { region: "ap-northeast-2", kind: "cluster", id: "orders-aurora" } }],
  ["a target that is not an object", { target: "prod" }],
  ["a null target", { target: null }],
  ["an array target", { target: ["prod"] }],
  ["a target profile that is not a string", { target: { ...pgTarget, profile: 7 } }],
  ["a profile that is not a string anywhere", { profile: 7, target: { profile: null } }],
])("an ssoExpired failure of a call with %s is not reported", async (_name, args) => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("odd", args)).rejects.toEqual({ kind: "ssoExpired" });
  expect(seen).toEqual([]);
  off();
});

test("other failures of a pg command are not reported", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "network", message: "엔드포인트에 연결하지 못했어요(db.example:5432). VPN이 켜져 있는지 확인하세요" });
  await expect(invoke("pg_open", { target: pgTarget, loginUser: "iam_admin" })).rejects.toBeTruthy();
  raw.mockResolvedValueOnce(null);
  await expect(invoke("pg_close", { target: pgTarget })).resolves.toBeNull();
  expect(seen).toEqual([]);
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
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
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
  log.mockRestore();
});

test("a throwing listener is logged, so a bug in the login manager does not vanish silently", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const bug = new Error("listener bug");
  const off = onSsoExpired(() => {
    throw bug;
  });
  reportSsoExpired("prod");
  off();
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(expect.any(String), bug);
  log.mockRestore();
});

test("listeners that do not throw log nothing", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const off = onSsoExpired(() => {});
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("get_account", { profile: "prod" })).rejects.toBeTruthy();
  off();
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
});

// 래퍼(src/api/invoke.ts)를 우회해 Tauri의 invoke에 닿는 길을 소스 글자로 찾는다. `@tauri-apps/api`의 첫 화면도 core를 내보낸다(core.invoke).
const CORE = String.raw`["']@tauri-apps/api/core["']`;
const ROOT = String.raw`["']@tauri-apps/api["']`;
const named = (name: string, from: string) => String.raw`\b(?:import|export)\s+(?:type\s+)?\{[^}]*\b${name}\b[^}]*\}\s*from\s*${from}`; // import { x } / export { x } from
const star = (from: string) => String.raw`\b(?:import|export)\s*\*(?:\s*as\s+\w+)?\s*from\s*${from}`; // import * as x / export * (as x) from
const dynamic = (from: string) => String.raw`\b(?:import|require)\s*\(\s*${from}\s*\)`; // import("...") / require("...")
const WAYS_TO_REACH_INVOKE = [
  named("invoke", CORE),
  star(CORE),
  dynamic(CORE),
  named("core", ROOT),
  star(ROOT),
  dynamic(ROOT),
].map((source) => new RegExp(source));
const reachesInvoke = (text: string) => WAYS_TO_REACH_INVOKE.some((way) => way.test(text));

test("the boundary check recognizes every way to reach Tauri's invoke", () => {
  const bypasses = [
    `import { invoke } from "@tauri-apps/api/core";`,
    `import { invoke as call } from '@tauri-apps/api/core'`,
    `import { convertFileSrc, invoke } from "@tauri-apps/api/core"`,
    `import {\n  invoke,\n} from "@tauri-apps/api/core"`,
    `import * as core from "@tauri-apps/api/core"`,
    `const { invoke } = await import("@tauri-apps/api/core")`,
    `const core = require('@tauri-apps/api/core')`,
    // 다시 내보내면 다른 파일이 래퍼 없이 가져다 쓴다
    `export { invoke } from "@tauri-apps/api/core"`,
    `export { invoke as rawInvoke } from "@tauri-apps/api/core";`,
    `export * from "@tauri-apps/api/core"`,
    `export * as core from "@tauri-apps/api/core"`,
    // 첫 화면의 core로도 core.invoke에 닿는다
    `import { core } from "@tauri-apps/api"`,
    `import { event, core as tauriCore } from '@tauri-apps/api'`,
    `import {\n  event,\n  core,\n} from "@tauri-apps/api"`,
    `import * as tauri from "@tauri-apps/api"`,
    `export { core } from "@tauri-apps/api"`,
    `export * from "@tauri-apps/api"`,
    `const { core } = await import("@tauri-apps/api")`,
    `const tauri = require("@tauri-apps/api")`,
  ];
  for (const source of bypasses) expect(reachesInvoke(source), source).toBe(true);
});

test("the boundary check lets the other Tauri imports through", () => {
  const allowed = [
    `import { listen } from "@tauri-apps/api/event"`,
    `import { getCurrentWebview } from "@tauri-apps/api/webview"`,
    `import { getVersion } from "@tauri-apps/api/app"`,
    `import type { InvokeArgs } from "@tauri-apps/api/core"`,
    `import { event } from "@tauri-apps/api"`,
    `import { check } from "@tauri-apps/plugin-updater"`,
    `import { invoke } from "./invoke"`,
    `import { invoke } from "../api/invoke"`,
    `export { invoke } from "./invoke"`,
  ];
  for (const source of allowed) expect(reachesInvoke(source), source).toBe(false);
});

test("only the wrapper reaches Tauri's invoke", () => {
  const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.*", "!/src/api/invoke.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  });
  // 패턴이 빗나가 아무 파일도 못 읽으면 검사가 헛돌기 때문에, 래퍼를 쓰는 파일이 잡혔는지 먼저 본다
  expect(Object.keys(sources)).toContain("/src/api/client.ts");
  const offenders = Object.entries(sources)
    .filter(([, text]) => reachesInvoke(text))
    .map(([path]) => path);
  expect(offenders).toEqual([]);
});
