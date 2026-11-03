import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../api/errors";
import { useSheetFocus } from "../../iam/previewParts";
import { yamlProblem } from "../text";
import type { K8sChange } from "../types";
import { yamlProblems } from "../yamlDocs";
import { YamlEditor } from "../YamlEditor";
import { helmApi } from "./api";
import { ChartSourceFields, EMPTY_SOURCE, toSource, type SourceForm } from "./ChartSourceFields";
import * as t from "./text";
import { HELM_RELEASE_KIND } from "./types";

interface Props {
  /** 처음 넣어 둘 네임스페이스(고른 네임스페이스, 모든 네임스페이스면 default) */
  namespace: string;
  /** 만든 변경으로 미리보기를 연다 */
  onPreview: (change: K8sChange) => void;
  onClose: () => void;
}

/** 차트 설치: 릴리스 이름·네임스페이스, 차트 위치(로컬 경로, 저장소, OCI), values 편집기. 미리보기는 서버 dry-run이다 */
export function HelmInstallDialog({ namespace: initialNamespace, onPreview, onClose }: Props) {
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState(initialNamespace);
  const [createNamespace, setCreateNamespace] = useState(false);
  const [form, setForm] = useState<SourceForm>(EMPTY_SOURCE);
  const [values, setValues] = useState("");
  // 편집기는 처음 값으로만 채우므로, 기본값을 불러오면 키를 바꿔 새로 연다
  const [editor, setEditor] = useState({ key: 0, initial: "" });
  const [loading, setLoading] = useState(false);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);
  const { sheetRef, trapTab, cancelRef } = useSheetFocus("ready", onClose);
  const problems = useMemo(() => yamlProblems(values), [values]);
  const source = toSource(form);
  const nameOk = t.RELEASE_NAME_PATTERN.test(name);
  const namespaceOk = t.NAMESPACE_PATTERN.test(namespace);
  const ready = nameOk && namespaceOk && source !== null && problems.length === 0;

  const loadDefaults = async () => {
    if (!source || loading) return;
    setLoading(true);
    setDefaultsError(null);
    try {
      const text = await helmApi.showValues(source);
      if (!alive.current) return;
      setValues(text);
      setEditor((e) => ({ key: e.key + 1, initial: text }));
    } catch (error) {
      if (alive.current) setDefaultsError(errorMessage(error));
    } finally {
      if (alive.current) setLoading(false);
    }
  };

  const preview = () => {
    if (!source) return;
    onPreview({
      kind: HELM_RELEASE_KIND,
      namespace,
      name,
      type: "helmInstall",
      chart: source,
      values,
      createNamespace,
    });
  };

  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={t.INSTALL_TITLE} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{t.INSTALL_TITLE}</h3>
          <div className="helm-grid">
            <label className="helm-field">
              <span>{t.INSTALL_NAME}</span>
              <input value={name} spellCheck={false} aria-invalid={name !== "" && !nameOk} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="helm-field">
              <span>{t.INSTALL_NAMESPACE}</span>
              <input value={namespace} spellCheck={false} aria-invalid={!namespaceOk} onChange={(e) => setNamespace(e.target.value)} />
            </label>
          </div>
          {name !== "" && !nameOk && <p className="err">{t.INSTALL_NAME_INVALID}</p>}
          {!namespaceOk && <p className="err">{t.INSTALL_NAMESPACE_INVALID}</p>}
          <label className="k8s-check">
            <input type="checkbox" checked={createNamespace} onChange={(e) => setCreateNamespace(e.target.checked)} />
            {t.INSTALL_CREATE_NAMESPACE}
          </label>
          <ChartSourceFields form={form} onChange={setForm} />
          <h4>{t.VALUES_LABEL}</h4>
          <p>{t.INSTALL_DEFAULTS_NOTE}</p>
          <button className="btn plain tone-secondary" disabled={!source || loading} onClick={() => void loadDefaults()}>
            {loading ? t.INSTALL_LOADING_DEFAULTS : t.INSTALL_LOAD_DEFAULTS}
          </button>
          {defaultsError && <p className="err" role="alert">{defaultsError}</p>}
          <YamlEditor key={editor.key} value={editor.initial} onChange={setValues} label={t.VALUES_EDITOR_LABEL} />
          {problems.length > 0 && (
            <ul className="err" role="alert" aria-label={t.VALUES_INVALID}>
              {problems.map((problem, i) => (
                <li key={i}>{yamlProblem(problem.line, problem.column, problem.message)}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="foot">
          <button ref={cancelRef} className="btn plain tone-ghost" onClick={onClose}>
            {t.ACT_CANCEL}
          </button>
          <button className="btn plain tone-primary" disabled={!ready} onClick={preview}>
            {t.ACT_PREVIEW}
          </button>
        </div>
      </div>
    </div>
  );
}
