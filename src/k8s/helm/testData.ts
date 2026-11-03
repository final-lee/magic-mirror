import type { K8sKind, K8sRules } from "../types";
import type { HelmRelease, HelmReleaseDetail, HelmRevision } from "./types";

export const TARGET = { profile: "app", region: "r", cluster: "c" };

export const release = (over: Partial<HelmRelease> = {}): HelmRelease => ({
  name: "web", namespace: "apps", revision: 3, status: "deployed", problem: false, chart: "web-1.0.0", chartName: "web", chartVersion: "1.0.0", appVersion: "9",
  updated: "2026-01-02T00:00:00Z", description: "Upgrade complete", revisions: 3, driver: "secret", unreadable: false, ...over,
});

export const revision = (n: number, over: Partial<HelmRevision> = {}): HelmRevision => ({
  revision: n, status: n === 3 ? "deployed" : "superseded", updated: "2026-01-01T00:00:00Z", chart: "web-1.0.0", chartName: "web", chartVersion: "1.0.0", appVersion: "9",
  description: `desc ${n}`, unreadable: false, ...over,
});

export const detail = (over: Partial<HelmReleaseDetail> = {}): HelmReleaseDetail => ({
  name: "web", namespace: "apps", revision: 3, latest: 3, status: "deployed", problem: false, description: "Upgrade complete",
  firstDeployed: "2026-01-01T00:00:00Z", lastDeployed: "2026-01-02T00:00:00Z", notes: "Visit http://web\n",
  chart: { name: "web", version: "1.0.0", appVersion: "9", description: "A web chart", home: "", kubeVersion: "", deprecated: false, dependencies: [] },
  userValues: "replicas: 2\n", computedValues: "image: nginx\nreplicas: 2\n", manifest: "kind: Deployment\n",
  resources: [
    { apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: null },
    { apiVersion: "v1", kind: "ConfigMap", name: "web-config", namespace: "apps" },
    { apiVersion: "example.com/v1", kind: "Widget", name: "w1", namespace: null },
  ],
  hooks: [], history: [revision(3), revision(2), revision(1)], driver: "secret", ...over,
});

const kind = (group: string, version: string, kind: string, plural: string, namespaced = true): K8sKind => ({ group, version, kind, plural, namespaced, verbs: ["get", "list"], custom: false });
/** 이 클러스터가 내주는 종류(Widget은 없다) */
export const KINDS: K8sKind[] = [kind("apps", "v1", "Deployment", "deployments"), kind("", "v1", "ConfigMap", "configmaps")];

export const ALLOWED: K8sRules = { namespace: "apps", incomplete: false, nonResourceRules: [], resourceRules: [{ verbs: ["*"], apiGroups: ["*"], resources: ["*"], resourceNames: [] }] };
export const READ_ONLY: K8sRules = { namespace: "apps", incomplete: false, nonResourceRules: [], resourceRules: [{ verbs: ["get", "list"], apiGroups: [""], resources: ["secrets"], resourceNames: [] }] };
