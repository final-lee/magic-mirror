import { eksTarget, matchContext } from "./kubeContext";
import type { KubeContext } from "./types";

const ctx = (name: string, over: Partial<KubeContext> = {}): KubeContext => ({ name, cluster: name, server: null, profile: null, eks: null, ...over });
const stg = ctx("stg-eks", { server: "https://ABC.gr7.ap-northeast-2.eks.amazonaws.com", profile: "stg", eks: { region: "ap-northeast-2", name: "stg" } });
const prd = ctx("prd-eks", { server: "https://DEF.gr7.ap-northeast-2.eks.amazonaws.com", eks: { region: "ap-northeast-2", name: "prd" } });
const dest = (over: Partial<Parameters<typeof matchContext>[0]>) => ({ server: null, name: null, inCluster: false, ...over });

describe("destination → kube context", () => {
  test("matches the server address ignoring case and a trailing slash", () => {
    const m = matchContext(dest({ server: "https://abc.gr7.ap-northeast-2.eks.amazonaws.com/" }), [prd, stg], null);
    expect(m).toMatchObject({ status: "found", by: "server", context: { name: "stg-eks" } });
  });

  test("falls back to the destination name against context, cluster and EKS cluster names", () => {
    expect(matchContext(dest({ name: "stg-eks" }), [prd, stg], null)).toMatchObject({ status: "found", by: "name", context: { name: "stg-eks" } });
    expect(matchContext(dest({ name: "prd" }), [prd, stg], null)).toMatchObject({ status: "found", context: { name: "prd-eks" } });
  });

  test("several contexts for one server are narrowed by name, otherwise offered as a choice", () => {
    const alias = ctx("stg-alias", { server: stg.server, eks: stg.eks });
    expect(matchContext(dest({ server: stg.server, name: "stg-alias" }), [stg, alias], null)).toMatchObject({ status: "found", context: { name: "stg-alias" } });
    expect(matchContext(dest({ server: stg.server }), [stg, alias], null)).toMatchObject({ status: "ambiguous" });
  });

  test("an unknown destination explains itself", () => {
    expect(matchContext(dest({ server: "https://other.example" }), [stg], null)).toMatchObject({ status: "none", inCluster: false });
  });

  test("in-cluster needs the server's saved context; without one (or a stale one) it says so", () => {
    const inCluster = dest({ server: "https://kubernetes.default.svc", inCluster: true });
    expect(matchContext(inCluster, [stg], "stg-eks")).toMatchObject({ status: "found", by: "saved", context: { name: "stg-eks" } });
    expect(matchContext(inCluster, [stg], null)).toMatchObject({ status: "none", inCluster: true });
    expect(matchContext(inCluster, [stg], "gone")).toMatchObject({ status: "none", inCluster: true });
  });
});

describe("EKS tab target", () => {
  test("uses the context's profile, else the app's profile", () => {
    expect(eksTarget(stg, "dev")).toEqual({ status: "ready", target: { profile: "stg", region: "ap-northeast-2", cluster: "stg" } });
    expect(eksTarget(prd, "dev")).toEqual({ status: "ready", target: { profile: "dev", region: "ap-northeast-2", cluster: "prd" } });
  });

  test("explains why a non-EKS context or an unknown profile cannot open", () => {
    expect(eksTarget(ctx("kind"), "dev").status).toBe("blocked");
    expect(eksTarget(prd, null).status).toBe("blocked");
  });
});
