import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { typeYaml } from "../../test/codemirror";
import { helmApi } from "./api";
import { HelmInstallDialog } from "./HelmInstallDialog";
import { EMPTY_SOURCE, toSource } from "./ChartSourceFields";
import * as t from "./text";

vi.mock("./api", () => ({ helmApi: { showValues: vi.fn() } }));
const m = vi.mocked(helmApi);

function setup() {
  const onPreview = vi.fn();
  const onClose = vi.fn();
  render(<HelmInstallDialog namespace="apps" onPreview={onPreview} onClose={onClose} />);
  return { onPreview, onClose };
}
const preview = () => screen.getByRole("button", { name: t.ACT_PREVIEW });
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => vi.resetAllMocks());

test("the preview stays off until the release name, namespace and chart are valid", () => {
  setup();
  expect(preview()).toBeDisabled();
  fill(t.INSTALL_NAME, "Bad_Name");
  expect(screen.getByText(t.INSTALL_NAME_INVALID)).toBeInTheDocument();
  fill(t.SRC_PATH_LABEL, "/charts/web");
  expect(preview()).toBeDisabled();
  fill(t.INSTALL_NAME, "web-1");
  expect(preview()).toBeEnabled();
  fill(t.INSTALL_NAMESPACE, "Not Valid");
  expect(screen.getByText(t.INSTALL_NAMESPACE_INVALID)).toBeInTheDocument();
  expect(preview()).toBeDisabled();
  fill(t.INSTALL_NAMESPACE, "");
  expect(preview()).toBeDisabled();
});

test("a yaml syntax error in the values blocks the preview", async () => {
  setup();
  fill(t.INSTALL_NAME, "web");
  fill(t.SRC_PATH_LABEL, "/charts/web");
  typeYaml("a: [broken\n");
  await waitFor(() => expect(preview()).toBeDisabled());
  expect(screen.getByRole("alert", { name: t.VALUES_INVALID })).toBeInTheDocument();
});

test("a repository chart sends the repository, chart name and version and can create the namespace", () => {
  const { onPreview } = setup();
  fill(t.INSTALL_NAME, "web");
  fireEvent.click(screen.getByLabelText(t.SRC_REPO));
  fill(t.SRC_REPO_URL, "https://charts.example.com");
  expect(preview()).toBeDisabled();
  fill(t.SRC_CHART_NAME, "nginx");
  fill(t.SRC_VERSION, "1.2.3");
  fireEvent.click(screen.getByLabelText(t.INSTALL_CREATE_NAMESPACE));
  fireEvent.click(preview());
  expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({
    type: "helmInstall", name: "web", namespace: "apps", createNamespace: true, chart: { reference: "nginx", repo: "https://charts.example.com", version: "1.2.3" },
  }));
});

test("an OCI chart needs only its address and sends the version", () => {
  const { onPreview } = setup();
  fill(t.INSTALL_NAME, "web");
  fireEvent.click(screen.getByLabelText(t.SRC_OCI));
  expect(preview()).toBeDisabled();
  fill(t.SRC_OCI_REF, "oci://registry.example.com/charts/web");
  fireEvent.click(preview());
  expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ chart: { reference: "oci://registry.example.com/charts/web", repo: null, version: null } }));
});

test("loading the chart defaults fills the editor, and the filled text is what gets sent", async () => {
  m.showValues.mockResolvedValue("replicaCount: 1\nmessage: hello\n");
  const { onPreview } = setup();
  fill(t.INSTALL_NAME, "web");
  expect(screen.getByRole("button", { name: t.INSTALL_LOAD_DEFAULTS })).toBeDisabled();
  fill(t.SRC_PATH_LABEL, "/charts/web");
  fireEvent.click(screen.getByRole("button", { name: t.INSTALL_LOAD_DEFAULTS }));
  await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("replicaCount: 1"));
  expect(m.showValues).toHaveBeenCalledWith({ reference: "/charts/web", repo: null, version: null });
  fireEvent.click(preview());
  expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ values: "replicaCount: 1\nmessage: hello\n" }));
});

test("a failure loading the defaults is shown and leaves the editor usable", async () => {
  m.showValues.mockRejectedValue({ kind: "other", message: "차트 경로를 찾지 못했어요" });
  setup();
  fill(t.SRC_PATH_LABEL, "/nope");
  fireEvent.click(screen.getByRole("button", { name: t.INSTALL_LOAD_DEFAULTS }));
  expect(await screen.findByRole("alert")).toHaveTextContent("차트 경로를 찾지 못했어요");
  typeYaml("a: 1\n");
  expect(screen.getByRole("button", { name: t.INSTALL_LOAD_DEFAULTS })).toBeEnabled();
});

test("cancel closes without previewing", () => {
  const { onPreview, onClose } = setup();
  fireEvent.click(screen.getByRole("button", { name: t.ACT_CANCEL }));
  expect(onClose).toHaveBeenCalled();
  expect(onPreview).not.toHaveBeenCalled();
});

test("chart location input maps each kind to the fields it needs and trims blanks", () => {
  expect(toSource(EMPTY_SOURCE)).toBeNull();
  expect(toSource({ ...EMPTY_SOURCE, path: "  /c  " })).toEqual({ reference: "/c", repo: null, version: null });
  expect(toSource({ ...EMPTY_SOURCE, kind: "repo", repoUrl: "https://r", chartName: "" })).toBeNull();
  expect(toSource({ ...EMPTY_SOURCE, kind: "repo", repoUrl: " https://r ", chartName: " n ", version: "  " })).toEqual({ reference: "n", repo: "https://r", version: null });
  // 다른 종류의 칸에 남은 글은 쓰지 않는다
  expect(toSource({ ...EMPTY_SOURCE, kind: "oci", oci: "oci://x", path: "/ignored", version: "1.0.0" })).toEqual({ reference: "oci://x", repo: null, version: "1.0.0" });
});
