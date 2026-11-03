import type { AccessQuery } from "./types";

/**
 * kubectl처럼 쓴 리소스 글(`pods`, `deployments.apps`, `pods/exec`, `widgets.mm.example.com/status`)을 API 그룹·리소스·하위 리소스로 나눈다.
 * 첫 점 앞이 리소스 이름이고 나머지가 그룹이다. 빈 글이면 null.
 */
export function parseResource(text: string): { group: string; resource: string; subresource: string | null } | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const [head, ...rest] = trimmed.split("/");
  const sub = rest.join("/");
  const dot = head.indexOf(".");
  const resource = dot < 0 ? head : head.slice(0, dot);
  const group = dot < 0 ? "" : head.slice(dot + 1);
  if (resource === "") return null;
  return { group, resource, subresource: sub === "" ? null : sub };
}

export function buildQuery(verb: string, resource: string, namespace: string | null, name: string): AccessQuery | null {
  const parsed = parseResource(resource);
  const v = verb.trim();
  if (!parsed || v === "") return null;
  return { verb: v, ...parsed, namespace: namespace === "" ? null : namespace, name: name.trim() === "" ? null : name.trim() };
}
