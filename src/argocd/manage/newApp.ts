import { parseDocument } from "yaml";
import { envOf } from "../argoEnv";
import type { ArgoTarget } from "../change/types";
import type { ArgoAppRow } from "../types";
import type { Obj } from "./specForm";
import { gateYaml, type YamlGate } from "./yamlGate";
import { MANAGE_CREATE_NAME, MANAGE_CREATE_NOT_APP, MANAGE_CREATE_NO_SPEC } from "./text";

const DEFAULT_NAMESPACE = "argocd";

/** 목록에서 뽑은 대상 클러스터와 네임스페이스 한 쌍 */
export interface DestinationChoice {
  cluster: string;
  namespace: string;
}

const countBy = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
};

/** 앱이 가장 많이 있는 네임스페이스(ArgoCD가 앱을 두는 곳). 앱이 없으면 argocd */
export function appNamespaceOf(rows: ArgoAppRow[]): string {
  const counts = countBy(rows.map((r) => r.namespace).filter(Boolean));
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? DEFAULT_NAMESPACE;
}

export const projectsOf = (rows: ArgoAppRow[]): string[] => [...new Set(rows.map((r) => r.values.project).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b));

/** 목록 행의 (클러스터, 네임스페이스) 조합. 많이 쓰는 것이 앞이다 */
export function destinationsOf(rows: ArgoAppRow[]): DestinationChoice[] {
  const keyed = rows.filter((r) => r.values.destination).map((r) => JSON.stringify([r.values.destination, r.values.destNamespace ?? ""]));
  return [...countBy(keyed)]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => {
      const [cluster, namespace] = JSON.parse(key) as [string, string];
      return { cluster, namespace };
    });
}

/** 새 Application의 YAML 틀 */
export function appTemplate(rows: ArgoAppRow[]): string {
  const project = projectsOf(rows).includes("default") ? "default" : (projectsOf(rows)[0] ?? "default");
  return [
    "apiVersion: argoproj.io/v1alpha1",
    "kind: Application",
    "metadata:",
    "  name: my-app",
    `  namespace: ${appNamespaceOf(rows)}`,
    "spec:",
    `  project: ${project}`,
    "  source:",
    "    repoURL: https://github.com/example/repo.git",
    "    targetRevision: HEAD",
    "    path: .",
    "  destination:",
    "    server: https://kubernetes.default.svc",
    "    namespace: default",
    "  syncPolicy:",
    "    syncOptions:",
    "      - CreateNamespace=true",
    "",
  ].join("\n");
}

/** 구문이 틀린 글은 건드리지 않는다 */
function editDoc(text: string, edit: (set: (path: string[], value: unknown) => void, remove: (path: string[]) => void) => void): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return text;
  edit((path, value) => doc.setIn(path, value), (path) => doc.deleteIn(path));
  return doc.toString();
}

export const withProject = (text: string, project: string) => editDoc(text, (set) => set(["spec", "project"], project));

/** 클러스터 이름이거나 주소(http로 시작)다. 이름이면 destination.name, 주소면 destination.server에 쓴다 */
export function withDestination(text: string, choice: DestinationChoice): string {
  const byServer = /^https?:\/\//.test(choice.cluster);
  return editDoc(text, (set, remove) => {
    remove(["spec", "destination", byServer ? "name" : "server"]);
    set(["spec", "destination", byServer ? "server" : "name"], choice.cluster);
    if (choice.namespace) set(["spec", "destination", "namespace"], choice.namespace);
  });
}

export interface CreateGate extends YamlGate {
  target: ArgoTarget | null;
}

/** 만들기 전에 YAML이 Application으로서 최소한 갖춘 것(구문·kind·이름·spec)과 쓰기 대상 */
export function gateCreate(text: string, rows: ArgoAppRow[]): CreateGate {
  const gate = gateYaml(text);
  const none = (reason: string): CreateGate => ({ ok: false, reason, value: gate.value, target: null });
  if (!gate.ok || !gate.value) return { ...gate, target: null };
  const doc = gate.value;
  const meta = (doc.metadata ?? {}) as Obj;
  const spec = (doc.spec ?? null) as Obj | null;
  if (doc.kind !== "Application") return none(MANAGE_CREATE_NOT_APP);
  if (typeof meta.name !== "string" || meta.name.trim() === "") return none(MANAGE_CREATE_NAME);
  if (spec === null || typeof spec !== "object") return none(MANAGE_CREATE_NO_SPEC);
  const namespace = typeof meta.namespace === "string" && meta.namespace !== "" ? meta.namespace : appNamespaceOf(rows);
  const destination = (spec.destination ?? {}) as Obj;
  const labels = (meta.labels ?? {}) as Record<string, string>;
  const env = envOf({ name: meta.name, namespace, resourceVersion: "", labels, values: { destNamespace: String(destination.namespace ?? ""), destination: String(destination.name ?? destination.server ?? "") } }).env;
  return { ...gate, target: { namespace, name: meta.name, project: typeof spec.project === "string" && spec.project !== "" ? spec.project : "default", env } };
}
