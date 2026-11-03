import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { isSecret } from "./kinds";
import { NO_SECRET_EDITS, SecretEdit, withSecretValues, type SecretEdits } from "./SecretEdit";
import * as t from "./text";
import type { K8sChange, K8sObjectView, K8sTarget, ObjectRef } from "./types";
import { parseDocuments, yamlProblems, type YamlObject } from "./yamlDocs";
import { YamlEditor } from "./YamlEditor";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  objectRef: ObjectRef;
  view: K8sObjectView;
  canRead: "yes" | "no" | "unknown";
  onPreview: (change: K8sChange) => void;
  onCancel: () => void;
  /** 미리보기·편집 취소 버튼을 놓을 상세 도구 줄의 자리(없으면 그리지 않는다) */
  actions: HTMLElement | null;
}

const asRecord = (value: unknown): YamlObject => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as YamlObject) : {});

/** 고친 문서가 같은 객체를 가리키는지. 종류·이름·네임스페이스를 바꾸면 다른 객체를 만들게 되므로 막는다. */
function sameObject(object: YamlObject, { kind, namespace, name }: ObjectRef): boolean {
  const meta = asRecord(object.metadata);
  const apiVersion = kind.group ? `${kind.group}/${kind.version}` : kind.version;
  return object.apiVersion === apiVersion && object.kind === kind.kind && meta.name === name && (meta.namespace === undefined || meta.namespace === namespace);
}

/** 상세의 YAML 편집. 구문 오류가 있으면 미리보기를 막고, 미리보기는 변경 흐름(서버 dry-run)으로 넘긴다. */
export function YamlEdit({ target, ssoProfile, objectRef, view, canRead, onPreview, onCancel, actions }: Props) {
  const [text, setText] = useState(view.editYaml);
  const [secretEdits, setSecretEdits] = useState<SecretEdits>(NO_SECRET_EDITS);
  const [error, setError] = useState("");
  const problems = useMemo(() => yamlProblems(text), [text]);
  const secret = isSecret(objectRef.kind) && view.secretKeys !== null && objectRef.namespace !== null;

  const preview = () => {
    const docs = parseDocuments(text);
    const doc = docs[0];
    if (docs.length !== 1 || !doc.object) {
      setError(docs.length > 1 ? t.YAML_ONE_DOCUMENT : (doc?.error ?? t.YAML_NO_KIND));
      return;
    }
    if (!sameObject(doc.object, objectRef)) {
      setError(t.YAML_IDENTITY_CHANGED);
      return;
    }
    setError("");
    const object = secret ? withSecretValues(doc.object, view.secretKeys ?? [], secretEdits) : doc.object;
    onPreview({ kind: objectRef.kind, namespace: objectRef.namespace, name: objectRef.name, type: "apply", object, force: false });
  };

  return (
    <div className="k8s-yaml-edit">
      <p className="dim">{t.YAML_EDIT_NOTE}</p>
      {secret && <p className="dim">{t.SECRET_EDIT_NOTE}</p>}
      <YamlEditor value={view.editYaml} onChange={setText} />
      {problems.length > 0 && (
        <ul className="err" role="alert" aria-label={t.YAML_PROBLEMS}>
          {problems.map((problem, i) => (
            <li key={i}>{t.yamlProblem(problem.line, problem.column, problem.message)}</li>
          ))}
        </ul>
      )}
      {secret && objectRef.namespace && (
        <SecretEdit
          target={target}
          ssoProfile={ssoProfile}
          namespace={objectRef.namespace}
          name={objectRef.name}
          keys={view.secretKeys ?? []}
          canRead={canRead}
          edits={secretEdits}
          onEdits={setSecretEdits}
        />
      )}
      {error && <p className="err">{error}</p>}
      {actions &&
        createPortal(
          <>
            <button className="btn small tone-primary" disabled={problems.length > 0} onClick={preview}>
              {t.YAML_PREVIEW}
            </button>
            <button className="btn small tone-ghost" onClick={onCancel}>
              {t.YAML_CANCEL_EDIT}
            </button>
          </>,
          actions,
        )}
    </div>
  );
}
