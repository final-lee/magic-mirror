import { useState } from "react";
import { FormSheet } from "../change/FormSheet";
import { ACT_PARAMS_HINT, ACT_PREVIEW, actParamsTitle } from "./text";
import type { ActionParam, ResourceAction } from "./types";

interface Props {
  action: ResourceAction;
  onCancel: () => void;
  /** 값을 넣은 인자(비워 둔 칸은 뺀다) */
  onPreview: (params: { name: string; value: string }[]) => void;
}

const initial = (p: ActionParam) => p.value ?? p.default ?? "";

function ParamInput({ param, value, onChange }: { param: ActionParam; value: string; onChange: (value: string) => void }) {
  if (param.kind === "boolean") {
    return (
      <label className="k8s-check argo-opt">
        <input type="checkbox" checked={value === "true"} onChange={(e) => onChange(String(e.target.checked))} />
        {param.name}
      </label>
    );
  }
  return (
    <label>
      {param.name}
      <input type={param.kind === "number" ? "number" : "text"} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** 인자가 있는 리소스 액션의 값 입력. 서버가 준 처음 값(value·default)으로 채운다. */
export function ActionForm({ action, onCancel, onPreview }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(action.params.map((p) => [p.name, initial(p)])));
  return (
    <FormSheet
      label={actParamsTitle(action.displayName ?? action.name)}
      onCancel={onCancel}
      submit={{ label: ACT_PREVIEW, onClick: () => onPreview(action.params.flatMap((p) => (values[p.name] ? [{ name: p.name, value: values[p.name] }] : []))) }}
    >
      <p>{ACT_PARAMS_HINT}</p>
      {action.params.map((p) => (
        <ParamInput key={p.name} param={p} value={values[p.name] ?? ""} onChange={(value) => setValues((v) => ({ ...v, [p.name]: value }))} />
      ))}
    </FormSheet>
  );
}
