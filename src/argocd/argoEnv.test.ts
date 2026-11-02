import { ARGO_ENVS, envOf } from "./argoEnv";
import type { ArgoAppRow } from "./types";

const app = (name: string, labels: Record<string, string> = {}, values: Record<string, string> = {}): ArgoAppRow => ({ name, namespace: "argocd", resourceVersion: "1", values, labels });

test("the display order is fixed, with unknown last", () => {
  expect(ARGO_ENVS).toEqual(["dev", "stg", "prd", "ops", "demo", "preview", "unknown"]);
});

describe("labels", () => {
  test("the environment label wins, normalizing the usual spellings", () => {
    expect(envOf(app("x", { environment: "dev" }))).toEqual({ env: "dev", source: "label" });
    expect(envOf(app("x", { environment: "prod" })).env).toBe("prd");
    expect(envOf(app("x", { environment: "production" })).env).toBe("prd");
    expect(envOf(app("x", { environment: "prd" })).env).toBe("prd");
    expect(envOf(app("x", { environment: "staging" })).env).toBe("stg");
    expect(envOf(app("x", { environment: "development" })).env).toBe("dev");
    expect(envOf(app("x", { environment: "ops" })).env).toBe("ops");
    expect(envOf(app("x", { environment: "Demo" })).env).toBe("demo");
  });

  test("env takes the last dash token when the whole value is not an environment", () => {
    expect(envOf(app("x", { env: "ai-dev" }))).toEqual({ env: "dev", source: "label" });
    expect(envOf(app("x", { env: "ai-stg" })).env).toBe("stg");
    expect(envOf(app("x", { env: "ai-prd" })).env).toBe("prd");
    expect(envOf(app("x", { env: "prod" })).env).toBe("prd");
  });

  test("environment is read before env", () => {
    expect(envOf(app("x", { environment: "stg", env: "ai-dev" })).env).toBe("stg");
  });

  test("a label value that is not an environment falls through to the next rule", () => {
    expect(envOf(app("x-prd", { env: "ai-airflow" }))).toEqual({ env: "prd", source: "name" });
    expect(envOf(app("x", { environment: "blue", env: "ai-stg" }))).toEqual({ env: "stg", source: "label" });
    expect(envOf(app("x", { env: "ai-airflow" }))).toEqual({ env: "unknown", source: null });
  });

  test("preview=true beats every other label and name", () => {
    expect(envOf(app("pr-12-dev", { preview: "true", slug: "pr-12", environment: "prd" }))).toEqual({ env: "preview", source: "label" });
    expect(envOf(app("pr-12-dev", { preview: "false" }))).toEqual({ env: "dev", source: "name" });
  });
});

describe("name, namespace and cluster", () => {
  test("name tokens: the last environment word wins", () => {
    expect(envOf(app("ai-admin-api-dev"))).toEqual({ env: "dev", source: "name" });
    expect(envOf(app("web-prod-stg")).env).toBe("stg");
    expect(envOf(app("web-ops")).env).toBe("ops");
    expect(envOf(app("web-demo")).env).toBe("demo");
  });

  test("a word only counts as a whole token", () => {
    expect(envOf(app("developer-portal")).env).toBe("unknown");
    expect(envOf(app("prodigy", {}, { destNamespace: "operations" })).env).toBe("unknown");
  });

  test("the name comes before the namespace, and the namespace before the cluster", () => {
    const values = { destNamespace: "backend-stg", destination: "x-prd-blue-cluster" };
    expect(envOf(app("billing-dev", {}, values))).toEqual({ env: "dev", source: "name" });
    expect(envOf(app("billing", {}, values))).toEqual({ env: "stg", source: "namespace" });
    expect(envOf(app("billing", {}, { destination: "x-prd-blue-cluster", destNamespace: "backend" }))).toEqual({ env: "prd", source: "cluster" });
  });

  test("a cluster name may carry digits after the environment word", () => {
    expect(envOf(app("web", {}, { destination: "x-dev2-cluster" }))).toEqual({ env: "dev", source: "cluster" });
    expect(envOf(app("web", {}, { destination: "prd" })).env).toBe("prd");
    expect(envOf(app("web", {}, { destination: "x-stg-green-cluster" })).env).toBe("stg");
  });

  test("nothing to go on is unknown", () => {
    expect(envOf(app("web", { team: "ai" }, { destination: "https://kubernetes.default.svc", destNamespace: "kube-system" }))).toEqual({ env: "unknown", source: null });
    expect(envOf(app("web"))).toEqual({ env: "unknown", source: null });
  });
});
