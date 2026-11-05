import { useState } from "react";
import { CodeEditor } from "../../components/CodeEditor";
import { FormSheet } from "../change/FormSheet";
import type { ResRef } from "../types";
import { PATCH_EDITOR, PATCH_HINT, PATCH_INVALID, PATCH_MERGE, PATCH_PREVIEW, PATCH_STRATEGIC, PATCH_STRATEGIC_ONLY, PATCH_TYPE, patchTitle } from "./text";

export type PatchKind = "merge" | "strategic";

const BUILTIN_GROUPS = [
  "", "apps", "batch", "autoscaling", "policy", "extensions", "networking.k8s.io", "rbac.authorization.k8s.io", "storage.k8s.io", "scheduling.k8s.io", "node.k8s.io",
  "coordination.k8s.io", "discovery.k8s.io", "certificates.k8s.io", "admissionregistration.k8s.io", "apiextensions.k8s.io", "events.k8s.io", "flowcontrol.apiserver.k8s.io",
];

/** Kubernetes가 strategic merge patch를 지원하는 기본(내장) 그룹인가. CRD는 JSON merge patch만 된다. */
export const supportsStrategic = (group: string) => BUILTIN_GROUPS.includes(group);

/** 패치 글이 내용이 있는 JSON 객체인가(빈 `{}`는 바꾸는 것이 없다) */
export function validPatch(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
  } catch {
    return false;
  }
}

interface Props {
  res: ResRef;
  onCancel: () => void;
  onPreview: (patch: { patch: string; patchType: PatchKind }) => void;
}

/** 리소스 패치 편집: JSON merge patch(기본) 또는 기본 종류의 strategic merge patch. 객체 JSON이어야 미리 볼 수 있다. */
export function PatchForm({ res, onCancel, onPreview }: Props) {
  const strategic = supportsStrategic(res.group);
  const [type, setType] = useState<PatchKind>(strategic ? "strategic" : "merge");
  const [text, setText] = useState("{\n  \n}");
  const valid = validPatch(text);
  return (
    <FormSheet
      label={patchTitle(res.kind, res.name)}
      wide
      onCancel={onCancel}
      submit={{ label: PATCH_PREVIEW, disabled: !valid, title: valid ? undefined : PATCH_INVALID, onClick: () => onPreview({ patch: text, patchType: type }) }}
    >
      <p>{PATCH_HINT}</p>
      <div role="radiogroup" aria-label={PATCH_TYPE}>
        <label className="k8s-check argo-opt">
          <input type="radio" name="patch-type" checked={type === "merge"} onChange={() => setType("merge")} />
          {PATCH_MERGE}
        </label>
        <label className="k8s-check argo-opt">
          <input type="radio" name="patch-type" checked={type === "strategic"} disabled={!strategic} onChange={() => setType("strategic")} />
          {PATCH_STRATEGIC}
        </label>
        {!strategic && <p className="dim">{PATCH_STRATEGIC_ONLY}</p>}
      </div>
      <CodeEditor value={text} onChange={setText} label={PATCH_EDITOR} language="json" />
      {!valid && (
        <p className="err" role="alert">
          {PATCH_INVALID}
        </p>
      )}
    </FormSheet>
  );
}
