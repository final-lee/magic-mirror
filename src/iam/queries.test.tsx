import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { iamApi } from "./api";
import { alice, aliceView, bobKeys, deployPolicy, deployPolicyView, s3WriteGrants, sampleOverview } from "./fixtures";
import { iamKeys, refreshIam, useAccessKeys, useIamCatalog, useIamOverview, usePolicy, usePrincipal, usePrincipalActions } from "./queries";

vi.mock("./api", () => ({
  iamApi: { overview: vi.fn(), principal: vi.fn(), principalActions: vi.fn(), policy: vi.fn(), accessKeys: vi.fn(), actions: vi.fn() },
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

  test("leaves other profiles alone", async () => {
    const { qc } = await mounted();
    await refreshIam(qc, "dev");
    expect(m.overview).not.toHaveBeenCalled();
    expect(m.principal).not.toHaveBeenCalled();
  });
});
