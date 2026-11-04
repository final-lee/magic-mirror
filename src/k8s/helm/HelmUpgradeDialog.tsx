import { useMemo, useState } from "react";
import { useSheetFocus } from "../../iam/previewParts";
import { yamlProblem } from "../text";
import type { K8sChange } from "../types";
import { yamlProblems } from "../yamlDocs";
import { YamlEditor } from "../YamlEditor";
import { ChartSourceFields, EMPTY_SOURCE, toSource, type SourceForm } from "./ChartSourceFields";
import * as t from "./text";
import { HELM_RELEASE_KIND, type HelmReleaseDetail } from "./types";

interface Props {
  detail: HelmReleaseDetail;
  /** 만든 변경으로 미리보기를 연다 */
  onPreview: (change: K8sChange) => void;
  onClose: () => void;
}

/** values를 고치거나 다른 차트로 업그레이드한다. 편집한 글이 사용자 values 전체가 된다(--reset-values) */
export function HelmUpgradeDialog({ detail, onPreview, onClose }: Props) {
  const [values, setValues] = useState(detail.userValues);
  const [other, setOther] = useState(false);
  const [form, setForm] = useState<SourceForm>(EMPTY_SOURCE);
  const { sheetRef, trapTab, cancelRef } = useSheetFocus("ready", onClose);
  const problems = useMemo(() => yamlProblems(values), [values]);
  const source = other ? toSource(form) : null;
  const ready = problems.length === 0 && (!other || source !== null);

  const preview = () => {
    onPreview({
      kind: HELM_RELEASE_KIND,
      namespace: detail.namespace,
      name: detail.name,
      type: "helmUpgrade",
      values,
      chart: source,
    });
  };

  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={t.UPGRADE_TITLE(detail.name)} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{t.UPGRADE_TITLE(detail.name)}</h3>
          <p>{t.UPGRADE_NOTE}</p>
          <div role="radiogroup" aria-label={t.UPGRADE_CHART_LABEL} className="helm-seg">
            <label className={other ? undefined : "on"}>
              <input type="radio" name="helm-upgrade-chart" checked={!other} onChange={() => setOther(false)} />
              {t.UPGRADE_CHART_STORED}
            </label>
            <label className={other ? "on" : undefined}>
              <input type="radio" name="helm-upgrade-chart" checked={other} onChange={() => setOther(true)} />
              {t.UPGRADE_CHART_OTHER}
            </label>
          </div>
          {other ? <ChartSourceFields form={form} onChange={setForm} /> : <p>{t.UPGRADE_STORED_NOTE(detail.chart.name ? `${detail.chart.name}-${detail.chart.version}` : "")}</p>}
          <h4>{t.VALUES_LABEL}</h4>
          <YamlEditor value={detail.userValues} onChange={setValues} label={t.VALUES_EDITOR_LABEL} />
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
