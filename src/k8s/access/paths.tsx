import type { Grant, Subject, Via } from "./types";
import { SCOPE_CLUSTER, SESSION_DEPENDENT, VIA_DIRECT, aggregatedFrom, scopeNamespace, subjectName, viaBuiltin, viaDefault, viaGroup, viaPolicy } from "./text";

export function viaText(via: Via): string {
  switch (via.kind) {
    case "direct":
      return VIA_DIRECT;
    case "group":
      return viaGroup(via.group);
    case "defaultGroup":
      return viaDefault(via.group);
    case "accessPolicy":
      return viaPolicy(via.policy.split("/").pop() ?? via.policy);
    case "builtin":
      return viaBuiltin(via.group);
  }
}

/** 같은 경로(범위·방법·바인딩·역할·합쳐 준 역할)를 하나로 묶는 키 */
export const pathKey = (g: Grant) => JSON.stringify([g.namespace, g.source.via, g.source.binding, g.source.role, g.source.aggregatedFrom, g.source.sessionDependent]);

/** 규칙은 달라도 경로가 같은 권한을 하나로 줄인다(처음 나온 순서 유지) */
export function uniquePaths(grants: Grant[]): Grant[] {
  const seen = new Set<string>();
  const out: Grant[] = [];
  for (const g of grants) {
    const k = pathKey(g);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
}

/** 경로 한 줄: 방법 → 바인딩 → 역할 · 범위 */
export function PathLine({ grant }: { grant: Grant }) {
  const { source } = grant;
  const binding = source.binding ? `${source.binding.kind} ${source.binding.namespace ? `${source.binding.namespace}/` : ""}${source.binding.name}` : null;
  const role = source.role ? `${source.role.kind} ${source.role.name}` : null;
  return (
    <span className="acc-path">
      <span className="acc-via">{viaText(source.via)}</span>
      {binding && <span className="mono">{binding}</span>}
      {binding && role && <span className="dim" aria-hidden="true">→</span>}
      {role && <span className="mono">{role}</span>}
      {source.aggregatedFrom && <span className="dim">({aggregatedFrom(source.aggregatedFrom)})</span>}
      <span className="dim">· {grant.namespace === null ? SCOPE_CLUSTER : scopeNamespace(grant.namespace)}</span>
      {source.sessionDependent && <span className="acc-badge warn">{SESSION_DEPENDENT}</span>}
    </span>
  );
}

export function PathList({ grants, label }: { grants: Grant[]; label: string }) {
  const paths = uniquePaths(grants);
  return (
    <ul className="acc-paths" aria-label={label}>
      {paths.map((g) => (
        <li key={pathKey(g)}>
          <PathLine grant={g} />
        </li>
      ))}
    </ul>
  );
}

/** IAM 주체는 ARN이 길어서 이름(SSO면 권한 세트 이름)을 보이고 ARN은 마우스를 올리면 보인다 */
export function SubjectName({ subject, label }: { subject: Subject; label?: string | null }) {
  const shown = subject.kind === "iam" ? label || subject.name.split("/").pop() || subject.name : subjectName(subject);
  return (
    <span className="acc-subject">
      <span className={`acc-kind k-${subject.kind}`}>{kindShort(subject)}</span>
      <span className="mono acc-name" title={subject.name}>{shown}</span>
    </span>
  );
}

const SHORT: Record<Subject["kind"], string> = { iam: "IAM", user: "사용자", group: "그룹", serviceAccount: "SA" };
const kindShort = (s: Subject) => SHORT[s.kind];
