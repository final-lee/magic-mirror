import type { K8sRules } from "./types";
import { ALL_NAMESPACES_NOTE, CORE_GROUP, HEADER_API_GROUP, HEADER_NAME, HEADER_RESOURCE, HEADER_VERBS, RULES_INCOMPLETE, WILDCARD } from "./text";

const show = (v: string) => (v === "*" ? WILDCARD : v === "" ? CORE_GROUP : v);

interface Row {
  key: string;
  verbs: string;
  group: string;
  resource: string;
  names: string;
}

/** 규칙 하나를 (API 그룹 × 리소스)마다 한 줄로 푼다 */
function rowsOf(rules: K8sRules): Row[] {
  const out: Row[] = [];
  rules.resourceRules.forEach((r, i) => {
    const verbs = r.verbs.map(show).join(", ");
    const names = r.resourceNames.length === 0 ? WILDCARD : r.resourceNames.join(", ");
    for (const g of r.apiGroups) {
      for (const res of r.resources) {
        out.push({ key: `${i}|${g}|${res}`, verbs, group: show(g), resource: res === "*" ? WILDCARD : res, names });
      }
    }
  });
  return out;
}

interface Props {
  rules: K8sRules;
  /** 모든 네임스페이스를 골라서 default 기준으로 보여 주는 중 */
  allNamespaces: boolean;
}

export function MyRules({ rules, allNamespaces }: Props) {
  const rows = rowsOf(rules);
  return (
    <div className="k8s-rules">
      {allNamespaces && <p className="dim">{ALL_NAMESPACES_NOTE}</p>}
      {rules.incomplete && <p className="dim">{RULES_INCOMPLETE}</p>}
      <table className="k8s-table">
        <thead>
          <tr>
            <th>{HEADER_VERBS}</th>
            <th>{HEADER_API_GROUP}</th>
            <th>{HEADER_RESOURCE}</th>
            <th>{HEADER_NAME}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="mono">{r.verbs}</td>
              <td className="mono">{r.group}</td>
              <td className="mono">{r.resource}</td>
              <td className="mono">{r.names}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
