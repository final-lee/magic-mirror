import { useId, useState } from "react";
import { CodeEditor } from "../components/CodeEditor";
import { argowfApi } from "./api";
import { ActionDialog } from "./ActionDialog";
import { useCatalogAction } from "./catalogHooks";
import {
  CAT_CONFIRM,
  SUBMIT_DONE,
  SUBMIT_NAMESPACE,
  SUBMIT_NEED_NAMESPACE,
  SUBMIT_NO_PARAMS,
  SUBMIT_NOTE,
  SUBMIT_PICK,
  SUBMIT_TITLE,
  submitNeedChoice,
} from "./catalogText";
import type { ArgoWfConn, TemplateRow } from "./types";

interface Props {
  conn: ArgoWfConn;
  template: TemplateRow;
  /** ClusterWorkflowTemplate을 실행할 네임스페이스 후보(직접 쳐도 된다) */
  namespaces: string[];
  /** ClusterWorkflowTemplate의 처음 네임스페이스 */
  defaultNamespace: string;
  onClose: () => void;
  /** 새 Workflow가 만들어졌다 */
  onSubmitted: (namespace: string, name: string) => void;
  onTokenError: (message: string) => void;
}

/** 기본값이 선택지에 없으면 비워서 고르게 한다 */
const initial = (p: TemplateRow["parameters"][number]) => (p.value !== null && (p.enum.length === 0 || p.enum.includes(p.value)) ? p.value : "");

/**
 * 템플릿 실행 창: 파라미터 폼(기본값을 채워 둔다, enum은 선택 상자)과, ClusterWorkflowTemplate일 때만 네임스페이스.
 * 네임스페이스 템플릿은 그 템플릿의 네임스페이스에서 실행한다. 모든 파라미터를 `이름=값`으로 보낸다(보이는 값이 보낸 값이다).
 */
export function SubmitForm({ conn, template, namespaces, defaultNamespace, onClose, onSubmitted, onTokenError }: Props) {
  const id = useId();
  const act = useCatalogAction(conn, onTokenError);
  const [values, setValues] = useState<string[]>(() => template.parameters.map(initial));
  // 여러 줄 기본값은 편집기로 연다. 고치는 동안 줄바꿈을 지워도 칸 모양은 바뀌지 않는다
  const [multiline] = useState(() => values.map((v) => v.includes("\n")));
  const [ns, setNs] = useState(defaultNamespace);
  const [problem, setProblem] = useState<string | null>(null);
  const [entryPoint, setEntryPoint] = useState(template.entrypoint ?? "");
  const [labels, setLabels] = useState("");
  const [generateName, setGenerateName] = useState("");
  const [serviceAccount, setServiceAccount] = useState("");
  const [dryRunResult, setDryRunResult] = useState<string | null>(null);
  const cluster = template.kind === "ClusterWorkflowTemplate";

  const change = (i: number, v: string) => {
    setProblem(null);
    setValues((all) => all.map((x, j) => (j === i ? v : x)));
  };

  const submit = async (serverDryRun = false) => {
    const target = cluster ? ns.trim() : (template.namespace ?? "");
    if (target === "") return setProblem(SUBMIT_NEED_NAMESPACE);
    const unpicked = template.parameters.findIndex((p, i) => p.enum.length > 0 && values[i] === "");
    if (unpicked >= 0) return setProblem(submitNeedChoice(template.parameters[unpicked].name));
    setProblem(null);
    const r = await act.run(
      () =>
        argowfApi.submitTemplate(conn, template.kind, template.namespace, target, template.name, {
          parameters: template.parameters.map((p, i) => `${p.name}=${values[i]}`),
          entryPoint: entryPoint || null,
          labels: labels.trim() || null,
          generateName: generateName.trim() || null,
          serviceAccount: serviceAccount.trim() || null,
          serverDryRun,
        }),
      SUBMIT_DONE,
    );
    if (r) {
      if (serverDryRun) setDryRunResult(`검사를 통과했어요: ${r.value}`);
      else onSubmitted(target, r.value);
    }
  };

  return (
    <ActionDialog
      title={SUBMIT_TITLE(template.name)}
      note={SUBMIT_NOTE}
      confirmLabel={CAT_CONFIRM}
      busy={act.busy}
      error={problem ?? act.error}
      onConfirm={() => void submit()}
      onCancel={onClose}
    >
      {cluster ? (
        <div className="field">
          <label htmlFor={`${id}-ns`}>{SUBMIT_NAMESPACE}</label>
          <input
            id={`${id}-ns`}
            className="field-input mono"
            list={`${id}-nss`}
            autoComplete="off"
            spellCheck={false}
            value={ns}
            onChange={(e) => setNs(e.target.value)}
          />
          <datalist id={`${id}-nss`}>
            {namespaces.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>
      ) : (
        <p className="dim">
          {SUBMIT_NAMESPACE}: <span className="mono">{template.namespace}</span>
        </p>
      )}
      <div className="awc-form-grid">
        <div className="field">
          <label htmlFor={`${id}-entry`}>Entrypoint</label>
          <select id={`${id}-entry`} className="field-input" value={entryPoint} onChange={(e) => setEntryPoint(e.target.value)}>
            <option value="">기본값</option>
            {template.templates.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-labels`}>레이블</label>
          <input id={`${id}-labels`} className="field-input mono" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="a=b,c=d" />
        </div>
        <div className="field">
          <label htmlFor={`${id}-gen`}>generateName</label>
          <input id={`${id}-gen`} className="field-input mono" value={generateName} onChange={(e) => setGenerateName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-sa`}>ServiceAccount</label>
          <input id={`${id}-sa`} className="field-input mono" value={serviceAccount} onChange={(e) => setServiceAccount(e.target.value)} />
        </div>
      </div>
      <h4>파라미터</h4>
      {template.parameters.length === 0 && <p className="dim">{SUBMIT_NO_PARAMS}</p>}
      {template.parameters.map((p, i) => (
        <div className="field" key={p.name}>
          <label htmlFor={`${id}-${i}`}>{p.name}</label>
          {p.enum.length > 0 ? (
            <select id={`${id}-${i}`} className="field-input mono" value={values[i]} onChange={(e) => change(i, e.target.value)}>
              <option value="">{SUBMIT_PICK}</option>
              {p.enum.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : multiline[i] ? (
            <CodeEditor value={values[i]} onChange={(text) => change(i, text)} label={p.name} language="text" />
          ) : (
            <input
              id={`${id}-${i}`}
              className="field-input mono"
              autoComplete="off"
              spellCheck={false}
              value={values[i]}
              onChange={(e) => change(i, e.target.value)}
            />
          )}
          {p.description && <small className="dim">{p.description}</small>}
        </div>
      ))}
      <div className="awc-dryrun">
        <button type="button" className="btn small" disabled={act.busy} onClick={() => void submit(true)}>
          검사만
        </button>
        {dryRunResult && (
          <span role="status" className="dim">
            {dryRunResult}
          </span>
        )}
      </div>
    </ActionDialog>
  );
}
