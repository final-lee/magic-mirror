import type { ArgoWfLink, WfNode, WfRow } from "./types";

/** 컨트롤러 설정의 links 중 이 자리(scope)의 것 */
export const linksFor = (links: readonly ArgoWfLink[], scope: string): ArgoWfLink[] => links.filter((l) => l.scope === scope);

/**
 * Argo UI의 `processURL`과 같은 자리 바꿈: `${a.b.c}`(또는 `$%7B…%7D`)를 vars의 `a.b.c`로 바꾼다.
 * Argo는 모르는 변수를 "null"로 찍지만 여기서는 빈 글로 둔다.
 */
export const expandLink = (link: ArgoWfLink, vars: Record<string, string>): string =>
  link.url.replace(/(?:\$\{|\$%7B)([^}%]*?)(?:\}|%7D)/g, (_, name: string) => vars[name.replace(/\s/g, "")] ?? "");

const epoch = (iso: string | null) => String(iso ? Date.parse(iso) : Date.now());

/** 레이블·어노테이션은 `prefix.labels.<키>` 모양이고 키에 점이 들어 있어도 그대로 한 키다 */
function addMeta(out: Record<string, string>, prefix: string, labels: Record<string, string>, annotations: Record<string, string>) {
  for (const [k, v] of Object.entries(labels)) out[`${prefix}labels.${k}`] = v;
  for (const [k, v] of Object.entries(annotations)) out[`${prefix}annotations.${k}`] = v;
}

/** workflow·workflow-list 범위 링크의 변수: `${metadata.name}`, `${status.startedAt}`, `${workflow.metadata.name}` … */
export function workflowLinkVars(row: WfRow): Record<string, string> {
  const out: Record<string, string> = {
    "metadata.name": row.name,
    "metadata.namespace": row.namespace,
    "metadata.uid": row.uid,
    "status.phase": row.phase,
    "status.startedAt": row.startedAt ?? "",
    "status.finishedAt": row.finishedAt ?? "",
    "status.startedAtEpoch": epoch(row.startedAt),
    "status.finishedAtEpoch": epoch(row.finishedAt),
    "workflow.metadata.name": row.name,
    "workflow.metadata.namespace": row.namespace,
    "workflow.metadata.uid": row.uid,
    "workflow.status.phase": row.phase,
    "workflow.status.startedAt": row.startedAt ?? "",
    "workflow.status.finishedAt": row.finishedAt ?? "",
  };
  addMeta(out, "metadata.", row.labels, row.annotations);
  addMeta(out, "workflow.metadata.", row.labels, row.annotations);
  return out;
}

/** pod·pod-logs 범위 링크의 변수: metadata는 Pod 것, 시각은 노드 것, `workflow.*`는 Workflow 것 */
export function podLinkVars(row: WfRow, node: WfNode): Record<string, string> {
  const out = workflowLinkVars(row);
  for (const key of Object.keys(out)) if (!key.startsWith("workflow.")) delete out[key];
  out["metadata.name"] = node.podName ?? node.name;
  out["metadata.namespace"] = row.namespace;
  out["status.startedAt"] = node.startedAt ?? "";
  out["status.finishedAt"] = node.finishedAt ?? "";
  out["status.startedAtEpoch"] = epoch(node.startedAt);
  out["status.finishedAtEpoch"] = epoch(node.finishedAt);
  return out;
}
