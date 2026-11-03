import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { editorView, typeYaml } from "../test/codemirror";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { CONFIGMAPS, SECRETS } from "./kinds";
import { ObjectDetail } from "./ObjectDetail";
import * as t from "./text";
import type { K8sKindRef, K8sObjectView, K8sRules } from "./types";

vi.mock("./api", () => ({ k8sApi: { get: vi.fn(), rules: vi.fn(), secretValue: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };

const CONFIG_YAML = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: prod\ndata:\n  level: info\n";
const row = (name: string) => ({ uid: "u", name, namespace: "prod", resourceVersion: "7", createdAt: null, labels: {}, values: {}, problems: [] });
const view = (kind: K8sKindRef, name: string, over: Partial<K8sObjectView> = {}): K8sObjectView => ({
  kind, row: row(name), annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null, containers: [], conditions: [], events: [], eventsError: null,
  yaml: `${CONFIG_YAML}status: {}\n`, editYaml: CONFIG_YAML, secretKeys: null, ...over,
});
const allowed: K8sRules = { namespace: "prod", incomplete: true, nonResourceRules: [], resourceRules: [] };

function setup(kind: K8sKindRef, name: string) {
  const onChange = vi.fn();
  render(withClientAndSso(
    <ObjectDetail target={T} context="ctx" ssoProfile="p" live objectRef={{ kind, namespace: "prod", name }} resourceVersion="7" kinds={[]}
      onOpen={vi.fn()} onBack={null} onClose={vi.fn()} onChange={onChange} />,
    newQueryClient(), ssoLoginStub(),
  ));
  return onChange;
}
const openYaml = async () => {
  fireEvent.click(await screen.findByRole("tab", { name: t.TAB_YAML }));
};
const edit = async () => {
  await openYaml();
  fireEvent.click(await screen.findByRole("button", { name: t.YAML_EDIT }));
};

beforeEach(() => {
  vi.resetAllMocks();
  m.rules.mockResolvedValue(allowed);
});

test("editing shows the cleaned YAML in an editor and cancel returns to the read-only view", async () => {
  m.get.mockResolvedValue(view(CONFIGMAPS, "app"));
  setup(CONFIGMAPS, "app");
  await openYaml();
  expect(document.querySelector(".k8s-yaml")?.textContent).toContain("status:");
  fireEvent.click(await screen.findByRole("button", { name: t.YAML_EDIT }));
  expect(screen.getByLabelText(t.YAML_EDITOR_LABEL)).toBeInTheDocument();
  expect(editorView().state.doc.toString()).toBe(CONFIG_YAML);
  expect(editorView().state.doc.toString()).not.toContain("status");
  fireEvent.click(screen.getByRole("button", { name: t.YAML_CANCEL_EDIT }));
  expect(screen.queryByLabelText(t.YAML_EDITOR_LABEL)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: t.YAML_EDIT })).toBeInTheDocument();
});

test("a missing patch permission disables editing with the reason", async () => {
  m.get.mockResolvedValue(view(CONFIGMAPS, "app"));
  m.rules.mockResolvedValue({ ...allowed, incomplete: false });
  setup(CONFIGMAPS, "app");
  await openYaml();
  const button = await screen.findByRole("button", { name: t.YAML_EDIT });
  await waitFor(() => expect(button).toBeDisabled());
  expect(button).toHaveAttribute("title", t.CHANGE_DENIED("patch", "configmaps"));
});

test("a syntax error is shown inline and blocks the preview until it is fixed", async () => {
  m.get.mockResolvedValue(view(CONFIGMAPS, "app"));
  const onChange = setup(CONFIGMAPS, "app");
  await edit();
  typeYaml("apiVersion: v1\nkind: ConfigMap\nmetadata: {name: app\ndata: [1,\n");
  const alert = await screen.findByRole("alert", { name: t.YAML_PROBLEMS });
  expect(within(alert).getAllByRole("listitem").length).toBeGreaterThan(0);
  expect(alert.textContent).toMatch(/줄 \d+칸|\d+줄 \d+칸/);
  expect(screen.getByRole("button", { name: t.YAML_PREVIEW })).toBeDisabled();
  typeYaml(CONFIG_YAML.replace("info", "debug"));
  await waitFor(() => expect(screen.queryByRole("alert", { name: t.YAML_PROBLEMS })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: t.YAML_PREVIEW }));
  expect(onChange).toHaveBeenCalledWith({
    kind: CONFIGMAPS, namespace: "prod", name: "app", type: "apply", force: false,
    object: { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "app", namespace: "prod" }, data: { level: "debug" } },
  });
});

test("changing the kind, name or namespace is refused before any preview", async () => {
  m.get.mockResolvedValue(view(CONFIGMAPS, "app"));
  const onChange = setup(CONFIGMAPS, "app");
  await edit();
  typeYaml(CONFIG_YAML.replace("name: app", "name: other"));
  fireEvent.click(screen.getByRole("button", { name: t.YAML_PREVIEW }));
  expect(screen.getByText(t.YAML_IDENTITY_CHANGED)).toBeInTheDocument();
  typeYaml(`${CONFIG_YAML}---\nkind: ConfigMap\n`);
  fireEvent.click(screen.getByRole("button", { name: t.YAML_PREVIEW }));
  expect(screen.getByText(t.YAML_ONE_DOCUMENT)).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});

const SECRET_YAML = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: prod\ntype: Opaque\n";
const secretView = () => view(SECRETS, "db", {
  yaml: "data:\n  password: ••••\n  token: ••••\n", editYaml: SECRET_YAML, secretKeys: [{ key: "password", size: 7 }, { key: "token", size: 5 }],
});

test("secret editing starts masked, reveals one key on demand and sends untouched keys as masks", async () => {
  m.get.mockResolvedValue(secretView());
  m.secretValue.mockResolvedValue({ text: "hunter2", encoding: "utf8" });
  const onChange = setup(SECRETS, "db");
  await edit();
  expect(editorView().state.doc.toString()).toBe(SECRET_YAML);
  expect(screen.queryByDisplayValue("hunter2")).not.toBeInTheDocument();
  expect(screen.getByText(t.SECRET_EDIT_NOTE)).toBeInTheDocument();
  const [passwordReveal] = screen.getAllByRole("button", { name: t.SHOW_VALUE });
  fireEvent.click(passwordReveal);
  const field = await screen.findByLabelText(t.SECRET_VALUE_LABEL("password"));
  expect(field).toHaveValue("hunter2");
  expect(m.secretValue).toHaveBeenCalledTimes(1);
  expect(m.secretValue).toHaveBeenCalledWith(T, "prod", "db", "password", "p");
  fireEvent.change(field, { target: { value: "hunter3" } });
  fireEvent.click(screen.getByRole("button", { name: t.YAML_PREVIEW }));
  const change = onChange.mock.calls[0][0];
  expect(change.type).toBe("apply");
  expect(change.object.data).toEqual({ token: "••••" });
  expect(change.object.stringData).toEqual({ password: "hunter3" });
  expect(change.object.type).toBe("Opaque");
});

test("secret values can be replaced without reading them, keys added, and unchanged text is not an edit", async () => {
  m.get.mockResolvedValue(secretView());
  m.secretValue.mockResolvedValue({ text: "same", encoding: "utf8" });
  const onChange = setup(SECRETS, "db");
  await edit();
  fireEvent.click(screen.getAllByRole("button", { name: t.SECRET_NEW_VALUE })[1]);
  fireEvent.change(screen.getByLabelText(t.SECRET_VALUE_LABEL("token")), { target: { value: "fresh" } });
  expect(m.secretValue).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: t.SHOW_VALUE })[0]);
  const password = await screen.findByLabelText(t.SECRET_VALUE_LABEL("password"));
  fireEvent.change(password, { target: { value: "changed" } });
  fireEvent.change(password, { target: { value: "same" } });
  fireEvent.change(screen.getByLabelText(t.SECRET_NEW_KEY_NAME), { target: { value: "extra" } });
  fireEvent.change(screen.getByLabelText(t.SECRET_NEW_KEY_VALUE), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: t.SECRET_ADD }));
  fireEvent.click(screen.getByRole("button", { name: t.YAML_PREVIEW }));
  const { object } = onChange.mock.calls[0][0];
  expect(object.data).toEqual({ password: "••••" });
  expect(object.stringData).toEqual({ token: "fresh", extra: "x" });
});

test("binary secret values are shown read-only", async () => {
  m.get.mockResolvedValue(secretView());
  m.secretValue.mockResolvedValue({ text: "AAEC", encoding: "base64" });
  setup(SECRETS, "db");
  await edit();
  fireEvent.click(screen.getAllByRole("button", { name: t.SHOW_VALUE })[0]);
  expect(await screen.findByText(t.SECRET_BINARY_NOTE)).toBeInTheDocument();
  expect(screen.queryByLabelText(t.SECRET_VALUE_LABEL("password"))).not.toBeInTheDocument();
});
