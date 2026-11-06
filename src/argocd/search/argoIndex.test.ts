import type { ArgoAppRow, ArgoResourceRef, ArgoTreeNode } from "../types";
import { NO_FILTERS, buildIndex, countBy, filterEntries, healthOf, searchEntries, type IndexEntry, type SearchFilters } from "./argoIndex";

const res = (kind: string, name: string, extra: Partial<ArgoResourceRef> = {}): ArgoResourceRef => ({ group: kind === "Deployment" ? "apps" : "", version: "v1", kind, name, ...extra });
const app = (name: string, resources: ArgoResourceRef[], destination = "prod-eks"): ArgoAppRow => ({
  name,
  namespace: "argocd",
  resourceVersion: "1",
  values: { destination },
  labels: {},
  resources,
});
const node = (kind: string, name: string, namespace: string | null, health: string | null = null): ArgoTreeNode => ({
  uid: `${kind}/${name}`,
  group: kind === "Deployment" ? "apps" : kind === "ReplicaSet" ? "apps" : "",
  version: "v1",
  kind,
  namespace,
  name,
  parents: [],
  health,
  healthMessage: null,
  info: [],
  images: [],
  createdAt: null,
});
const find = (entries: IndexEntry[], kind: string, name: string, cluster?: string) => entries.find((e) => e.kind === kind && e.name === name && (cluster === undefined || e.cluster === cluster));
const filters = (patch: Partial<SearchFilters>): SearchFilters => ({ ...NO_FILTERS, ...patch });

describe("buildIndex", () => {
  test("the same resource in the same cluster is one entry that knows every app, across apps and trees", () => {
    const apps = [
      app("web", [res("Deployment", "api", { namespace: "shop", status: "Synced", health: "Healthy" })]),
      app("web-canary", [res("Deployment", "api", { namespace: "shop", status: "OutOfSync" })]),
    ];
    const entries = buildIndex(apps, [{ app: { namespace: "argocd", name: "web" }, nodes: [node("Deployment", "api", "shop", "Degraded")] }]);
    expect(entries).toHaveLength(1);
    expect(entries[0].refs.map((r) => r.app.name)).toEqual(["web", "web-canary"]);
    // 목록의 값이 먼저고, 트리는 비어 있는 칸만 채운다
    expect(entries[0].health).toBe("Healthy");
    expect(entries[0].sync).toBe("Synced");
    expect(entries[0].duplicate).toBe(true);
  });

  test("the same name in a different cluster, namespace or kind stays separate; in-cluster spellings collapse", () => {
    const entries = buildIndex(
      [
        app("a", [res("ConfigMap", "settings", { namespace: "x" })], "https://kubernetes.default.svc"),
        app("b", [res("ConfigMap", "settings", { namespace: "x" })], "in-cluster"),
        app("c", [res("ConfigMap", "settings", { namespace: "x" })], "other-eks"),
        app("d", [res("ConfigMap", "settings", { namespace: "y" }), res("Secret", "settings", { namespace: "x" })]),
      ],
      [],
    );
    expect(entries).toHaveLength(4);
    const merged = entries.find((e) => e.cluster === "in-cluster")!;
    expect(merged.refs.map((r) => r.app.name)).toEqual(["a", "b"]);
    expect(merged.duplicate).toBe(true);
    expect(entries.filter((e) => e.duplicate)).toHaveLength(1);
  });

  test("children found only in an opened tree are indexed under that app but never count as managed", () => {
    const entries = buildIndex([app("web", [res("Deployment", "api", { namespace: "shop" })]), app("web2", [res("Deployment", "api2", { namespace: "shop" })])], [
      { app: { namespace: "argocd", name: "web" }, nodes: [node("Deployment", "api", "shop", "Healthy"), node("Pod", "api-1", "shop", "Healthy")] },
      { app: { namespace: "argocd", name: "web2" }, nodes: [node("Pod", "api-1", "shop", "Healthy")] },
      // 앱 목록에서 사라진 앱의 트리는 무시한다
      { app: { namespace: "argocd", name: "gone" }, nodes: [node("Pod", "ghost", "shop")] },
    ]);
    const pod = find(entries, "Pod", "api-1")!;
    expect(pod.managed).toBe(false);
    expect(pod.refs.map((r) => r.app.name)).toEqual(["web", "web2"]);
    expect(pod.duplicate).toBe(false);
    expect(find(entries, "Pod", "ghost")).toBeUndefined();
    expect(find(entries, "Deployment", "api")!.managed).toBe(true);
  });

  test("hooks do not make a duplicate, and a resource with no namespace is cluster scoped", () => {
    const entries = buildIndex([app("a", [res("Job", "migrate", { namespace: "x", hook: true }), res("Namespace", "x")]), app("b", [res("Job", "migrate", { namespace: "x", hook: true }), res("Namespace", "x")])], []);
    expect(find(entries, "Job", "migrate")!.duplicate).toBe(false);
    expect(find(entries, "Namespace", "x")!.namespace).toBeNull();
    expect(find(entries, "Namespace", "x")!.duplicate).toBe(true);
  });

  test("apps without a resources summary add nothing", () => {
    expect(buildIndex([{ name: "bare", namespace: "argocd", resourceVersion: "1", values: {}, labels: {} }], [])).toEqual([]);
  });
});

describe("search and filters", () => {
  const entries = buildIndex(
    [
      app("web", [res("Deployment", "api", { namespace: "shop", status: "Synced", health: "Healthy" }), res("Service", "api", { namespace: "shop", status: "Synced", health: "Healthy" }), res("Namespace", "shop", { status: "Synced" })]),
      app("worker", [res("Deployment", "queue", { namespace: "jobs", status: "OutOfSync", health: "Degraded" }), res("Service", "api", { namespace: "shop", status: "Synced" })]),
      app("legacy", [res("Deployment", "api", { namespace: "shop", status: "Synced", health: "Healthy" })], "old-cluster"),
    ],
    [],
  );
  const names = (list: IndexEntry[]) => list.map((e) => `${e.kind}/${e.name}@${e.cluster}`);

  test("fuzzy search ranks by name first and also matches kind, namespace and app name", () => {
    expect(names(searchEntries(entries, "api"))).toEqual(expect.arrayContaining(["Deployment/api@prod-eks", "Service/api@prod-eks", "Deployment/api@old-cluster"]));
    expect(names(searchEntries(entries, "queue"))).toEqual(["Deployment/queue@prod-eks"]);
    expect(names(searchEntries(entries, "service worker"))).toEqual(["Service/api@prod-eks"]);
    expect(searchEntries(entries, "jobs").map((e) => e.name)).toEqual(["queue"]);
    // 검색어가 없으면 종류·네임스페이스·이름 순
    expect(searchEntries(entries, "").map((e) => e.kind)).toEqual(["Deployment", "Deployment", "Deployment", "Namespace", "Service"]);
  });

  test("filters of one kind OR together and different kinds AND together", () => {
    expect(names(filterEntries(entries, filters({ kinds: new Set(["Deployment", "Service"]), clusters: new Set(["prod-eks"]) })))).toHaveLength(3);
    expect(filterEntries(entries, filters({ kinds: new Set(["Deployment"]), health: new Set(["Healthy"]) })).map((e) => e.cluster).sort()).toEqual(["old-cluster", "prod-eks"]);
    expect(filterEntries(entries, filters({ sync: new Set(["OutOfSync"]), namespaces: new Set(["jobs"]) })).map((e) => e.name)).toEqual(["queue"]);
    // 클러스터 범위 리소스는 빈 네임스페이스 값으로 고른다
    expect(filterEntries(entries, filters({ namespaces: new Set([""]) })).map((e) => e.name)).toEqual(["shop"]);
  });

  test("resources without health are bucketed as Unknown like the app list does", () => {
    const namespace = find(entries, "Namespace", "shop")!;
    expect(healthOf(namespace)).toBe("Unknown");
    expect(filterEntries(entries, filters({ health: new Set(["Unknown"]) })).map((e) => e.kind)).toEqual(["Namespace"]);
  });

  test("the duplicates filter keeps only resources several apps manage, combined with the rest", () => {
    const dup = filterEntries(entries, filters({ duplicatesOnly: true }));
    expect(names(dup)).toEqual(["Service/api@prod-eks"]);
    expect(filterEntries(entries, filters({ duplicatesOnly: true, kinds: new Set(["Deployment"]) }))).toEqual([]);
  });

  test("skipping a filter lets its own counts ignore its own choice", () => {
    const picked = filters({ kinds: new Set(["Service"]), clusters: new Set(["prod-eks"]) });
    expect(Object.fromEntries(countBy(filterEntries(entries, picked, ["kinds"]), (e) => e.kind))).toEqual({ Deployment: 2, Namespace: 1, Service: 1 });
  });
});
