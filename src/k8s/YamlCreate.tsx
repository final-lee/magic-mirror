import { useMemo, useState } from "react";
import { useSheetFocus } from "../iam/previewParts";
import type { BatchEntry } from "./ChangeBatch";
import * as t from "./text";
import type { K8sKindRef } from "./types";
import { MAX_DOCUMENTS, parseDocuments, resolveChange, yamlProblems } from "./yamlDocs";
import { YamlEditor } from "./YamlEditor";

interface Props {
  /** 이 클러스터가 내주는 종류(apiVersion·kind로 plural을 찾는다) */
  kinds: K8sKindRef[];
  /** 고른 네임스페이스. 모든 네임스페이스면 null */
  namespace: string | null;
  /** 문서마다 만든 변경으로 미리보기를 연다 */
  onPreview: (entries: BatchEntry[]) => void;
  onClose: () => void;
}

/** 붙여 넣은 YAML(문서 여러 개 가능)을 문서마다 적용 변경으로 바꿔 미리보기로 넘긴다. */
export function YamlCreate({ kinds, namespace, onPreview, onClose }: Props) {
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const { sheetRef, trapTab, cancelRef } = useSheetFocus("ready", onClose);
  const problems = useMemo(() => yamlProblems(text), [text]);

  const preview = () => {
    const docs = parseDocuments(text);
    const found: string[] = [];
    const entries: BatchEntry[] = [];
    if (docs.length === 0) found.push(t.YAML_CREATE_EMPTY);
    if (docs.length > MAX_DOCUMENTS) found.push(t.yamlTooMany(MAX_DOCUMENTS));
    for (const doc of docs) {
      const resolved = doc.object ? resolveChange(doc.object, kinds, namespace) : null;
      if (resolved?.change) entries.push({ change: resolved.change, undoOf: null });
      else found.push(t.yamlDocumentError(doc.index, resolved?.error ?? doc.error ?? t.YAML_NOT_OBJECT));
    }
    setErrors(found);
    if (found.length === 0) onPreview(entries);
  };

  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={t.YAML_CREATE} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{t.YAML_CREATE}</h3>
          <p>{t.YAML_CREATE_HINT}</p>
          <YamlEditor value="" onChange={setText} />
          {problems.length > 0 && (
            <ul className="err" role="alert" aria-label={t.YAML_PROBLEMS}>
              {problems.map((problem, i) => (
                <li key={i}>{t.yamlProblem(problem.line, problem.column, problem.message)}</li>
              ))}
            </ul>
          )}
          {errors.length > 0 && (
            <ul className="err" aria-label={t.YAML_DOCUMENT_ERRORS}>
              {errors.map((error, i) => (
                <li key={i}>{error}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="foot">
          <button ref={cancelRef} className="btn tone-ghost" onClick={onClose}>
            {t.CHANGE_CANCEL}
          </button>
          <button className="btn tone-primary" disabled={problems.length > 0 || text.trim() === ""} onClick={preview}>
            {t.YAML_PREVIEW}
          </button>
        </div>
      </div>
    </div>
  );
}
