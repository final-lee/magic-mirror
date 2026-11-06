import { fireEvent, screen, waitFor } from "@testing-library/react";
import { typeYaml } from "../../test/codemirror";
import { renderWithClient } from "../../test/utils";
import { manageApi } from "./api";
import { AppSetPreview } from "./AppSetPreview";
import { APPSET_EDIT_LABEL, APPSET_GENERATE, APPSET_SAVE, MANAGE_NAME_LOCKED, appSetCounts } from "./text";
import type { AppSetDetail } from "./types";

vi.mock("./api", () => ({ manageApi: { generate: vi.fn(), appSetApps: vi.fn(), yamlDiff: vi.fn() } }));
const api = vi.mocked(manageApi);

const YAML = "apiVersion: argoproj.io/v1alpha1\nkind: ApplicationSet\nmetadata:\n  name: fleet\n  namespace: argocd\nspec:\n  generators: []\n";
const set: AppSetDetail = {
  name: "fleet", namespace: "argocd", resourceVersion: "1", yaml: YAML, generators: [], template: { name: null, project: null, sources: [], destination: null },
  strategy: null, preserveResourcesOnDeletion: false, goTemplate: false, conditions: [], applicationStatus: [],
};
const app = (name: string, yaml: string) => ({ name, namespace: "argocd", yaml });

beforeEach(() => {
  vi.resetAllMocks();
  api.appSetApps.mockResolvedValue([app("keep", "a: 1\n"), app("gone", "a: 1\n"), app("edit", "a: 1\n")]);
  api.generate.mockResolvedValue([{ ...app("keep", "a: 1\n"), project: null, destination: null, sources: [] }, { ...app("edit", "a: 2\n"), project: null, destination: null, sources: [] }, { ...app("fresh", "a: 1\n"), project: null, destination: null, sources: [] }]);
});

test("calculating a preview sends the edited YAML, saves nothing and lists added, removed and changed apps", async () => {
  const onChange = vi.fn();
  renderWithClient(<AppSetPreview url="https://argo.test" set={set} onChange={onChange} />);
  const edited = YAML.replace("generators: []", "generators:\n    - list: {}");
  typeYaml(edited, APPSET_EDIT_LABEL);
  fireEvent.click(screen.getByRole("button", { name: APPSET_GENERATE }));
  expect(await screen.findByText(appSetCounts(1, 1, 1, 1))).toBeInTheDocument();
  expect(api.generate).toHaveBeenCalledWith("https://argo.test", edited);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByText("fresh")).toBeInTheDocument();
  expect(screen.getByText("gone")).toBeInTheDocument();
  expect(screen.getByText("edit")).toBeInTheDocument();
  expect(screen.queryByText("keep")).not.toBeInTheDocument();
});

test("save opens the upsert preview only for a changed YAML with the same name", async () => {
  const onChange = vi.fn();
  renderWithClient(<AppSetPreview url="https://argo.test" set={set} onChange={onChange} />);
  const save = screen.getByRole("button", { name: APPSET_SAVE });
  expect(save).toBeDisabled();

  typeYaml(YAML.replace("name: fleet", "name: other"), APPSET_EDIT_LABEL);
  expect(await screen.findByText(MANAGE_NAME_LOCKED)).toBeInTheDocument();
  expect(save).toBeDisabled();

  const edited = YAML.replace("generators: []", "generators:\n    - list: {}");
  typeYaml(edited, APPSET_EDIT_LABEL);
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  expect(onChange).toHaveBeenCalledWith({ kind: "appSetUpsert", yaml: edited });
});
