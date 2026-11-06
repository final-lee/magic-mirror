import { useState } from "react";
import type { AccessView, MappingRow } from "../access/types";
import type { K8sChange } from "../types";
import { ActionButton } from "./ActionButton";
import { entryDelete, entryDisassociate } from "./changes";
import { EntryDialog, type EntryForm } from "./EntryDialog";
import * as t from "./text";

interface Props {
  m: MappingRow;
  mode: AccessView["mode"];
  onChange: (change: K8sChange) => void;
}

/** access entry 행의 변경 단추: 그룹 변경, 정책 연결·해제, 삭제. aws-auth 행에는 옮기라는 안내만 둔다. */
export function EntryActions({ m, mode, onChange }: Props) {
  const [form, setForm] = useState<EntryForm | null>(null);
  if (m.source === "awsAuth") return <span className="dim">{t.ENTRY_AWS_AUTH_NOTE}</span>;
  const reason = mode === "configMap" ? t.ENTRY_CONFIG_MAP : !m.effective && m.inactiveReason ? t.ENTRY_UNREADABLE : undefined;
  return (
    <>
      <ActionButton tone="primary" reason={reason} onClick={() => setForm({ mode: "groups", arn: m.principalArn, groups: m.groups })}>
        {t.ENTRY_GROUPS}
      </ActionButton>
      <ActionButton tone="primary" reason={reason} onClick={() => setForm({ mode: "associate", arn: m.principalArn })}>
        {t.ENTRY_ASSOCIATE}
      </ActionButton>
      {m.policies.map((p) => (
        <ActionButton key={p.policyArn} tone="danger" reason={reason} onClick={() => onChange(entryDisassociate(m.principalArn, p.policyArn))}>
          {t.entryPolicyUndo(p.policyName)}
        </ActionButton>
      ))}
      <ActionButton tone="danger" reason={reason} onClick={() => onChange(entryDelete(m.principalArn))}>
        {t.ENTRY_DELETE}
      </ActionButton>
      {form && (
        <EntryDialog
          form={form}
          onClose={() => setForm(null)}
          onSubmit={(change) => {
            setForm(null);
            onChange(change);
          }}
        />
      )}
    </>
  );
}

/** 신원 화면 위쪽의 [access entry 만들기] */
export function EntryCreateButton({ mode, onChange }: { mode: AccessView["mode"]; onChange: (change: K8sChange) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionButton tone="create" reason={mode === "configMap" ? t.ENTRY_CONFIG_MAP : undefined} onClick={() => setOpen(true)}>
        {t.ENTRY_CREATE}
      </ActionButton>
      {open && (
        <EntryDialog
          form={{ mode: "create" }}
          onClose={() => setOpen(false)}
          onSubmit={(change) => {
            setOpen(false);
            onChange(change);
          }}
        />
      )}
    </>
  );
}
