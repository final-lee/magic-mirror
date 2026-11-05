import { parse, stringify } from "yaml";

/** Application.spec 같은 JSON 객체 */
export type Obj = Record<string, unknown>;

export interface ParamRow {
  name: string;
  value: string;
  forceString: boolean;
}

/** 소스 하나의 폼 값. valuesObject는 YAML 글이고, 이 소스에 없으면 null(편집기를 보이지 않는다) */
export interface SourceForm {
  targetRevision: string;
  helmValues: string;
  valuesObject: string | null;
  params: ParamRow[];
  images: string[];
  namePrefix: string;
  nameSuffix: string;
}

export interface PolicyForm {
  automated: boolean;
  prune: boolean;
  selfHeal: boolean;
  allowEmpty: boolean;
  /** `Name=true` 꼴 전체(폼이 모르는 옵션도 그대로 둔다) */
  syncOptions: string[];
}

export interface SpecForm {
  policy: PolicyForm;
  sources: SourceForm[];
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObj(a) && isObj(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** 소스가 여럿인 앱은 spec.sources, 하나뿐이면 spec.source에 있다 */
export const isMultiSource = (spec: Obj) => Array.isArray(spec.sources);

function sourcesOf(spec: Obj): Obj[] {
  if (Array.isArray(spec.sources)) return spec.sources.map(obj);
  return isObj(spec.source) ? [spec.source] : [];
}

const paramsOf = (helm: Obj): ParamRow[] =>
  (Array.isArray(helm.parameters) ? helm.parameters : []).map((p) => ({ name: str(obj(p).name), value: str(obj(p).value), forceString: obj(p).forceString === true }));


function sourceForm(source: Obj): SourceForm {
  const helm = obj(source.helm);
  const kustomize = obj(source.kustomize);
  return {
    targetRevision: str(source.targetRevision),
    helmValues: str(helm.values),
    valuesObject: isObj(helm.valuesObject) ? stringify(helm.valuesObject) : null,
    params: paramsOf(helm),
    images: (Array.isArray(kustomize.images) ? kustomize.images : []).filter((i): i is string => typeof i === "string"),
    namePrefix: str(kustomize.namePrefix),
    nameSuffix: str(kustomize.nameSuffix),
  };
}

const automatedOf = (spec: Obj) => {
  const a = obj(spec.syncPolicy).automated;
  return isObj(a) ? a : null;
};
/** automated가 있어도 enabled가 false면 꺼진 것이다 */
const automatedOn = (a: Obj | null) => a !== null && a.enabled !== false;

/** 지금 spec에서 폼의 처음 값을 만든다 */
export function formOf(spec: Obj): SpecForm {
  const automated = automatedOf(spec);
  return {
    policy: {
      automated: automatedOn(automated),
      prune: automated?.prune === true,
      selfHeal: automated?.selfHeal === true,
      allowEmpty: automated?.allowEmpty === true,
      syncOptions: (Array.isArray(obj(spec.syncPolicy).syncOptions) ? (obj(spec.syncPolicy).syncOptions as unknown[]) : []).filter((o): o is string => typeof o === "string"),
    },
    sources: sourcesOf(spec).map(sourceForm),
  };
}

/** 폼에서 읽을 수 없는 곳(valuesObject YAML 오류·이름 없는 파라미터)의 설명. 비면 미리 볼 수 있다 */
export function formProblems(form: SpecForm): string[] {
  const problems: string[] = [];
  form.sources.forEach((s, i) => {
    if (s.valuesObject !== null) {
      try {
        const v: unknown = parse(s.valuesObject);
        if (v !== null && !isObj(v)) problems.push(`${i + 1}:valuesObject-shape`);
      } catch {
        problems.push(`${i + 1}:valuesObject-yaml`);
      }
    }
    if (s.params.some((p) => p.name.trim() === "" && p.value !== "")) problems.push(`${i + 1}:param-name`);
  });
  return problems;
}

/** valuesObject 글을 객체로. 읽을 수 없으면 null */
function valuesObjectOf(text: string): Obj | null {
  try {
    const v: unknown = parse(text);
    return v === null || v === undefined ? {} : isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** 값이 비면 키를 뺀다. 같으면 건드리지 않는다 */
function setOrDrop(target: Obj, key: string, value: unknown, empty: boolean) {
  if (empty) delete target[key];
  else target[key] = value;
}

function applyPolicy(spec: Obj, form: PolicyForm) {
  const before = automatedOf(spec);
  const policy = obj(spec.syncPolicy);
  if (form.automated) {
    const next: Obj = { ...(before ?? {}) };
    delete next.enabled;
    for (const flag of ["prune", "selfHeal", "allowEmpty"] as const) {
      if (form[flag] !== (next[flag] === true)) setOrDrop(next, flag, true, !form[flag]);
    }
    policy.automated = next;
  } else if (automatedOn(before)) {
    delete policy.automated;
  }
  const options = Array.isArray(policy.syncOptions) ? policy.syncOptions : [];
  if (!deepEqual(options, form.syncOptions)) setOrDrop(policy, "syncOptions", form.syncOptions, form.syncOptions.length === 0);
  if (Object.keys(policy).length > 0 || isObj(spec.syncPolicy)) spec.syncPolicy = policy;
}

function applySource(source: Obj, form: SourceForm) {
  if (form.targetRevision !== str(source.targetRevision)) setOrDrop(source, "targetRevision", form.targetRevision, form.targetRevision === "");

  const helm = obj(source.helm);
  if (form.helmValues !== str(helm.values)) setOrDrop(helm, "values", form.helmValues, form.helmValues.trim() === "");
  if (form.valuesObject !== null) {
    const parsed = valuesObjectOf(form.valuesObject);
    if (parsed !== null && !deepEqual(parsed, helm.valuesObject ?? {})) setOrDrop(helm, "valuesObject", parsed, Object.keys(parsed).length === 0);
  }
  const params = form.params.filter((p) => p.name.trim() !== "").map((p) => ({ name: p.name.trim(), value: p.value, ...(p.forceString ? { forceString: true } : {}) }));
  if (!deepEqual(params, paramsOf(helm).map((p) => ({ name: p.name, value: p.value, ...(p.forceString ? { forceString: true } : {}) })))) setOrDrop(helm, "parameters", params, params.length === 0);
  if (Object.keys(helm).length > 0 || isObj(source.helm)) source.helm = helm;

  const kustomize = obj(source.kustomize);
  const images = form.images.map((i) => i.trim()).filter(Boolean);
  if (!deepEqual(images, obj(source.kustomize).images ?? [])) setOrDrop(kustomize, "images", images, images.length === 0);
  if (form.namePrefix !== str(kustomize.namePrefix)) setOrDrop(kustomize, "namePrefix", form.namePrefix, form.namePrefix === "");
  if (form.nameSuffix !== str(kustomize.nameSuffix)) setOrDrop(kustomize, "nameSuffix", form.nameSuffix, form.nameSuffix === "");
  if (Object.keys(kustomize).length > 0 || isObj(source.kustomize)) source.kustomize = kustomize;
}

/** 폼 값을 반영한 새 spec(원본은 건드리지 않는다) */
export function applyForm(spec: Obj, form: SpecForm): Obj {
  const next = structuredClone(spec);
  applyPolicy(next, form.policy);
  const sources = Array.isArray(next.sources) ? (next.sources as Obj[]) : isObj(next.source) ? [next.source] : [];
  form.sources.forEach((f, i) => {
    if (sources[i]) applySource(sources[i], f);
  });
  return next;
}

/** RFC 7386 병합 패치: 달라진 곳만. 지운 키는 null, 배열은 통째로 바꾼다. 같으면 undefined */
export function mergePatch(before: unknown, after: unknown): unknown {
  if (deepEqual(before, after)) return undefined;
  if (!isObj(before) || !isObj(after)) return after;
  const patch: Obj = {};
  for (const key of Object.keys(before)) if (!(key in after)) patch[key] = null;
  for (const key of Object.keys(after)) {
    const sub = mergePatch(before[key], after[key]);
    if (sub !== undefined) patch[key] = sub;
  }
  return patch;
}

/** 폼에서 만든 appPatch의 patch. 바뀐 게 없으면 null */
export function formPatch(spec: Obj, form: SpecForm): { spec: unknown } | null {
  const patch = mergePatch(spec, applyForm(spec, form));
  return patch === undefined ? null : { spec: patch };
}
