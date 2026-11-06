import { expect, it } from "vitest";
import type { ArgoTreeNode } from "../types";
import { networkGraph } from "./network";

const node = (kind: string, name: string): ArgoTreeNode => ({ uid: name, group: kind === "Ingress" ? "networking.k8s.io" : "", version: "v1", kind, name, namespace: "ns", parents: [], health: "Healthy", healthMessage: null, info: [], images: [], createdAt: null, networkingInfo: { targetLabels: {}, targetRefs: [], labels: {}, ingress: [], externalURLs: [] } });

it("layers external addresses, ingress, service and pods and matches refs and labels", () => {
  const ingress = node("Ingress", "web"); const service = node("Service", "backend"); const pod = node("Pod", "pod-a"); const other = node("Pod", "pod-b");
  ingress.networkingInfo!.externalURLs = ["https://example.test"];
  ingress.networkingInfo!.targetRefs = [{ group: "", version: "v1", kind: "Service", namespace: "ns", name: "backend", uid: null }];
  service.networkingInfo!.targetLabels = { app: "backend", tier: "web" };
  pod.networkingInfo!.labels = { app: "backend", tier: "web", extra: "yes" };
  other.networkingInfo!.labels = { app: "backend" };
  const graph = networkGraph([ingress, service, pod, other]);
  expect(graph.vertices.map(v => v.layer).sort()).toEqual([0, 1, 2, 3, 3]);
  const name = (id: string) => graph.vertices.find(v => v.id === id)!.label;
  expect(graph.edges.map(e => [name(e.from), name(e.to)])).toEqual([["https://example.test", "web"], ["web", "backend"], ["backend", "pod-a"]]);
});
