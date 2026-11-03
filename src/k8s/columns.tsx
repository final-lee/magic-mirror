import type { ListColumn } from "../iam/ListTable";
import { age } from "./format";
import { BUILTIN } from "./kinds";
import { kindKey } from "./targets";
import { COL_AGE, COL_NAME, COL_NAMESPACE, COL_PROBLEMS, COLUMN_LABELS, PROBLEM_LABELS } from "./text";
import type { K8sKindRef, K8sProblem, K8sRow } from "./types";

/** 종류별 값 열. 키는 백엔드 read/values.rs가 채우는 키다. */
const KIND_COLUMNS: Record<string, string[]> = {
  "/v1/pods": ["ready", "status", "restarts", "node", "ip"],
  "apps/v1/deployments": ["ready", "upToDate", "available"],
  "apps/v1/statefulsets": ["ready"],
  "apps/v1/daemonsets": ["desired", "current", "ready", "upToDate", "available"],
  "apps/v1/replicasets": ["desired", "current", "ready"],
  "batch/v1/jobs": ["completions", "status"],
  "batch/v1/cronjobs": ["schedule", "suspend", "active", "lastSchedule"],
  "/v1/services": ["type", "clusterIp", "externalIp", "ports"],
  "networking.k8s.io/v1/ingresses": ["class", "hosts", "address"],
  "networking.k8s.io/v1/networkpolicies": ["podSelector", "policyTypes"],
  "/v1/endpoints": ["endpoints"],
  "/v1/configmaps": ["keys"],
  "/v1/secrets": ["type", "keys"],
  "/v1/serviceaccounts": ["roleArn"],
  "/v1/persistentvolumeclaims": ["status", "volume", "capacity", "accessModes", "storageClass"],
  "/v1/persistentvolumes": ["capacity", "accessModes", "reclaimPolicy", "status", "claim", "storageClass"],
  "storage.k8s.io/v1/storageclasses": ["provisioner", "reclaimPolicy", "volumeBindingMode", "default"],
  "/v1/namespaces": ["status"],
  "/v1/nodes": ["status", "version", "instanceType", "zone", "group"],
  "autoscaling/v2/horizontalpodautoscalers": ["target", "min", "max", "current", "desired", "metrics"],
  "policy/v1/poddisruptionbudgets": ["minAvailable", "maxUnavailable", "disruptionsAllowed", "healthy"],
  "discovery.k8s.io/v1/endpointslices": ["addressType", "endpointReady", "ports"],
  "networking.k8s.io/v1/ingressclasses": ["controller", "default"],
  "/v1/resourcequotas": ["quota"],
  "/v1/limitranges": ["limits"],
  "rbac.authorization.k8s.io/v1/roles": ["ruleCount"],
  "rbac.authorization.k8s.io/v1/clusterroles": ["ruleCount", "aggregation"],
  "rbac.authorization.k8s.io/v1/rolebindings": ["roleRef", "subjects"],
  "rbac.authorization.k8s.io/v1/clusterrolebindings": ["roleRef", "subjects"],
  "scheduling.k8s.io/v1/priorityclasses": ["value", "globalDefault", "preemption"],
  "node.k8s.io/v1/runtimeclasses": ["handler"],
  "coordination.k8s.io/v1/leases": ["holder", "renewTime"],
  "admissionregistration.k8s.io/v1/mutatingwebhookconfigurations": ["webhookCount", "failurePolicy"],
  "admissionregistration.k8s.io/v1/validatingwebhookconfigurations": ["webhookCount", "failurePolicy"],
  "apiextensions.k8s.io/v1/customresourcedefinitions": ["apiGroup", "versions", "scope", "established"],
};

/** 내장 종류는 표대로, 그 밖의 종류(사용자 정의)는 Ready 조건 하나 */
export function valueKeys(kind: K8sKindRef): string[] {
  const builtin = BUILTIN.find((b) => b.group === kind.group && b.plural === kind.plural);
  const known = KIND_COLUMNS[kindKey(kind)] ?? (builtin && KIND_COLUMNS[kindKey(builtin)]);
  if (known) return known;
  return builtin ? [] : ["ready"];
}

export function Problems({ problems }: { problems: K8sProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <span className="k8s-problems">
      {problems.map((p) => (
        <span key={p} className="k8s-problem">
          {PROBLEM_LABELS[p]}
        </span>
      ))}
    </span>
  );
}

export function columnsFor(kind: K8sKindRef, showNamespace: boolean, now: number): ListColumn<K8sRow>[] {
  const cols: ListColumn<K8sRow>[] = [{ key: "name", label: COL_NAME, render: (r) => <span className="mono">{r.name}</span>, sort: (r) => r.name }];
  if (showNamespace && kind.namespaced) cols.push({ key: "namespace", label: COL_NAMESPACE, render: (r) => r.namespace ?? "", sort: (r) => r.namespace ?? "" });
  for (const key of valueKeys(kind)) {
    cols.push({ key: `v:${key}`, label: COLUMN_LABELS[key] ?? key, render: (r) => r.values[key] ?? "", sort: (r) => r.values[key] ?? null });
  }
  cols.push({ key: "problems", label: COL_PROBLEMS, render: (r) => <Problems problems={r.problems} />, sort: (r) => r.problems.length });
  cols.push({ key: "age", label: COL_AGE, render: (r) => age(r.createdAt, now), sort: (r) => (r.createdAt ? Date.parse(r.createdAt) : null) });
  return cols;
}
