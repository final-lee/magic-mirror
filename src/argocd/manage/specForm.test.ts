import { applyForm, formOf, formPatch, formProblems, mergePatch, type Obj, type SpecForm } from "./specForm";

const single = (): Obj => ({
  project: "default",
  source: { repoURL: "https://git/x.git", targetRevision: "main", path: "chart", helm: { parameters: [{ name: "image.tag", value: "1" }], valuesObject: { replicas: 2, nested: { a: 1 } } } },
  syncPolicy: { automated: { prune: true, selfHeal: true }, syncOptions: ["CreateNamespace=true"] },
});

const multi = (): Obj => ({
  sources: [
    { repoURL: "https://charts", chart: "web", targetRevision: "1.0.0", helm: { values: "a: 1\n" } },
    { repoURL: "https://git/x.git", targetRevision: "main", ref: "values" },
  ],
});

/** 폼을 한 번 고쳐 만든 병합 패치 */
const patchOf = (spec: Obj, edit: (form: SpecForm) => void) => {
  const form = formOf(spec);
  edit(form);
  return formPatch(spec, form);
};

test("a form with no edits makes no patch", () => {
  expect(formPatch(single(), formOf(single()))).toBeNull();
  expect(formPatch(multi(), formOf(multi()))).toBeNull();
});

test("turning automated sync off removes the key with null and keeps everything else", () => {
  const patch = patchOf(single(), (f) => {
    f.policy.automated = false;
  });
  expect(patch).toEqual({ spec: { syncPolicy: { automated: null } } });
});

test("a single flag change touches only that flag", () => {
  expect(patchOf(single(), (f) => { f.policy.selfHeal = false; })).toEqual({ spec: { syncPolicy: { automated: { selfHeal: null } } } });
});

test("turning automated on from nothing creates it with the chosen flags", () => {
  const spec: Obj = { source: { repoURL: "r" } };
  expect(patchOf(spec, (f) => { f.policy.automated = true; f.policy.prune = true; })).toEqual({ spec: { syncPolicy: { automated: { prune: true } } } });
  expect(patchOf(spec, (f) => { f.policy.automated = true; })).toEqual({ spec: { syncPolicy: { automated: {} } } });
});

test("an automated block disabled by enabled:false counts as off and stays untouched", () => {
  const spec: Obj = { syncPolicy: { automated: { enabled: false, prune: true } } };
  expect(formOf(spec).policy.automated).toBe(false);
  expect(formPatch(spec, formOf(spec))).toBeNull();
});

test("sync options are replaced as a whole list and an emptied list is removed", () => {
  expect(patchOf(single(), (f) => { f.policy.syncOptions = [...f.policy.syncOptions, "PruneLast=true"]; })).toEqual({ spec: { syncPolicy: { syncOptions: ["CreateNamespace=true", "PruneLast=true"] } } });
  expect(patchOf(single(), (f) => { f.policy.syncOptions = []; })).toEqual({ spec: { syncPolicy: { syncOptions: null } } });
});

test("editing a helm parameter replaces the parameter list; the rest of the source is untouched", () => {
  const patch = patchOf(single(), (f) => {
    f.sources[0].params[0].value = "2";
    f.sources[0].params.push({ name: "debug", value: "true", forceString: true });
  });
  expect(patch).toEqual({ spec: { source: { helm: { parameters: [{ name: "image.tag", value: "2" }, { name: "debug", value: "true", forceString: true }] } } } });
});

test("removing every helm parameter drops the key", () => {
  expect(patchOf(single(), (f) => { f.sources[0].params = []; })).toEqual({ spec: { source: { helm: { parameters: null } } } });
});

test("valuesObject edits become a minimal object patch with removed keys as null", () => {
  const patch = patchOf(single(), (f) => {
    f.sources[0].valuesObject = "replicas: 3\n";
  });
  expect(patch).toEqual({ spec: { source: { helm: { valuesObject: { replicas: 3, nested: null } } } } });
});

test("adding a kustomize image creates the kustomize block with only that image", () => {
  const patch = patchOf(single(), (f) => {
    f.sources[0].images = ["nginx=nginx:1.27"];
    f.sources[0].namePrefix = "stg-";
  });
  expect(patch).toEqual({ spec: { source: { kustomize: { images: ["nginx=nginx:1.27"], namePrefix: "stg-" } } } });
});

test("in a multi-source app only the chosen source changes, and the sources array is sent whole", () => {
  const patch = patchOf(multi(), (f) => {
    f.sources[1].targetRevision = "release";
  });
  expect(patch).toEqual({
    spec: {
      sources: [
        { repoURL: "https://charts", chart: "web", targetRevision: "1.0.0", helm: { values: "a: 1\n" } },
        { repoURL: "https://git/x.git", targetRevision: "release", ref: "values" },
      ],
    },
  });
  expect(patchOf(multi(), (f) => { f.sources[0].helmValues = "a: 2\n"; })).toEqual({ spec: { sources: [{ repoURL: "https://charts", chart: "web", targetRevision: "1.0.0", helm: { values: "a: 2\n" } }, multi().sources && (multi().sources as Obj[])[1]] } });
});

test("applyForm never mutates the original spec", () => {
  const spec = single();
  const copy = structuredClone(spec);
  applyForm(spec, { ...formOf(spec), policy: { ...formOf(spec).policy, automated: false } });
  expect(spec).toEqual(copy);
});

test("an unreadable valuesObject or a value without a parameter name blocks the preview", () => {
  const form = formOf(single());
  expect(formProblems(form)).toEqual([]);
  form.sources[0].valuesObject = "a: [";
  expect(formProblems(form)).toEqual(["1:valuesObject-yaml"]);
  form.sources[0].valuesObject = "- list\n";
  expect(formProblems(form)).toEqual(["1:valuesObject-shape"]);
  form.sources[0].valuesObject = null;
  form.sources[0].params.push({ name: " ", value: "x", forceString: false });
  expect(formProblems(form)).toEqual(["1:param-name"]);
});

test("mergePatch follows RFC 7386: removed keys null, arrays replaced, equal parts omitted", () => {
  expect(mergePatch({ a: 1, b: { c: 1, d: 2 }, e: [1, 2] }, { a: 1, b: { c: 1 }, e: [1, 2, 3] })).toEqual({ b: { d: null }, e: [1, 2, 3] });
  expect(mergePatch({ a: 1 }, { a: 1 })).toBeUndefined();
});
