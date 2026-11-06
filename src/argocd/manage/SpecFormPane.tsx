import { useMemo, useState } from "react";
import { CodeEditor } from "../../components/CodeEditor";
import {
  MANAGE_ALLOW_EMPTY, MANAGE_AUTOMATED, MANAGE_FORM_POLICY, MANAGE_FORM_PREVIEW, MANAGE_HELM, MANAGE_HELM_PARAMS, MANAGE_HELM_VALUES, MANAGE_HELM_VALUES_OBJECT, MANAGE_IMAGE_ADD,
  MANAGE_KUSTOMIZE, MANAGE_KUSTOMIZE_IMAGES, MANAGE_NAME_PREFIX, MANAGE_NAME_SUFFIX, MANAGE_NO_CHANGE, MANAGE_NO_SOURCES, MANAGE_OPTIONS, MANAGE_PARAM_ADD, MANAGE_PARAM_FORCE,
  MANAGE_PARAM_NAME, MANAGE_PARAM_VALUE, MANAGE_PRUNE, MANAGE_REMOVE, MANAGE_SELF_HEAL, MANAGE_SYNC_OPTIONS, MANAGE_TARGET_REVISION, manageFormProblem, manageSourceTitle,
} from "./text";
import { formOf, formPatch, formProblems, type Obj, type ParamRow, type PolicyForm, type SourceForm } from "./specForm";

interface Props {
  /** 지금 Application.spec */
  spec: Obj;
  /** 바뀐 곳만 담은 병합 패치({spec: …})로 미리 보기를 연다 */
  onPreview: (patch: { spec: unknown }) => void;
  disabled?: boolean;
  disabledReason?: string;
}

const repoOf = (spec: Obj, index: number) => {
  const source = (Array.isArray(spec.sources) ? spec.sources[index] : spec.source) as Obj | undefined;
  return String(source?.chart ?? source?.path ?? source?.repoURL ?? "");
};

/** 설정 바꾸기: 동기화 정책·옵션과 소스별 목표 리비전·Helm·Kustomize를 폼으로 고친다 */
export function SpecFormPane({ spec, onPreview, disabled, disabledReason }: Props) {
  const [form, setForm] = useState(() => formOf(spec));
  const patch = useMemo(() => formPatch(spec, form), [spec, form]);
  const problems = useMemo(() => formProblems(form), [form]);

  const setPolicy = (next: Partial<PolicyForm>) => setForm((f) => ({ ...f, policy: { ...f.policy, ...next } }));
  const setSource = (index: number, next: Partial<SourceForm>) => setForm((f) => ({ ...f, sources: f.sources.map((s, i) => (i === index ? { ...s, ...next } : s)) }));
  const toggleOption = (option: string, on: boolean) => setPolicy({ syncOptions: on ? [...form.policy.syncOptions, option] : form.policy.syncOptions.filter((o) => o !== option) });

  const known = MANAGE_OPTIONS.map(([option]) => option);
  const options: [string, string][] = [...MANAGE_OPTIONS, ...form.policy.syncOptions.filter((o) => !known.includes(o)).map((o): [string, string] => [o, o])];
  const { policy } = form;

  return (
    <div className="mg-form">
      <section className="k8s-sect" aria-label={MANAGE_FORM_POLICY}>
        <h4>{MANAGE_FORM_POLICY}</h4>
        <label className="k8s-check argo-opt">
          <input type="checkbox" checked={policy.automated} onChange={(e) => setPolicy({ automated: e.target.checked })} />
          {MANAGE_AUTOMATED}
        </label>
        <div className="mg-indent">
          {(
            [
              ["prune", MANAGE_PRUNE],
              ["selfHeal", MANAGE_SELF_HEAL],
              ["allowEmpty", MANAGE_ALLOW_EMPTY],
            ] as const
          ).map(([flag, label]) => (
            <label key={flag} className="k8s-check argo-opt">
              <input type="checkbox" checked={policy[flag]} disabled={!policy.automated} onChange={(e) => setPolicy({ [flag]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
        <h4>{MANAGE_SYNC_OPTIONS}</h4>
        <div className="mg-options">
          {options.map(([option, label]) => (
            <label key={option} className="k8s-check argo-opt" title={option}>
              <input type="checkbox" checked={policy.syncOptions.includes(option)} onChange={(e) => toggleOption(option, e.target.checked)} />
              {label}
            </label>
          ))}
        </div>
      </section>

      {form.sources.length === 0 && <p className="dim">{MANAGE_NO_SOURCES}</p>}
      {form.sources.map((source, index) => (
        <SourceSection key={index} title={manageSourceTitle(index, form.sources.length, repoOf(spec, index))} source={source} onChange={(next) => setSource(index, next)} />
      ))}

      {problems.length > 0 && (
        <ul className="err mg-problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{manageFormProblem(p)}</li>
          ))}
        </ul>
      )}
      <div className="mg-foot">
        <button className="btn small tone-primary" disabled={disabled || problems.length > 0 || patch === null} title={disabled ? disabledReason : patch === null ? MANAGE_NO_CHANGE : undefined} onClick={() => patch && onPreview(patch)}>
          {MANAGE_FORM_PREVIEW}
        </button>
      </div>
    </div>
  );
}

function SourceSection({ title, source, onChange }: { title: string; source: SourceForm; onChange: (next: Partial<SourceForm>) => void }) {
  const setParam = (index: number, next: Partial<ParamRow>) => onChange({ params: source.params.map((p, i) => (i === index ? { ...p, ...next } : p)) });
  const setImage = (index: number, value: string) => onChange({ images: source.images.map((v, i) => (i === index ? value : v)) });
  return (
    <section className="k8s-sect" aria-label={title}>
      <h4>{title}</h4>
      <label className="mg-field">
        {MANAGE_TARGET_REVISION}
        <input value={source.targetRevision} onChange={(e) => onChange({ targetRevision: e.target.value })} />
      </label>

      <details className="mg-details" open={source.helmValues !== "" || source.valuesObject !== null || source.params.length > 0}>
        <summary>{MANAGE_HELM}</summary>
        <div className="mg-field">
          <span>{MANAGE_HELM_VALUES}</span>
          <CodeEditor value={source.helmValues} onChange={(helmValues) => onChange({ helmValues })} label={MANAGE_HELM_VALUES} minHeight="120px" />
        </div>
        {source.valuesObject !== null && (
          <div className="mg-field">
            <span>{MANAGE_HELM_VALUES_OBJECT}</span>
            <CodeEditor value={source.valuesObject} onChange={(valuesObject) => onChange({ valuesObject })} label={MANAGE_HELM_VALUES_OBJECT} minHeight="120px" />
          </div>
        )}
        <div className="mg-field">
          <span>{MANAGE_HELM_PARAMS}</span>
          {source.params.map((p, i) => (
            <div key={i} className="mg-row">
              <input aria-label={MANAGE_PARAM_NAME} placeholder={MANAGE_PARAM_NAME} value={p.name} onChange={(e) => setParam(i, { name: e.target.value })} />
              <input aria-label={MANAGE_PARAM_VALUE} placeholder={MANAGE_PARAM_VALUE} value={p.value} onChange={(e) => setParam(i, { value: e.target.value })} />
              <label className="k8s-check">
                <input type="checkbox" checked={p.forceString} onChange={(e) => setParam(i, { forceString: e.target.checked })} />
                {MANAGE_PARAM_FORCE}
              </label>
              <button className="btn small tone-secondary" onClick={() => onChange({ params: source.params.filter((_, n) => n !== i) })}>
                {MANAGE_REMOVE}
              </button>
            </div>
          ))}
          <button className="btn small tone-secondary" onClick={() => onChange({ params: [...source.params, { name: "", value: "", forceString: false }] })}>
            {MANAGE_PARAM_ADD}
          </button>
        </div>
      </details>

      <details className="mg-details" open={source.images.length > 0 || source.namePrefix !== "" || source.nameSuffix !== ""}>
        <summary>{MANAGE_KUSTOMIZE}</summary>
        <div className="mg-field">
          <span>{MANAGE_KUSTOMIZE_IMAGES}</span>
          {source.images.map((image, i) => (
            <div key={i} className="mg-row">
              <input aria-label={MANAGE_KUSTOMIZE_IMAGES} value={image} onChange={(e) => setImage(i, e.target.value)} />
              <button className="btn small tone-secondary" onClick={() => onChange({ images: source.images.filter((_, n) => n !== i) })}>
                {MANAGE_REMOVE}
              </button>
            </div>
          ))}
          <button className="btn small tone-secondary" onClick={() => onChange({ images: [...source.images, ""] })}>
            {MANAGE_IMAGE_ADD}
          </button>
        </div>
        <label className="mg-field">
          {MANAGE_NAME_PREFIX}
          <input value={source.namePrefix} onChange={(e) => onChange({ namePrefix: e.target.value })} />
        </label>
        <label className="mg-field">
          {MANAGE_NAME_SUFFIX}
          <input value={source.nameSuffix} onChange={(e) => onChange({ nameSuffix: e.target.value })} />
        </label>
      </details>
    </section>
  );
}
