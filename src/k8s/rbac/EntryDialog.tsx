import { useState } from "react";
import { useSheetFocus } from "../../iam/previewParts";
import type { PolicyScope } from "../access/types";
import type { K8sChange } from "../types";
import { entryAssociate, entryCreate, entryGroups, splitList } from "./changes";
import * as t from "./text";
import type { RbacPolicySpec } from "./types";

/** 열 수 있는 입력 창: 새 entry, 그룹 바꾸기, 정책 연결 */
export type EntryForm =
  | { mode: "create" }
  | { mode: "groups"; arn: string; groups: string[] }
  | { mode: "associate"; arn: string };

interface Props {
  form: EntryForm;
  /** 입력한 변경을 미리보기로 보낸다 */
  onSubmit: (change: K8sChange) => void;
  onClose: () => void;
}

const CUSTOM = "custom";
const NONE = "none";

interface PolicyFields {
  policy: string;
  custom: string;
  scope: "cluster" | "namespaces";
  namespaces: string;
}

/** 정책 입력(선택·직접 입력·범위). 정책을 고르지 않았으면 null, 잘못 입력했으면 이유 */
function policyOf(f: PolicyFields): { spec: RbacPolicySpec | null; error: string | null } {
  if (f.policy === NONE) return { spec: null, error: null };
  const arn = f.policy === CUSTOM ? f.custom.trim() : f.policy;
  if (!arn) return { spec: null, error: t.ENTRY_POLICY_REQUIRED };
  const names = splitList(f.namespaces);
  if (f.scope === "namespaces" && names.length === 0) return { spec: null, error: t.ENTRY_NAMESPACES_REQUIRED };
  const scope: PolicyScope = f.scope === "cluster" ? { kind: "cluster" } : { kind: "namespaces", namespaces: names };
  return { spec: { policyArn: arn, scope }, error: null };
}

function PolicyInputs({ fields, onChange, noneOption }: { fields: PolicyFields; onChange: (next: PolicyFields) => void; noneOption: boolean }) {
  const set = (patch: Partial<PolicyFields>) => onChange({ ...fields, ...patch });
  return (
    <>
      <label className="field">
        <span>{t.ENTRY_POLICY}</span>
        <select value={fields.policy} onChange={(e) => set({ policy: e.target.value })}>
          {noneOption && <option value={NONE}>{t.ENTRY_POLICY_NONE}</option>}
          {t.KNOWN_POLICIES.map((p) => (
            <option key={p.arn} value={p.arn}>
              {p.name}
            </option>
          ))}
          <option value={CUSTOM}>{t.ENTRY_POLICY_CUSTOM}</option>
        </select>
      </label>
      {fields.policy === CUSTOM && (
        <label className="field">
          <span>{t.ENTRY_POLICY_ARN}</span>
          <input className="mono" value={fields.custom} onChange={(e) => set({ custom: e.target.value })} />
        </label>
      )}
      {fields.policy !== NONE && (
        <fieldset className="field">
          <legend>{t.ENTRY_SCOPE}</legend>
          <label className="acc-check">
            <input type="radio" name="rbac-scope" checked={fields.scope === "cluster"} onChange={() => set({ scope: "cluster" })} />
            {t.ENTRY_SCOPE_CLUSTER}
          </label>
          <label className="acc-check">
            <input type="radio" name="rbac-scope" checked={fields.scope === "namespaces"} onChange={() => set({ scope: "namespaces" })} />
            {t.ENTRY_SCOPE_NAMESPACES}
          </label>
          {fields.scope === "namespaces" && <input aria-label={t.ENTRY_SCOPE_NAMESPACES_LABEL} placeholder={t.ENTRY_SCOPE_NAMESPACES_LABEL} className="mono" value={fields.namespaces} onChange={(e) => set({ namespaces: e.target.value })} />}
        </fieldset>
      )}
    </>
  );
}

/**
 * access entry 변경 입력 창. EKS 권한은 미리 확인할 수 없어서 미리보기까지는 열어 두고, 권한이 없으면 적용할 때 EKS의 오류를 그대로 보인다.
 * 입력을 마치면 변경 공통 미리보기로 이어진다(EKS 호출, 실효 권한 영향, 이름 입력).
 */
export function EntryDialog({ form, onSubmit, onClose }: Props) {
  const { sheetRef, trapTab, cancelRef } = useSheetFocus("ready", onClose);
  const [arn, setArn] = useState(form.mode === "create" ? "" : form.arn);
  const [username, setUsername] = useState("");
  const [groups, setGroups] = useState(form.mode === "groups" ? form.groups.join(", ") : "");
  const [fields, setFields] = useState<PolicyFields>({ policy: form.mode === "associate" ? t.KNOWN_POLICIES[3].arn : NONE, custom: "", scope: "cluster", namespaces: "" });
  const policy = policyOf(fields);
  const names = splitList(groups);
  const title = form.mode === "create" ? t.ENTRY_CREATE_TITLE : form.mode === "groups" ? t.ENTRY_GROUPS_TITLE : t.ENTRY_ASSOCIATE_TITLE;
  const problem =
    form.mode === "create" && !arn.trim()
      ? t.ENTRY_PRINCIPAL_REQUIRED
      : form.mode === "associate" && !policy.spec
        ? policy.error ?? t.ENTRY_POLICY_REQUIRED
        : form.mode === "create"
          ? policy.error
          : null;

  const submit = () => {
    if (problem) return;
    if (form.mode === "create") onSubmit(entryCreate(arn.trim(), { username: username.trim() || null, groups: names, policies: policy.spec ? [policy.spec] : [] }));
    else if (form.mode === "groups") onSubmit(entryGroups(form.arn, names));
    else if (policy.spec) onSubmit(entryAssociate(form.arn, policy.spec.policyArn, policy.spec.scope));
  };

  return (
    <div className="modal">
      <div className="sheet cp" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{title}</h3>
          <p className="dim">{t.ENTRY_API_NOTE}</p>
          {form.mode === "create" ? (
            <label className="field">
              <span>{t.ENTRY_PRINCIPAL}</span>
              <input className="mono" value={arn} placeholder={t.ENTRY_PRINCIPAL_PLACEHOLDER} onChange={(e) => setArn(e.target.value)} autoFocus />
            </label>
          ) : (
            <p className="mono k8s-wrap">{form.arn}</p>
          )}
          {form.mode === "create" && (
            <label className="field">
              <span>{t.ENTRY_USERNAME}</span>
              <input className="mono" value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
          )}
          {form.mode !== "associate" && (
            <label className="field">
              <span>{t.ENTRY_GROUPS_LABEL}</span>
              <input className="mono" value={groups} onChange={(e) => setGroups(e.target.value)} />
            </label>
          )}
          {form.mode !== "groups" && <PolicyInputs fields={fields} onChange={setFields} noneOption={form.mode === "create"} />}
          {problem && <p className="err">{problem}</p>}
        </div>
        <div className="foot">
          <button ref={cancelRef} className="btn plain tone-ghost" onClick={onClose}>
            {t.ENTRY_CANCEL}
          </button>
          <button className="btn plain tone-primary" disabled={!!problem} onClick={submit}>
            {t.ENTRY_PREVIEW}
          </button>
        </div>
      </div>
    </div>
  );
}
