import type { K8sRules } from "./types";

export interface CanQuery {
  verb: string;
  group: string;
  resource: string;
  subresource?: string;
  name?: string;
}

const any = (list: string[], want: string) => list.includes("*") || list.includes(want);

function resourceMatches(resources: string[], resource: string, subresource: string | undefined): boolean {
  return resources.some((r) => {
    if (r === "*") return true;
    if (subresource === undefined) return r === resource;
    return r === `${resource}/${subresource}` || r === `${resource}/*`;
  });
}

/**
 * RBAC 규칙 목록으로 이 요청이 허용되는지 본다.
 * 하나라도 맞으면 yes, 아니면 목록이 불완전할 때 unknown, 그렇지 않으면 no.
 * resourceNames가 있는 규칙은 이름을 지정한 요청에만 맞는다(컬렉션 요청에는 맞지 않는다).
 */
export function can(rules: K8sRules, q: CanQuery): "yes" | "no" | "unknown" {
  const hit = rules.resourceRules.some(
    (r) =>
      any(r.verbs, q.verb) &&
      any(r.apiGroups, q.group) &&
      resourceMatches(r.resources, q.resource, q.subresource) &&
      (r.resourceNames.length === 0 || (q.name !== undefined && r.resourceNames.includes(q.name))),
  );
  if (hit) return "yes";
  return rules.incomplete ? "unknown" : "no";
}
