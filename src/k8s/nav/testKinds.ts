import { CRDS, DEPLOYMENTS, NODES, PODS, SECRETS, SERVICES } from "../kinds";
import { NAMESPACES } from "../targets";
import type { K8sKind, K8sKindRef } from "../types";


const served = (ref: K8sKindRef, shortNames: string[], singularName: string): K8sKind => ({ ...ref, verbs: ["list", "watch"], custom: false, shortNames, singularName });

/** 클러스터가 알려 주는 모양의 종류 목록(시험용) */
export const TEST_KINDS: K8sKind[] = [
  served(PODS, ["po"], "pod"),
  served(DEPLOYMENTS, ["deploy"], "deployment"),
  served(SERVICES, ["svc"], "service"),
  served(NODES, ["no"], "node"),
  served(NAMESPACES, ["ns"], "namespace"),
  served(SECRETS, [], "secret"),
  served(CRDS, ["crd", "crds"], "customresourcedefinition"),
  { group: "", version: "v1", kind: "Event", plural: "events", namespaced: true, verbs: [], custom: false, shortNames: ["ev"], singularName: "event" },
];
