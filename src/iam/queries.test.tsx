import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { iamApi } from "./api";
import {
  alice,
  aliceView,
  bobKeys,
  deployPolicy,
  deployPolicyView,
  logEntry,
  s3WriteGrants,
  sampleFindings,
  sampleLastAccessed,
  sampleOverview,
  simulateResults,
  whoCanResult,
} from "./fixtures";
import {
  iamKeys,
  refreshIam,
  useAccessKeys,
  useChangeLog,
  useFindings,
  useIamCatalog,
  useIamOverview,
  useLastAccessed,
  usePolicy,
  usePolicyRefs,
  usePrincipal,
  usePrincipalActions,
  useSimulation,
  useWhoCan,
} from "./queries";
import type { PolicyRef } from "./types";

const policyRef = (name: string): PolicyRef => ({ arn: `arn:aws:iam::aws:policy/${name}`, name, scope: "aws", description: null, badges: [] });

vi.mock("./api", () => ({
  iamApi: {
    overview: vi.fn(),
    principal: vi.fn(),
    principalActions: vi.fn(),
    policy: vi.fn(),
    accessKeys: vi.fn(),
    actions: vi.fn(),
    findings: vi.fn(),
    whoCan: vi.fn(),
    simulate: vi.fn(),
    lastAccessed: vi.fn(),
    listPolicies: vi.fn(),
    changeLog: vi.fn(),
  },
}));

const m = vi.mocked(iamApi);

function makeClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.overview.mockResolvedValue(sampleOverview());
  m.principal.mockResolvedValue(aliceView());
  m.principalActions.mockResolvedValue(s3WriteGrants);
  m.policy.mockResolvedValue(deployPolicyView());
  m.accessKeys.mockResolvedValue(bobKeys);
  m.actions.mockResolvedValue(["s3:GetObject", "s3:PutObject"]);
  m.findings.mockResolvedValue(sampleFindings());
  m.whoCan.mockResolvedValue(whoCanResult());
  m.simulate.mockResolvedValue(simulateResults);
  m.lastAccessed.mockResolvedValue(sampleLastAccessed());
});

describe("query keys", () => {
  test("follow the documented shapes", () => {
    expect(iamKeys.root("prod")).toEqual(["iam", "prod"]);
    expect(iamKeys.overview("prod")).toEqual(["iam", "prod", "overview"]);
    expect(iamKeys.principal("prod", "arn:x")).toEqual(["iam", "prod", "principal", "arn:x"]);
    expect(iamKeys.actions("prod", "arn:x", "s3", "read")).toEqual(["iam", "prod", "actions", "arn:x", "s3", "read"]);
    expect(iamKeys.policy("prod", "p1")).toEqual(["iam", "prod", "policy", "p1"]);
    expect(iamKeys.keys("prod", "bob")).toEqual(["iam", "prod", "keys", "bob"]);
    expect(iamKeys.catalog).toEqual(["iam", "catalog"]);
    expect(iamKeys.findings("prod")).toEqual(["iam", "prod", "findings"]);
    expect(iamKeys.whoCan("prod", "s3:GetObject", "arn:x")).toEqual(["iam", "prod", "whoCan", "s3:GetObject", "arn:x"]);
    expect(iamKeys.simulate("prod", "s3:GetObject", "", ["arn:a", "arn:b"])).toEqual(["iam", "prod", "simulate", "s3:GetObject", "", ["arn:a", "arn:b"]]);
    expect(iamKeys.lastAccessed("prod", "arn:x")).toEqual(["iam", "prod", "lastAccessed", "arn:x"]);
    expect(iamKeys.policyRefs("prod", "Read")).toEqual(["iam", "prod", "policyRefs", "Read"]);
    expect(iamKeys.changeLog).toEqual(["iam", "changeLog"]);
  });
});

describe("hooks", () => {
  test("each hook calls its command with the profile and caches under its key", async () => {
    const { qc, wrapper } = makeClient();
    const { result } = renderHook(
      () => ({
        overview: useIamOverview("prod"),
        principal: usePrincipal("prod", alice.arn),
        actions: usePrincipalActions("prod", alice.arn, "s3", "write"),
        policy: usePolicy("prod", deployPolicy.id),
        keys: useAccessKeys("prod", "bob"),
        catalog: useIamCatalog(),
      }),
      { wrapper },
    );
    await waitFor(() => {
      for (const q of Object.values(result.current)) expect(q.isSuccess).toBe(true);
    });
    expect(m.overview).toHaveBeenCalledWith("prod", false);
    expect(m.principal).toHaveBeenCalledWith("prod", alice.arn);
    expect(m.principalActions).toHaveBeenCalledWith("prod", alice.arn, "s3", "write");
    expect(m.policy).toHaveBeenCalledWith("prod", deployPolicy.id);
    expect(m.accessKeys).toHaveBeenCalledWith("prod", "bob");
    expect(m.actions).toHaveBeenCalled();
    expect(qc.getQueryData(iamKeys.overview("prod"))).toEqual(sampleOverview());
    expect(qc.getQueryData(iamKeys.catalog)).toEqual(["s3:GetObject", "s3:PutObject"]);
  });

  test("the overview does not run without a profile", () => {
    const { wrapper } = makeClient();
    renderHook(() => useIamOverview(null), { wrapper });
    expect(m.overview).not.toHaveBeenCalled();
  });

  test("access keys can be held back until their tab is shown", () => {
    const { wrapper } = makeClient();
    renderHook(() => useAccessKeys("prod", "bob", false), { wrapper });
    expect(m.accessKeys).not.toHaveBeenCalled();
  });

  test("findings load for the profile", async () => {
    const { qc, wrapper } = makeClient();
    const { result } = renderHook(() => useFindings("prod"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(m.findings).toHaveBeenCalledWith("prod");
    expect(qc.getQueryData(iamKeys.findings("prod"))).toEqual(sampleFindings());
  });

  test("who-can runs only for a search and sends a blank resource as null", async () => {
    const { wrapper } = makeClient();
    const { result } = renderHook(
      () => ({
        none: useWhoCan("prod", null),
        withResource: useWhoCan("prod", { action: "s3:GetObject", resource: "arn:aws:s3:::b/*" }),
        blank: useWhoCan("prod", { action: "s3:PutObject", resource: "" }),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.withResource.isSuccess && result.current.blank.isSuccess).toBe(true));
    expect(m.whoCan).toHaveBeenCalledTimes(2);
    expect(m.whoCan).toHaveBeenCalledWith("prod", "s3:GetObject", "arn:aws:s3:::b/*");
    expect(m.whoCan).toHaveBeenCalledWith("prod", "s3:PutObject", null);
    expect(result.current.none.fetchStatus).toBe("idle");
  });

  test("the simulation and the last-accessed job only run when asked, and their results stay cached", async () => {
    const { qc, wrapper } = makeClient();
    // 화면이 읽는 값(data)을 렌더 중에 읽어야 react-query가 그 값이 바뀔 때 다시 그린다
    const { result } = renderHook(
      () => {
        const sim = useSimulation("prod", [alice.arn], "s3:GetObject", null);
        const last = useLastAccessed("prod", alice.arn);
        return { runSim: sim.refetch, runLast: last.refetch, simData: sim.data, lastData: last.data };
      },
      { wrapper },
    );
    await Promise.resolve();
    expect(m.simulate).not.toHaveBeenCalled();
    expect(m.lastAccessed).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.runSim();
      await result.current.runLast();
    });
    expect(m.simulate).toHaveBeenCalledWith("prod", [alice.arn], "s3:GetObject", null);
    expect(m.lastAccessed).toHaveBeenCalledWith("prod", alice.arn);
    await waitFor(() => expect(result.current.simData).toEqual(simulateResults));
    expect(result.current.lastData).toEqual(sampleLastAccessed());

    // 다시 붙은 구독자는 부르지 않고 캐시를 그대로 본다
    const again = renderHook(() => useLastAccessed("prod", alice.arn), { wrapper });
    expect(again.result.current.data).toEqual(sampleLastAccessed());
    expect(m.lastAccessed).toHaveBeenCalledTimes(1);
  });

  test("the policy picker list is searched by name, and typing keeps the previous list until the new one arrives", async () => {
    const { wrapper } = makeClient();
    m.listPolicies.mockImplementation(async (_p, query) => (query === "" ? [policyRef("ReadOnlyAccess")] : [policyRef("AdministratorAccess")]));
    const { result, rerender } = renderHook(({ q }) => usePolicyRefs("prod", q), { wrapper, initialProps: { q: "" } });
    await waitFor(() => expect(result.current.data?.[0].name).toBe("ReadOnlyAccess"));
    expect(m.listPolicies).toHaveBeenCalledWith("prod", "");

    let release!: () => void;
    m.listPolicies.mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      return [policyRef("AdministratorAccess")];
    });
    rerender({ q: "Admin" });
    expect(result.current.data?.[0].name).toBe("ReadOnlyAccess"); // 새 목록이 올 때까지 이전 목록
    expect(result.current.isPlaceholderData).toBe(true);
    release();
    await waitFor(() => expect(result.current.data?.[0].name).toBe("AdministratorAccess"));
  });

  test("the change log is read fresh every time its view is opened", async () => {
    const { qc, wrapper } = makeClient();
    m.changeLog.mockResolvedValue([logEntry()]);
    const first = renderHook(() => useChangeLog(), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(qc.getQueryData(iamKeys.changeLog)).toEqual([logEntry()]);
    first.unmount();

    const second = renderHook(() => useChangeLog(), { wrapper });
    await waitFor(() => expect(m.changeLog).toHaveBeenCalledTimes(2));
    expect(second.result.current.data).toEqual([logEntry()]);
  });
});

describe("refreshIam", () => {
  async function mounted() {
    const { qc, wrapper } = makeClient();
    const hook = renderHook(() => ({ overview: useIamOverview("prod"), principal: usePrincipal("prod", alice.arn) }), { wrapper });
    await waitFor(() => expect(hook.result.current.principal.isSuccess && hook.result.current.overview.isSuccess).toBe(true));
    vi.clearAllMocks();
    return { qc, hook };
  }

  test("forces the overview exactly once and refetches the other IAM queries", async () => {
    const { qc } = await mounted();
    await refreshIam(qc, "prod");
    expect(m.overview).toHaveBeenCalledTimes(1);
    expect(m.overview).toHaveBeenCalledWith("prod", true);
    expect(m.principal).toHaveBeenCalledTimes(1);

    await qc.invalidateQueries({ queryKey: iamKeys.overview("prod") });
    expect(m.overview).toHaveBeenLastCalledWith("prod", false);
  });

  test("rebuilds the snapshot through the overview before the other queries read it", async () => {
    const { qc } = await mounted();
    const order: string[] = [];
    let finishOverview!: () => void;
    m.overview.mockImplementation(async (_profile, force) => {
      order.push(`overview:${force}`);
      await new Promise<void>((r) => (finishOverview = r));
      return sampleOverview();
    });
    m.principal.mockImplementation(async () => {
      order.push("principal");
      return aliceView();
    });

    const done = refreshIam(qc, "prod");
    await waitFor(() => expect(order).toEqual(["overview:true"]));
    finishOverview();
    await done;
    expect(order).toEqual(["overview:true", "principal"]);
  });

  test("refetches findings and who-can but never starts the slow AWS jobs on its own", async () => {
    const { qc, wrapper } = makeClient();
    const { result } = renderHook(
      () => ({
        overview: useIamOverview("prod"),
        findings: useFindings("prod"),
        who: useWhoCan("prod", { action: "s3:GetObject", resource: "" }),
        sim: useSimulation("prod", [alice.arn], "s3:GetObject", null),
        last: useLastAccessed("prod", alice.arn),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.findings.isSuccess && result.current.who.isSuccess && result.current.overview.isSuccess).toBe(true));
    await act(async () => {
      await result.current.sim.refetch();
      await result.current.last.refetch();
    });
    vi.clearAllMocks();

    await refreshIam(qc, "prod");
    expect(m.findings).toHaveBeenCalledTimes(1);
    expect(m.whoCan).toHaveBeenCalledTimes(1);
    expect(m.simulate).not.toHaveBeenCalled();
    expect(m.lastAccessed).not.toHaveBeenCalled();
    // 이미 받은 값은 지우지 않는다(낡았다고만 표시)
    expect(qc.getQueryData(iamKeys.simulate("prod", "s3:GetObject", "", [alice.arn]))).toEqual(simulateResults);
    expect(qc.getQueryData(iamKeys.lastAccessed("prod", alice.arn))).toEqual(sampleLastAccessed());
  });

  test("leaves other profiles alone", async () => {
    const { qc } = await mounted();
    await refreshIam(qc, "dev");
    expect(m.overview).not.toHaveBeenCalled();
    expect(m.principal).not.toHaveBeenCalled();
  });
});
