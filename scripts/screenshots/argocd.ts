// Realistic ArgoCD data for the browser-only screenshot harness.
import type { ArgoApp, ArgoAppRow, ArgoAppSetRow, ArgoTreeNode } from "../../src/argocd/types";

const URL = "https://argocd.demo.ts.net";
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const services = ["checkout", "catalog", "payments", "orders", "inventory", "shipping", "accounts", "notifications", "gateway", "search", "recommendations", "analytics", "prometheus", "external-dns"];
const sets = ["commerce-services", "platform-services", "data-services", "observability", "infra-addons"];
const apps: ArgoAppRow[] = services.flatMap((service, i) => ["prd", "stg", "dev"].map((env, j) => {
  const degraded = service === "checkout" && env === "prd";
  const progressing = service === "payments" && env === "stg";
  const unknown = service === "prometheus" && env === "prd";
  const out = degraded || progressing || (service === "inventory" && env === "prd") || (service === "analytics" && env === "dev");
  return {
    name: `${service}-${env}`, namespace: "argocd", resourceVersion: `${91000 + i * 3 + j}`,
    values: { sync: out ? "OutOfSync" : "Synced", health: degraded ? "Degraded" : progressing ? "Progressing" : unknown ? "Unknown" : "Healthy", project: i < 6 ? "commerce" : i < 10 ? "platform" : i < 12 ? "data" : "operations", destination: `eks-${env}-apne2`, destNamespace: service, revision: "8f31c7a9d2b4e6f01234567890abcdef12345678", targetRevision: "main", operation: degraded ? "Failed" : progressing ? "Running" : "Succeeded", lastSync: ago(12 + i * 8 + j * 3), autoSync: "true", appSet: sets[i < 6 ? 0 : i < 10 ? 1 : i < 12 ? 2 : i === 12 ? 3 : 4], ...(degraded ? { errors: "1" } : {}) },
    labels: { environment: env, team: i < 6 ? "commerce" : i < 10 ? "platform" : i < 12 ? "data" : "operations" },
  };
}));
const appsets: ArgoAppSetRow[] = sets.map((name, i) => ({ name, namespace: "argocd", status: "UpToDate", message: null, generators: i === 1 ? ["clusters"] : ["git", "list"] }));

function tree(name: string): ArgoTreeNode[] {
  const base = name.replace(/-(prd|stg|dev)$/, "");
  const ns = base;
  const bad = name === "checkout-prd";
  const node = (uid: string, kind: string, n: string, parents: string[], health: string | null, extra: Partial<ArgoTreeNode> = {}): ArgoTreeNode => ({ uid, group: kind === "Deployment" || kind === "ReplicaSet" ? "apps" : "", version: "v1", kind, namespace: ns, name: n, parents, health, healthMessage: null, info: [], images: [], createdAt: ago(14400), ...extra });
  return [
    node("deploy", "Deployment", base, [], bad ? "Degraded" : "Healthy", { healthMessage: bad ? "Deployment does not have minimum availability." : null, info: ["Replicas: 2/3", "Strategy: RollingUpdate"], images: [`123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/${base}:8f31c7a`] }),
    node("rs", "ReplicaSet", `${base}-6bd8f9b7c4`, ["deploy"], bad ? "Progressing" : "Healthy", { info: ["Replicas: 2/3"] }),
    node("pod1", "Pod", `${base}-6bd8f9b7c4-7p9kw`, ["rs"], "Healthy", { info: ["Node: ip-10-42-12-87", "Restarts: 0"], createdAt: ago(35) }),
    node("pod2", "Pod", `${base}-6bd8f9b7c4-b4n2q`, ["rs"], "Healthy", { info: ["Node: ip-10-42-18-23", "Restarts: 0"], createdAt: ago(34) }),
    node("pod3", "Pod", `${base}-6bd8f9b7c4-f8m6v`, ["rs"], bad ? "Degraded" : "Healthy", { healthMessage: bad ? "CrashLoopBackOff: back-off restarting failed container" : null, info: ["Node: ip-10-42-21-104", `Restarts: ${bad ? 7 : 0}`], createdAt: ago(33) }),
    node("svc", "Service", base, [], "Healthy", { info: ["Type: ClusterIP", "Port: 8080/TCP"] }),
    node("cm", "ConfigMap", `${base}-config`, [], null),
    node("hpa", "HorizontalPodAutoscaler", base, [], "Healthy", { group: "autoscaling", version: "v2", info: ["Replicas: 2 / 3–12"] }),
    node("ing", "Ingress", base, [], "Healthy", { group: "networking.k8s.io", info: [`Host: ${base}.demo.example.com`] }),
  ];
}
function detail(name: string): ArgoApp {
  const row = apps.find((r) => r.name === name) ?? apps[0];
  const v = row.values;
  const nodes = tree(row.name);
  const bad = v.health === "Degraded";
  return {
    name: row.name, namespace: row.namespace, project: v.project,
    destination: { server: `https://${v.destination}.demo.ts.net`, name: v.destination, namespace: v.destNamespace, inCluster: false },
    sources: [{ repoUrl: "https://github.com/acme/platform-gitops.git", path: `apps/${v.destNamespace}/overlays/${row.labels.environment}`, chart: null, targetRevision: "main", ref: null, helmValueFiles: [] }],
    syncPolicy: { automated: true, prune: true, selfHeal: true, options: ["CreateNamespace=true", "PruneLast=true"] },
    syncStatus: v.sync, syncRevisions: [v.revision], health: v.health, healthMessage: bad ? "Deployment does not have minimum availability." : null,
    images: [`123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/${v.destNamespace}:8f31c7a`],
    conditions: bad ? [{ type: "SyncError", message: "one or more objects failed to apply: deployment exceeded its progress deadline", lastTransitionTime: ago(18) }] : [],
    operation: { phase: v.operation, message: bad ? "Deployment checkout exceeded its progress deadline" : "successfully synced (all tasks run)", startedAt: ago(24), finishedAt: ago(18), initiatedBy: "automated", revisions: [v.revision], failedResults: bad ? [{ group: "apps", kind: "Deployment", namespace: v.destNamespace, name: v.destNamespace, status: "SyncFailed", message: "deployment exceeded its progress deadline", hookPhase: null }] : [] },
    resources: nodes.map((n) => ({ group: n.group, version: n.version, kind: n.kind, namespace: n.namespace, name: n.name, status: v.sync, hook: false, requiresPruning: false })),
    history: [0, 1, 2, 3].map((i) => ({ id: 148 - i, revisions: [i === 0 ? v.revision : "b2a190fedcba1234567890abcdef1234567890ab"], deployedAt: ago(18 + i * 240), deployStartedAt: ago(20 + i * 240), initiatedBy: "automated" })),
    appSet: v.appSet, reconciledAt: ago(2), refreshRequested: null, operationInProgress: v.operation === "Running",
    raw: { apiVersion: "argoproj.io/v1alpha1", kind: "Application", metadata: { name: row.name, namespace: row.namespace, labels: row.labels }, spec: { project: v.project, destination: { name: v.destination, namespace: v.destNamespace } }, status: { sync: { status: v.sync }, health: { status: v.health } } },
  };
}

export const argocdSettings: Record<string, unknown> = { argocdServers: [{ name: "prod-argocd", url: URL }] };
export const argocdResources: Record<string, unknown[]> = {};
export function argocdMock(cmd: string, a: Record<string, any>): unknown {
  switch (cmd) {
    case "argocd_session": case "argocd_set_token": return { url: a.url, username: "platform-admin", version: "v2.14.4" };
    case "argocd_apps": return apps;
    case "argocd_appsets": return appsets;
    case "argocd_app": return detail(a.name);
    case "argocd_tree": return tree(a.name);
    case "argocd_forget_token": case "argocd_refresh": case "argocd_sync": return null;
    default: return undefined;
  }
}
