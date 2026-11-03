import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "../api/invoke";
import { newQueryClient, withClientAndSso, ssoLoginStub } from "../test/utils";
import { UsageGraphs } from "./UsageGraphs";
import { PROM_EMPTY, PROM_MANUAL, PROM_NAME, PROM_NAMESPACE, PROM_NONE, PROM_PORT, PROM_SELECT, PROM_SERVER } from "./text";
import type { K8sObjectView, ObjectRef } from "./types";

const update = vi.hoisted(() => vi.fn());
vi.mock("../api/invoke", () => ({ invoke: vi.fn(), onSsoExpired: vi.fn(() => () => {}) }));
vi.mock("../api/queries", () => ({ useSettings: () => ({ settings: {}, update }) }));
const target = { profile: "p", region: "r", cluster: "c" };
const objectRef: ObjectRef = { kind: { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true }, namespace: "app", name: "web" };
const view = { containers: [{ name: "web", init: false, state: "running", cpuRequest: 500, memoryLimit: 1073741824 }] } as K8sObjectView;

beforeEach(() => vi.clearAllMocks());
function setup(ref = objectRef, objectView = view) {
  render(withClientAndSso(
    <UsageGraphs target={target} context="ctx" objectRef={ref} view={objectView} live ssoProfile="p" />,
    newQueryClient(),
    ssoLoginStub(),
  ));
}

test("explains no candidate and permits a manual service", async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  setup();
  expect(await screen.findByText(PROM_NONE)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: PROM_MANUAL }));
  fireEvent.change(screen.getByLabelText(PROM_NAMESPACE), { target: { value: "monitoring" } });
  fireEvent.change(screen.getByLabelText(PROM_NAME), { target: { value: "metrics" } });
  fireEvent.change(screen.getByLabelText(PROM_PORT), { target: { value: "9090" } });
  expect(screen.getByRole("button", { name: PROM_SELECT })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: PROM_SELECT }));
  expect(update).toHaveBeenCalledWith({ k8sPrometheus: { [JSON.stringify(["p", "r", "c"])]: { namespace: "monitoring", name: "metrics", port: 9090 } } });
});

test("one candidate loads graphs and shows empty data", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => command === "k8s_prometheus_candidates" ? [{ namespace: "monitoring", name: "prometheus", port: 9090 }] : { cpu: [], memory: [] });
  setup();
  await waitFor(() => expect(screen.getAllByText(PROM_EMPTY)).toHaveLength(2));
  expect(invoke).toHaveBeenCalledWith("k8s_prometheus_graphs", expect.objectContaining({ namespace: "app", name: "web", hours: 1 }));
});

test("several candidates require a selection", async () => {
  vi.mocked(invoke).mockResolvedValue([{ namespace: "monitoring", name: "prometheus", port: 9090 }, { namespace: "other", name: "prometheus", port: 9090 }]);
  setup();
  const selector = await screen.findByLabelText(PROM_SERVER);
  expect(invoke).not.toHaveBeenCalledWith("k8s_prometheus_graphs", expect.anything());
  fireEvent.change(selector, { target: { value: "other/prometheus:9090" } });
  expect(update).toHaveBeenCalledWith({ k8sPrometheus: { [JSON.stringify(["p", "r", "c"])]: { namespace: "other", name: "prometheus", port: 9090 } } });
});

test("shows formatted axes and references from container resources", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => command === "k8s_prometheus_candidates"
    ? [{ namespace: "monitoring", name: "prometheus", port: 9090 }]
    : { cpu: [{ name: "web", values: [[3600, 0.25], [7200, 0.4]] }], memory: [{ name: "web", values: [[7200, 536870912]] }] });
  setup();
  expect(await screen.findAllByText("web 요청: 500m")).toHaveLength(2);
  expect(screen.getAllByText("web 제한: 1 GiB")).toHaveLength(2);
  expect(screen.getByText("250m")).toBeInTheDocument();
  expect(screen.getByText("0.5 GiB")).toBeInTheDocument();
});

test("workload reference lines sum only complete template resource values", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => command === "k8s_prometheus_candidates"
    ? [{ namespace: "monitoring", name: "prometheus", port: 9090 }]
    : { cpu: [{ name: "web-1", values: [[7200, 0.4]] }], memory: [{ name: "web-1", values: [[7200, 100]] }] });
  const workload = { ...objectRef, kind: { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true } };
  const template = { containers: [
    { name: "one", state: "template", init: false, cpuRequest: 250, memoryLimit: 512 },
    { name: "two", state: "template", init: false, cpuRequest: 500, memoryLimit: null },
  ] } as K8sObjectView;
  setup(workload, template);
  expect(await screen.findAllByText("Pod 요청: 750m")).toHaveLength(2);
  expect(screen.queryByText(/Pod 제한/)).not.toBeInTheDocument();
});
