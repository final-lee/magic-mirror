import { BUILTIN } from "./kinds";
import * as t from "./text";
import type { K8sKind } from "./types";
import { parseDocuments, resolveChange, yamlProblems } from "./yamlDocs";

const widget: K8sKind = { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true, verbs: ["list"], custom: true };

test("documents are split, empty ones are skipped and non-objects are reported", () => {
  const docs = parseDocuments("---\na: 1\n---\n# 주석만\n---\n- x\n---\nb: 2\n---\njust text\n");
  expect(docs.map((d) => [d.index, d.object, d.error])).toEqual([
    [1, { a: 1 }, null],
    [3, null, t.YAML_NOT_OBJECT],
    [4, { b: 2 }, null],
    [5, null, t.YAML_NOT_OBJECT],
  ]);
});

test("syntax problems carry a line, a column and a position", () => {
  expect(yamlProblems("a: 1\nb: 2\n")).toEqual([]);
  const problems = yamlProblems("a: [1,\nb: 2\nc: {\n");
  expect(problems.length).toBeGreaterThan(0);
  expect(problems[0].line).toBeGreaterThan(0);
  expect(problems[0].to).toBeGreaterThanOrEqual(problems[0].from);
  expect(yamlProblems("a: 1\na: 2\n")[0].message).toMatch(/unique/i);
  expect(parseDocuments("a: [1,\n")[0]).toEqual({ index: 1, object: null, error: t.YAML_SYNTAX_ERROR });
});

test("kinds come from apiVersion and kind; documents without a namespace use the selected one", () => {
  const kinds = [widget];
  const cm = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "c" } };
  const fromBuiltin = resolveChange(cm, kinds, "team");
  expect(fromBuiltin.change).toMatchObject({ namespace: "team", name: "c", type: "apply", force: false, kind: { kind: "ConfigMap", plural: "configmaps", namespaced: true } });
  expect(resolveChange({ ...cm, metadata: { name: "c", namespace: "own" } }, kinds, "team").change).toMatchObject({ namespace: "own" });
  expect(resolveChange(cm, kinds, null)).toEqual({ change: null, error: t.YAML_NO_NAMESPACE });
  expect(resolveChange({ apiVersion: "mm.example.com/v1", kind: "Widget", metadata: { name: "w" } }, kinds, "team").change).toMatchObject({ kind: { plural: "widgets" } });
  expect(resolveChange({ apiVersion: "mm.example.com/v2", kind: "Widget", metadata: { name: "w" } }, kinds, "team").error).toBe(t.yamlKindUnknown("mm.example.com/v2", "Widget"));
  expect(resolveChange({ apiVersion: "v1", kind: "Namespace", metadata: { name: "n" } }, kinds, null).change).toMatchObject({ namespace: null, kind: { namespaced: false } });
  expect(resolveChange({ apiVersion: "v1", kind: "Namespace", metadata: { name: "n", namespace: "x" } }, kinds, "team").error).toBe(t.yamlNotNamespaced("Namespace"));
  expect(resolveChange({ kind: "ConfigMap", metadata: { name: "c" } }, kinds, "team").error).toBe(t.YAML_NO_KIND);
  expect(resolveChange({ apiVersion: "v1", kind: "ConfigMap", metadata: {} }, kinds, "team").error).toBe(t.YAML_NO_NAME);
  expect(BUILTIN.some((k) => k.kind === "ConfigMap")).toBe(true);
});
