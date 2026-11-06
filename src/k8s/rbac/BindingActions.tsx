import { useEffect, useMemo, useState } from "react";
import { parse } from "yaml";
import { can } from "../can";
import type { K8sChange, K8sObjectView, K8sRules, K8sTarget, ObjectRef } from "../types";
import { ActionButton } from "./ActionButton";
import { useCart } from "./cart";
import { RBAC_GROUP, deleteBinding, editSubjects } from "./changes";
import * as t from "./text";
import { CART_MAX, type RbacSubjectSpec } from "./types";

interface Props {
  target: K8sTarget;
  objectRef: ObjectRef;
  view: K8sObjectView;
  rules: K8sRules | undefined;
  /** 변경 하나를 바로 미리보기한다(공통 변경 틀) */
  onStart: (change: K8sChange) => void;
}

/** 바인딩 YAML의 주체들. 알 수 없는 모양은 건너뛴다 */
function subjectsOf(yaml: string): RbacSubjectSpec[] {
  try {
    const list = (parse(yaml) as { subjects?: unknown } | null)?.subjects;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item: Record<string, unknown>) =>
      item && ["User", "Group", "ServiceAccount"].includes(String(item.kind)) && typeof item.name === "string"
        ? [{ kind: item.kind as RbacSubjectSpec["kind"], name: item.name, namespace: typeof item.namespace === "string" ? item.namespace : null }]
        : [],
    );
  } catch {
    return [];
  }
}

type Mode = "add" | "remove" | null;

/**
 * RoleBinding·ClusterRoleBinding 상세의 도구: 주체 추가·빼기(바로 미리보기 또는 장바구니)와 삭제를 장바구니에 담기.
 * 삭제 단추 자체는 공통 도구 줄에 있다. 권한이 확실히 없으면 이유와 함께 끈다.
 */
export function BindingActions({ target, objectRef, view, rules, onStart }: Props) {
  const cart = useCart(target);
  const [mode, setMode] = useState<Mode>(null);
  const [kind, setKind] = useState<RbacSubjectSpec["kind"]>("User");
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [picked, setPicked] = useState("");
  const [note, setNote] = useState("");
  const subjects = useMemo(() => subjectsOf(view.yaml), [view.yaml]);
  // 다른 바인딩으로 옮기면 열어 둔 입력과 안내를 닫는다
  useEffect(() => {
    setMode(null);
    setNote("");
  }, [objectRef.kind.kind, objectRef.namespace, objectRef.name]);
  const binding = { namespace: objectRef.namespace, name: objectRef.name };
  const denied = (verb: string) =>
    rules && can(rules, { verb, group: RBAC_GROUP, resource: objectRef.kind.plural, name: objectRef.name }) === "no" ? t.BINDING_DENIED(verb, objectRef.kind.plural) : undefined;
  const patch = denied("patch");
  const remove = denied("delete");

  const draft: RbacSubjectSpec | null =
    mode === "add"
      ? { kind, name: name.trim(), namespace: kind === "ServiceAccount" ? namespace.trim() : null }
      : mode === "remove" && picked !== ""
        ? subjects[Number(picked)] ?? null
        : null;
  const valid = draft !== null && draft.name !== "" && (draft.kind !== "ServiceAccount" || !!draft.namespace);
  const next: K8sChange | null = draft && valid ? editSubjects(binding, mode === "add" ? [draft] : [], mode === "remove" ? [draft] : []) : null;

  const addToCart = (c: K8sChange) => {
    const result = cart.add(c);
    setNote(result === "added" ? t.CART_ADDED(cart.changes.length + 1, CART_MAX) : result === "duplicate" ? t.CART_DUPLICATE : t.CART_FULL(CART_MAX));
  };
  const open = (next: Mode) => {
    setMode((cur) => (cur === next ? null : next));
    setNote("");
  };

  return (
    <>
      <ActionButton tone="secondary" reason={patch} onClick={() => open("add")}>
        {t.BINDING_ADD_SUBJECT}
      </ActionButton>
      <ActionButton tone="secondary" reason={patch} onClick={() => open("remove")}>
        {t.BINDING_REMOVE_SUBJECT}
      </ActionButton>
      <ActionButton tone="secondary" reason={remove} onClick={() => addToCart(deleteBinding(binding))}>
        {t.BINDING_CART_DELETE}
      </ActionButton>
      {mode === "add" && (
        <span className="rbac-inline" role="group" aria-label={t.BINDING_ADD_SUBJECT}>
          <label>
            {t.BINDING_SUBJECT_KIND}{" "}
            <select value={kind} onChange={(e) => setKind(e.target.value as RbacSubjectSpec["kind"])}>
              {(["User", "Group", "ServiceAccount"] as const).map((k) => (
                <option key={k} value={k}>
                  {t.SUBJECT_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t.BINDING_SUBJECT_NAME} <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {kind === "ServiceAccount" && (
            <label>
              {t.BINDING_SUBJECT_NAMESPACE} <input value={namespace} onChange={(e) => setNamespace(e.target.value)} />
            </label>
          )}
        </span>
      )}
      {mode === "remove" && (
        <span className="rbac-inline" role="group" aria-label={t.BINDING_REMOVE_SUBJECT}>
          <label>
            {t.BINDING_SUBJECT_PICK}{" "}
            <select value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="">{subjects.length === 0 ? t.BINDING_NO_SUBJECTS : "—"}</option>
              {subjects.map((s, i) => (
                <option key={`${s.kind}|${s.namespace}|${s.name}`} value={String(i)}>
                  {t.subjectLabel(s)}
                </option>
              ))}
            </select>
          </label>
        </span>
      )}
      {mode && (
        <>
          <ActionButton tone="primary" reason={next ? undefined : t.INVALID_SUBJECT_HINT} onClick={() => next && onStart(next)}>
            {t.BINDING_PREVIEW}
          </ActionButton>
          <ActionButton tone="secondary" reason={next ? undefined : t.INVALID_SUBJECT_HINT} onClick={() => next && addToCart(next)}>
            {t.CART_ADD}
          </ActionButton>
          <ActionButton tone="ghost" onClick={() => setMode(null)}>
            {t.BINDING_CLOSE}
          </ActionButton>
        </>
      )}
      {note && <span role="status" className="dim">{note}</span>}
    </>
  );
}
