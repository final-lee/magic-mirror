import { useState } from "react";
import { FormSheet } from "../change/FormSheet";
import type { ResRef } from "../types";
import { DEL_FORCE, DEL_FORCE_HINT, DEL_NOTE, DEL_ORPHAN, DEL_ORPHAN_HINT, DEL_PREVIEW, delTitle } from "./text";

interface Props {
  res: ResRef;
  onCancel: () => void;
  onPreview: (options: { force: boolean; orphan: boolean }) => void;
}

/** 리소스 삭제 옵션: 강제(하위 리소스를 기다리지 않음)와 하위 리소스 남기기(orphan). 각 옵션이 무엇을 하는지 옆에 적는다. */
export function DeleteForm({ res, onCancel, onPreview }: Props) {
  const [force, setForce] = useState(false);
  const [orphan, setOrphan] = useState(false);
  return (
    <FormSheet label={delTitle(res.kind, res.name)} onCancel={onCancel} submit={{ label: DEL_PREVIEW, tone: "tone-danger", onClick: () => onPreview({ force, orphan }) }}>
      <p>{DEL_NOTE}</p>
      <label className="k8s-check argo-opt">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        {DEL_FORCE}
      </label>
      <p className="dim">{DEL_FORCE_HINT}</p>
      <label className="k8s-check argo-opt">
        <input type="checkbox" checked={orphan} onChange={(e) => setOrphan(e.target.checked)} />
        {DEL_ORPHAN}
      </label>
      <p className="dim">{DEL_ORPHAN_HINT}</p>
    </FormSheet>
  );
}
