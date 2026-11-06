import { useState } from "react";
import { FormSheet } from "../change/FormSheet";
import type { ArgoChange } from "../change/types";
import { resourceKey } from "../change/syncModel";
import { ParamInput, filledParams, initialParams } from "./ActionForm";
import { ACT_PARAMS_HINT, BATCH_DISABLED, BATCH_PREVIEW, BATCH_TARGETS, actionLabel, batchPick, batchTitle } from "./text";
import type { AppActionGroup } from "./types";

export type Batch = Extract<ArgoChange, { kind: "resourceActionBatch" }>;

interface Props {
  group: AppActionGroup;
  onCancel: () => void;
  onPreview: (change: Batch) => void;
}

/** 같은 액션을 여러 리소스에: 실행할 수 있는 리소스는 모두 처음부터 골라 두고, 지금 못 하는 것은 흐리게 이유와 함께 보인다. 액션이 인자를 받으면 입력한다. */
export function BatchForm({ group, onCancel, onPreview }: Props) {
  const eligible = group.resources.filter((r) => !r.disabled);
  const [picked, setPicked] = useState<string[]>(() => eligible.map((r) => resourceKey(r.res)));
  const [values, setValues] = useState<Record<string, string>>(() => initialParams(group.params));
  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const chosen = eligible.filter((r) => picked.includes(resourceKey(r.res)));
  return (
    <FormSheet
      label={batchTitle(actionLabel(group.action, group.displayName), group.kind)}
      onCancel={onCancel}
      submit={{
        label: BATCH_PREVIEW,
        disabled: chosen.length === 0,
        onClick: () => onPreview({ kind: "resourceActionBatch", action: group.action, resources: chosen.map((r) => r.res), params: filledParams(group.params, values) }),
      }}
    >
      <h4>{BATCH_TARGETS}</h4>
      <ul className="argo-sync-res">
        {group.resources.map(({ res, disabled }) => (
          <li key={resourceKey(res)} className={disabled ? "dim" : undefined}>
            <label className="k8s-check">
              <input type="checkbox" aria-label={batchPick(res.name)} disabled={disabled} checked={!disabled && picked.includes(resourceKey(res))} onChange={() => toggle(resourceKey(res))} />
              <span className="mono">{res.name}</span>
              {res.namespace && <span className="dim"> {res.namespace}</span>}
              {disabled && <span> · {BATCH_DISABLED}</span>}
            </label>
          </li>
        ))}
      </ul>
      {group.params.length > 0 && (
        <>
          <p>{ACT_PARAMS_HINT}</p>
          {group.params.map((p) => (
            <ParamInput key={p.name} param={p} value={values[p.name] ?? ""} onChange={(value) => setValues((v) => ({ ...v, [p.name]: value }))} />
          ))}
        </>
      )}
    </FormSheet>
  );
}
