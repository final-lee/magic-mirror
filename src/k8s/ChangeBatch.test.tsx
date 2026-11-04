import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { editorView, typeYaml } from "../test/codemirror";
import { k8sApi } from "./api";
import { BatchDialog, useK8sBatch } from "./ChangeBatch";
import { ChangeDialog, useK8sChange } from "./ChangeFlow";
import { CONFIGMAPS } from "./kinds";
import * as t from "./text";
import type { K8sChange, K8sPreview } from "./types";
import { YamlCreate } from "./YamlCreate";

vi.mock("./api", () => ({ k8sApi: { preview: vi.fn(), apply: vi.fn(), undo: vi.fn() } }));
const api = vi.mocked(k8sApi);
const T = { profile: "p", region: "r", cluster: "c" };

const calm = (over: Partial<K8sPreview> = {}): K8sPreview => ({
  calls: [{ verb: "PATCH", path: "/p", body: null }], diff: [], impact: ["영향"], warnings: [], confirmName: null, reversible: true, conflicts: [], ...over,
});
const nameOf = (change: K8sChange) => change.name;

const DOCS = `apiVersion: v1
kind: ConfigMap
metadata:
  name: first
data: {a: "1"}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: second
  namespace: other
spec: {replicas: 1}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: third
`;

function Harness({ namespace = "team", onApplied = vi.fn() }: { namespace?: string | null; onApplied?: (changes: K8sChange[]) => void }) {
  const batch = useK8sBatch(T, "p", onApplied);
  const [open, setOpen] = useState(true);
  return (
    <>
      {open && !batch.batch && (
        <YamlCreate kinds={[]} namespace={namespace} onClose={() => setOpen(false)}
          onPreview={(entries) => {
            setOpen(false);
            batch.api.start(entries);
          }} />
      )}
      {batch.batch && <BatchDialog batch={batch.batch} api={batch.api} />}
    </>
  );
}

const start = async (docs = DOCS) => {
  typeYaml(docs);
  fireEvent.click(screen.getByRole("button", { name: t.YAML_PREVIEW }));
  await screen.findByRole("dialog", { name: t.BATCH_TITLE });
};
const section = (index: number, kind: string, name: string) => screen.getByRole("region", { name: t.batchItem(index, kind, name) });

beforeEach(() => {
  vi.resetAllMocks();
  api.preview.mockImplementation(async (_t, change) => calm({ impact: [`영향 ${nameOf(change)}`] }));
  api.apply.mockImplementation(async (_t, change) => ({ logId: `log-${nameOf(change)}` }));
});

test("every document is previewed on its own, the selected namespace fills a missing one, and they apply in order", async () => {
  const onApplied = vi.fn();
  render(<Harness onApplied={onApplied} />);
  await start();
  expect(api.preview.mock.calls.map(([, change]) => [change.name, change.namespace])).toEqual([["first", "team"], ["second", "other"], ["third", "team"]]);
  expect(await within(section(1, "ConfigMap", "first")).findByText("영향 first")).toBeInTheDocument();
  expect(within(section(2, "Deployment", "second")).getByText("영향 second")).toBeInTheDocument();
  expect(within(section(3, "ConfigMap", "third")).getByText("영향 third")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: t.BATCH_APPLY(3) }));
  await screen.findByText(t.BATCH_DONE);
  expect(api.apply.mock.calls.map(([, change, confirm, undoOf]) => [change.name, confirm, undoOf])).toEqual([["first", null, null], ["second", null, null], ["third", null, null]]);
  expect(onApplied).toHaveBeenCalledTimes(1);
  expect(onApplied.mock.calls[0][0].map(nameOf)).toEqual(["first", "second", "third"]);
});

test("a document without a namespace is an error when all namespaces are selected, and nothing is previewed", async () => {
  render(<Harness namespace={null} />);
  typeYaml(DOCS);
  fireEvent.click(screen.getByRole("button", { name: t.YAML_PREVIEW }));
  const errors = screen.getByRole("list", { name: t.YAML_DOCUMENT_ERRORS });
  expect(within(errors).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    t.yamlDocumentError(1, t.YAML_NO_NAMESPACE),
    t.yamlDocumentError(3, t.YAML_NO_NAMESPACE),
  ]);
  expect(api.preview).not.toHaveBeenCalled();
});

test("syntax errors and unknown kinds block the preview with the document number", async () => {
  render(<Harness />);
  typeYaml("a: [1,\n");
  expect(screen.getByRole("button", { name: t.YAML_PREVIEW })).toBeDisabled();
  typeYaml("apiVersion: v9\nkind: Nope\nmetadata: {name: x}\n");
  fireEvent.click(screen.getByRole("button", { name: t.YAML_PREVIEW }));
  expect(screen.getByText(t.yamlDocumentError(1, t.yamlKindUnknown("v9", "Nope")))).toBeInTheDocument();
  expect(api.preview).not.toHaveBeenCalled();
});

test("apply stops at the first failure, skips the rest and undoes the applied documents in reverse order", async () => {
  api.apply.mockImplementation(async (_t, change) => {
    if (change.name === "second") throw { kind: "other", message: "boom" };
    return { logId: `log-${change.name}` };
  });
  api.undo.mockImplementation(async (logId) => ({ target: T, change: { kind: CONFIGMAPS, namespace: "team", name: `undo-${logId}`, type: "delete" } }));
  render(<Harness />);
  await start();
  await screen.findAllByText(/영향 third/);
  fireEvent.click(screen.getByRole("button", { name: t.BATCH_APPLY(3) }));
  await screen.findByText(t.BATCH_STOPPED);
  expect(api.apply.mock.calls.map(([, change]) => change.name)).toEqual(["first", "second"]);
  expect(within(section(1, "ConfigMap", "first")).getByText(t.BATCH_APPLIED)).toBeInTheDocument();
  expect(within(section(2, "Deployment", "second")).getByText(t.BATCH_FAILED)).toBeInTheDocument();
  expect(within(section(2, "Deployment", "second")).getByText(/boom/)).toBeInTheDocument();
  expect(within(section(3, "ConfigMap", "third")).getByText(t.BATCH_SKIPPED)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /개 적용/ })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: t.BATCH_UNDO_APPLIED }));
  await screen.findByRole("dialog", { name: t.BATCH_UNDO_TITLE });
  expect(api.undo).toHaveBeenCalledTimes(1);
  expect(api.undo).toHaveBeenCalledWith("log-first");
  await waitFor(() => expect(api.preview.mock.calls.map(([, change]) => change.name)).toContain("undo-log-first"));
  await screen.findByRole("button", { name: t.BATCH_APPLY(1) });
  api.apply.mockClear();
  fireEvent.click(screen.getByRole("button", { name: t.BATCH_APPLY(1) }));
  await screen.findByText(t.BATCH_DONE);
  expect(api.apply).toHaveBeenCalledWith(T, expect.objectContaining({ name: "undo-log-first" }), null, "log-first", "p");
});

test("a document that cannot be previewed yet waits: the ones before it apply first and the rest is previewed again", async () => {
  let namespaceExists = false;
  api.preview.mockImplementation(async (_t, change) => {
    if (change.name === "second" && !namespaceExists) throw { kind: "other", message: "namespace not found" };
    return calm({ impact: [`영향 ${change.name}`] });
  });
  api.apply.mockImplementation(async (_t, change) => {
    if (change.name === "first") namespaceExists = true;
    return { logId: `log-${change.name}` };
  });
  render(<Harness />);
  await start();
  await screen.findByText(/namespace not found/);
  expect(screen.getByText(t.BATCH_PARTIAL(1))).toBeInTheDocument();
  expect(screen.getByRole("button", { name: t.BATCH_APPLY(1) })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: t.BATCH_APPLY(1) }));
  await screen.findByRole("button", { name: t.BATCH_APPLY(2) });
  expect(api.apply.mock.calls.map(([, change]) => change.name)).toEqual(["first"]);
  expect(screen.queryByText(/namespace not found/)).not.toBeInTheDocument();
});

test("each document asks for its own confirmation name before it can be applied", async () => {
  api.preview.mockImplementation(async (_t, change) => calm({ confirmName: change.name === "second" ? "second" : null }));
  render(<Harness />);
  await start();
  const apply = await screen.findByRole("button", { name: t.BATCH_APPLY(3) });
  expect(apply).toBeDisabled();
  fireEvent.change(screen.getByLabelText(t.CHANGE_CONFIRM), { target: { value: "second" } });
  expect(apply).toBeEnabled();
  fireEvent.click(apply);
  await screen.findByText(t.BATCH_DONE);
  expect(api.apply.mock.calls.map(([, change, confirm]) => [change.name, confirm])).toEqual([["first", null], ["second", "second"], ["third", null]]);
});

const conflicted = calm({ conflicts: [{ field: ".spec.replicas", manager: "kubectl-client-side-apply" }], diff: [] });

test("a conflicting document lists the field and its manager, cannot be applied, and force needs the typed name", async () => {
  api.preview.mockImplementation(async (_t, change) => (change.type === "apply" && change.force ? calm({ confirmName: change.name }) : conflicted));
  render(<Harness />);
  await start("apiVersion: v1\nkind: ConfigMap\nmetadata: {name: only}\n");
  const only = section(1, "ConfigMap", "only");
  expect(await within(only).findByText(".spec.replicas")).toBeInTheDocument();
  expect(within(only).getByText("kubectl-client-side-apply")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: t.BATCH_APPLY(0) })).toBeDisabled();
  fireEvent.click(within(only).getByRole("button", { name: t.CHANGE_FORCE }));
  await waitFor(() => expect(api.preview).toHaveBeenLastCalledWith(T, expect.objectContaining({ type: "apply", force: true }), "p"));
  const apply = await screen.findByRole("button", { name: t.BATCH_APPLY(1) });
  expect(apply).toBeDisabled();
  fireEvent.change(within(only).getByLabelText(t.CHANGE_CONFIRM), { target: { value: "only" } });
  fireEvent.click(apply);
  await screen.findByText(t.BATCH_DONE);
  expect(api.apply).toHaveBeenCalledWith(T, expect.objectContaining({ force: true }), "only", null, "p");
});

function Single({ change }: { change: K8sChange }) {
  const flow = useK8sChange(T, "p", () => {});
  return (
    <>
      <button onClick={() => flow.start(change)}>start</button>
      {flow.pending && <ChangeDialog pending={flow.pending} apply={flow.apply} retry={flow.retry} cancel={flow.cancel} force={flow.force} />}
    </>
  );
}

test("a single edit with conflicts is blocked until it is previewed again with force, which then needs the name", async () => {
  const change: K8sChange = { kind: CONFIGMAPS, namespace: "team", name: "app", type: "apply", object: { kind: "ConfigMap" }, force: false };
  api.preview.mockImplementation(async (_t, c) => (c.type === "apply" && c.force ? calm({ confirmName: "app", warnings: [t.CHANGE_FORCE_NOTE] }) : conflicted));
  render(<Single change={change} />);
  fireEvent.click(screen.getByText("start"));
  expect(await screen.findByText("kubectl-client-side-apply")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: t.CHANGE_APPLY })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: t.CHANGE_FORCE }));
  await waitFor(() => expect(api.preview).toHaveBeenLastCalledWith(T, { ...change, force: true }, "p"));
  const apply = await screen.findByRole("button", { name: t.CHANGE_APPLY });
  await screen.findByLabelText(t.CHANGE_CONFIRM);
  expect(apply).toBeDisabled();
  fireEvent.change(screen.getByLabelText(t.CHANGE_CONFIRM), { target: { value: "app" } });
  await act(async () => fireEvent.click(apply));
  expect(api.apply).toHaveBeenCalledWith(T, { ...change, force: true }, "app", null, "p");
});

test("the preview says when the change cannot be undone", async () => {
  api.preview.mockResolvedValue(calm({ reversible: false, warnings: ["Secret 변경은 값을 기록하지 않아 되돌릴 수 없어요"] }));
  render(<Single change={{ kind: CONFIGMAPS, namespace: "team", name: "app", type: "apply", object: {}, force: false }} />);
  fireEvent.click(screen.getByText("start"));
  expect(await screen.findByText("되돌릴 수 없어요")).toBeInTheDocument();
});

test("in the YAML create dialog Tab indents inside the editor and Esc there does not close the dialog; Esc elsewhere does", () => {
  render(<Harness />);
  const box = screen.getByRole("textbox", { name: t.YAML_EDITOR_LABEL });
  typeYaml("a:\nb: 1");
  const view = editorView();
  view.focus();
  view.dispatch({ selection: { anchor: 3 } });
  fireEvent.keyDown(box, { key: "Tab" });
  expect(view.state.doc.toString()).toBe("a:\n  b: 1");
  expect(box).toHaveFocus();
  fireEvent.keyDown(box, { key: "Escape", keyCode: 27 });
  expect(screen.getByRole("dialog", { name: t.YAML_CREATE })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("button", { name: t.CHANGE_CANCEL }), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: t.YAML_CREATE })).not.toBeInTheDocument();
});
