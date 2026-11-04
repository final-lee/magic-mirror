import { useMemo, useState } from "react";
import { PathLine } from "../access/paths";
import type { Cell, Grant, MappingRow, Subject } from "../access/types";
import { can } from "../can";
import { useK8sRules } from "../queries";
import type { K8sChange, K8sTarget } from "../types";
import { ActionButton } from "./ActionButton";
import { useCart } from "./cart";
import { RBAC_GROUP, bindingName, createBinding, deleteBinding, editSubjects, subjectSpecOf } from "./changes";
import * as t from "./text";
import { CART_MAX, type RbacSubjectSpec } from "./types";

/** 칸 종류마다 처음 제안하는 기본 ClusterRole. 권한 상승 칸은 비워 둬서 실수로 관리자 역할이 들어가지 않게 한다 */
const DEFAULT_ROLE: Record<Cell, string> = { read: "view", write: "edit", delete: "edit", exec: "edit", secretRead: "edit", rbacWrite: "admin", escalate: "" };

interface Props {
  target: K8sTarget;
  context: string | null;
  ssoProfile: string;
  subject: Subject;
  cell: Cell;
  /** 고른 열. null이면 클러스터 전체 */
  namespace: string | null;
  /** 이 칸의 권한을 주는 경로들 */
  grants: Grant[];
  /** IAM 주체의 매핑(바인딩의 사용자 이름을 알려 준다) */
  mapping?: MappingRow;
  onStart: (change: K8sChange) => void;
}

interface Path {
  key: string;
  grant: Grant;
  binding: { namespace: string | null; name: string };
  /** 이 경로에서 바인딩의 주체로 빼야 하는 항목. 빼지 못하는 경로(access policy, 세션 이름 템플릿 등)는 null */
  removable: RbacSubjectSpec | null;
}

/** 이 경로가 바인딩에 나오는 방식에 맞는 주체: 직접이면 주체 자신(IAM은 매핑의 사용자 이름), 그룹이면 그 그룹 */
function removableSubject(grant: Grant, subject: Subject, mapping: MappingRow | undefined): RbacSubjectSpec | null {
  if (grant.source.sessionDependent) return null;
  const via = grant.source.via;
  if (via.kind === "group" || via.kind === "defaultGroup") return { kind: "Group", name: via.group };
  if (via.kind !== "direct") return null;
  if (subject.kind !== "iam") return subjectSpecOf(subject);
  return mapping && !mapping.username.includes("{{") ? { kind: "User", name: mapping.username } : null;
}

/**
 * 권한 표 칸 상세의 "권한 바꾸기": 이 칸의 권한을 주는 바인딩에서 주체를 빼거나 바인딩을 지우는 변경과, ClusterRole을 주는 새 바인딩을
 * 장바구니에 담거나 바로 미리보기한다. 권한이 확실히 없으면 이유와 함께 끈다.
 */
export function CellActions({ target, context, ssoProfile, subject, cell, namespace, grants, mapping, onStart }: Props) {
  const cart = useCart(target);
  const rules = useK8sRules(target, context, namespace ?? "default", ssoProfile, true);
  const [role, setRole] = useState(DEFAULT_ROLE[cell]);
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const paths: Path[] = useMemo(() => {
    const seen = new Set<string>();
    const out: Path[] = [];
    for (const grant of grants) {
      const b = grant.source.binding;
      if (!b) continue;
      const key = `${b.kind}|${b.namespace}|${b.name}|${JSON.stringify(grant.source.via)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, grant, binding: { namespace: b.kind === "ClusterRoleBinding" ? null : b.namespace, name: b.name }, removable: removableSubject(grant, subject, mapping) });
    }
    return out;
  }, [grants, subject, mapping]);

  const denied = (verb: string, plural: string, name?: string) =>
    rules.data && can(rules.data, { verb, group: RBAC_GROUP, resource: plural, ...(name ? { name } : {}) }) === "no" ? t.BINDING_DENIED(verb, plural) : undefined;
  const addToCart = (change: K8sChange) => {
    const result = cart.add(change);
    setNote(result === "added" ? t.CART_ADDED(cart.changes.length + 1, CART_MAX) : result === "duplicate" ? t.CART_DUPLICATE : t.CART_FULL(CART_MAX));
  };

  const spec = subjectSpecOf(subject);
  const cluster = namespace === null;
  const roleName = role.trim();
  const bindingTarget = { namespace, name: (nameEdit ?? (spec && roleName ? bindingName(spec, roleName) : "")).trim() };
  const grantPlural = cluster ? "clusterrolebindings" : "rolebindings";
  const grantReason = !roleName ? t.CELL_GRANT_ROLE_EMPTY : !bindingTarget.name ? t.CELL_GRANT_ROLE_EMPTY : denied("create", grantPlural);
  const grantChange = spec && !grantReason ? createBinding(bindingTarget, { kind: "ClusterRole", name: roleName }, [spec]) : null;

  return (
    <section className="rbac-cell" aria-label={t.CELL_CHANGE_TITLE}>
      <h5 className="acc-h">{t.CELL_CHANGE_TITLE}</h5>
      {paths.length > 0 && (
        <>
          <p className="dim">{t.CELL_PATHS_HINT}</p>
          <ul className="rbac-cell-paths" aria-label={t.CELL_PATHS_HINT}>
            {paths.map((p) => {
              const plural = p.binding.namespace === null ? "clusterrolebindings" : "rolebindings";
              return (
                <li key={p.key}>
                  <PathLine grant={p.grant} />
                  <span className="rbac-cell-actions">
                    <ActionButton
                      tone="warn"
                      reason={p.removable ? denied("patch", plural, p.binding.name) : t.CELL_NO_SUBJECT_REMOVE}
                      onClick={() => p.removable && addToCart(editSubjects(p.binding, [], [p.removable]))}
                    >
                      {t.CELL_REMOVE_SUBJECT}
                    </ActionButton>
                    <ActionButton tone="secondary" reason={denied("delete", plural, p.binding.name)} onClick={() => addToCart(deleteBinding(p.binding))}>
                      {t.CELL_DELETE_BINDING}
                    </ActionButton>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <h5 className="acc-h">{t.CELL_GRANT_TITLE}</h5>
      {spec ? (
        <div className="rbac-grant">
          <p className="dim">{t.cellGrantHint(cluster, namespace)}</p>
          <label>
            {t.CELL_GRANT_ROLE} <input className="mono" value={role} onChange={(e) => setRole(e.target.value)} />
          </label>
          <label>
            {t.CELL_GRANT_NAME} <input className="mono" value={bindingTarget.name} onChange={(e) => setNameEdit(e.target.value)} />
          </label>
          <span className="rbac-cell-actions">
            <ActionButton tone="primary" reason={grantReason} onClick={() => grantChange && onStart(grantChange)}>
              {t.CELL_GRANT_PREVIEW}
            </ActionButton>
            <ActionButton tone="secondary" reason={grantReason} onClick={() => grantChange && addToCart(grantChange)}>
              {t.CELL_GRANT_ADD}
            </ActionButton>
          </span>
        </div>
      ) : (
        <p className="dim">{t.CELL_GRANT_IAM}</p>
      )}
      {note && <p role="status" className="dim">{note}</p>}
    </section>
  );
}
