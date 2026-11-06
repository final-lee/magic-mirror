import { DEPLOYMENTS, PODS, SERVICES } from "../kinds";
import { buildRelationMap } from "./mapModel";
import type { K8sXray, XrayNode } from "./types";

const node = (over: Partial<XrayNode>): XrayNode => ({
  group: "", version: "v1", kind: "Pod", namespace: "prod", name: "web-1", edge: "owner", roles: [], current: false, presence: "found", status: null, problems: [], children: [], ...over,
});
const xray = (sections: K8sXray["sections"]): K8sXray => ({ sections, gaps: [], truncated: false, partial: [], nodes: 0 });
const columns = (m: ReturnType<typeof buildRelationMap>) => Object.fromEntries(m.nodes.map((n) => [`${n.kind}/${n.name}`, n.column]));
/** id는 `group/kind/namespace/name` */
const short = (id: string) => { const [, kind, , name] = id.split("/"); return `${kind}/${name}`; };
const arrows = (m: ReturnType<typeof buildRelationMap>) => m.edges.map((e) => `${short(e.from)} -${e.edge}-> ${short(e.to)}`);

test("a pod: owners to the left, what it points at to the right, what selects or targets it to the left", () => {
  const pod = { kind: PODS, namespace: "prod", name: "web-1" };
  const m = buildRelationMap(xray([
    { edge: "owner", nodes: [node({ group: "apps", kind: "Deployment", name: "web", children: [node({ group: "apps", kind: "ReplicaSet", name: "web-5d", children: [node({ name: "web-1", current: true, status: "Running" })] })] })] },
    { edge: "reference", nodes: [
      node({ kind: "ConfigMap", name: "cfg", edge: "reference", roles: ["volume"] }),
      node({ kind: "PersistentVolumeClaim", name: "data", edge: "reference", roles: ["volume"], children: [node({ kind: "PersistentVolume", name: "pv-1", namespace: null, edge: "reference" })] }),
    ] },
    { edge: "selector", nodes: [node({ kind: "Service", name: "web", edge: "selector" })] },
    { edge: "target", nodes: [node({ group: "discovery.k8s.io", kind: "EndpointSlice", name: "web-abc", edge: "target", children: [node({ kind: "Service", name: "web", edge: "target" })] })] },
  ]), pod);
  expect(columns(m)).toEqual({
    "Pod/web-1": 0, "Deployment/web": -2, "ReplicaSet/web-5d": -1, "ConfigMap/cfg": 1, "PersistentVolumeClaim/data": 1, "PersistentVolume/pv-1": 2,
    // 고르는 Service(-1)와 EndpointSlice 너머의 같은 Service(-2)는 한 노드로, 먼 열에
    "Service/web": -2, "EndpointSlice/web-abc": -1,
  });
  expect(arrows(m)).toEqual([
    "Deployment/web -owner-> ReplicaSet/web-5d",
    "ReplicaSet/web-5d -owner-> Pod/web-1",
    "Pod/web-1 -reference-> ConfigMap/cfg",
    "Pod/web-1 -reference-> PersistentVolumeClaim/data",
    "PersistentVolumeClaim/data -reference-> PersistentVolume/pv-1",
    "Service/web -selector-> Pod/web-1",
    "EndpointSlice/web-abc -target-> Pod/web-1",
    "Service/web -target-> EndpointSlice/web-abc",
  ]);
  // 지금 보는 객체는 트리에서 상태를 얻는다
  expect(m.nodes.find((n) => n.current)).toMatchObject({ name: "web-1", status: "Running" });
});

test("a config map: things using it sit to the left and point at it; roles merge on one edge without usedBy", () => {
  const m = buildRelationMap(xray([
    { edge: "reference", nodes: [node({ group: "apps", kind: "Deployment", name: "web", edge: "reference", roles: ["usedBy", "env"] })] },
  ]), { kind: { ...PODS, kind: "ConfigMap", plural: "configmaps" }, namespace: "prod", name: "cfg" });
  expect(columns(m)).toEqual({ "ConfigMap/cfg": 0, "Deployment/web": -1 });
  expect(m.edges).toEqual([expect.objectContaining({ edge: "reference", roles: ["env"] })]);
  expect(arrows(m)).toEqual(["Deployment/web -reference-> ConfigMap/cfg"]);
});

test("targets go outward from an Ingress and inward to a Deployment; a service selects pods to its right", () => {
  const ingress = buildRelationMap(xray([
    { edge: "target", nodes: [node({ kind: "Service", name: "web", edge: "target", children: [node({ name: "web-1", edge: "selector" })] })] },
  ]), { kind: { ...SERVICES, group: "networking.k8s.io", kind: "Ingress", plural: "ingresses" }, namespace: "prod", name: "web" });
  expect(columns(ingress)).toEqual({ "Ingress/web": 0, "Service/web": 1, "Pod/web-1": 2 });
  const deploy = buildRelationMap(xray([
    { edge: "target", nodes: [node({ group: "autoscaling", kind: "HorizontalPodAutoscaler", name: "web", edge: "target" })] },
    { edge: "selector", nodes: [node({ name: "web-1", edge: "selector" })] },
  ]), { kind: DEPLOYMENTS, namespace: "prod", name: "web" });
  expect(columns(deploy)).toEqual({ "Deployment/web": 0, "HorizontalPodAutoscaler/web": -1, "Pod/web-1": 1 });
  expect(arrows(deploy)).toEqual(["HorizontalPodAutoscaler/web -target-> Deployment/web", "Deployment/web -selector-> Pod/web-1"]);
});

test("another owner outside the chain points at the current object", () => {
  const m = buildRelationMap(xray([
    { edge: "owner", nodes: [
      node({ group: "apps", kind: "ReplicaSet", name: "rs", children: [node({ name: "web-1", current: true })] }),
      node({ group: "x.example.com", kind: "Gizmo", name: "g" }),
    ] },
  ]), { kind: PODS, namespace: "prod", name: "web-1" });
  expect(columns(m)).toEqual({ "Pod/web-1": 0, "ReplicaSet/rs": -1, "Gizmo/g": -1 });
  expect(arrows(m)).toContain("Gizmo/g -owner-> Pod/web-1");
});
