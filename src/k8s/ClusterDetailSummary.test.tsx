import { render, screen, within } from "@testing-library/react";
import { api } from "../api/client";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { ClusterDetailSummary } from "./ClusterDetailSummary";
import { CLUSTER_DETAIL_NO_CONTEXT, SEC_WARNINGS } from "./text";
import type { K8sContextCandidate, K8sContextInfo, K8sNodeView } from "./types";

vi.mock("./api", () => ({
  k8sApi: { context: vi.fn(), open: vi.fn(), close: vi.fn(), overview: vi.fn(), metrics: vi.fn(), watch: vi.fn(), unwatch: vi.fn() },
}));
vi.mock("../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn(), ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
let n = 0;

const cand = (name: string): K8sContextCandidate => ({ name, cluster: name, user: `${name}-user`, namespace: null, execProfile: null });
const info = (candidates: K8sContextCandidate[]): K8sContextInfo => ({
  arn: "arn:aws:eks:ap-northeast-2:1:cluster/prod", endpoint: "https://x", version: "1.33", endpointPublic: true, endpointPrivate: false, publicCidrs: [],
  kubeconfigMissing: false, kubeconfigPaths: [], candidates, chosen: null, savedMissing: null, updateCommand: "aws eks update-kubeconfig --name prod",
});
const node: K8sNodeView = {
  name: "ip-1", ready: true, unschedulable: false, pressures: [], instanceType: null, zone: null, groupKind: "managed", group: "ng", kubeletVersion: "v1.33.0",
  capacity: { cpuMilli: 2000, memoryBytes: 8, pods: 29 }, allocatable: { cpuMilli: 2000, memoryBytes: 8, pods: 29 },
  requested: { cpuMilli: 500, memoryBytes: 2, pods: 3 }, limits: { cpuMilli: 1000, memoryBytes: 4, pods: 3 }, usage: null,
};

function setup() {
  vi.mocked(api.getSettings).mockResolvedValue({ enabledServices: [], favorites: [], lastProfile: "app", lastRegion: null });
  const target = { profile: "app", region: "ap-northeast-2", cluster: `prod${n++}` };
  render(withClientAndSso(<ClusterDetailSummary target={target} />, newQueryClient(), ssoLoginStub()));
  return { target };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.open.mockResolvedValue({ context: "ctx", execProfile: null, serverVersion: "1.33", identity: { username: "a", groups: [], arn: null, source: "selfSubjectReview" } });
  m.metrics.mockResolvedValue({ podsUnavailable: null, nodesUnavailable: null, pods: [], nodes: [{ name: "ip-1", cpuMilli: 1000, memoryBytes: 4 }] });
  m.unwatch.mockResolvedValue(null);
  m.watch.mockResolvedValue(1);
  m.overview.mockResolvedValue({
    cluster: null, nodes: [node], requestsPartial: false, metrics: true, nodegroups: [], fargateProfiles: [], nodePools: null,
    addons: [], insights: [], removedApis: null, nextVersion: null, skew: [], gaps: [],
  });
});

test("a selected cluster shows the overview's usage rings and warnings, with no buttons in the body", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  const { target } = setup();
  const cpu = await screen.findByRole("region", { name: "CPU" });
  expect(await within(cpu).findByRole("img", { name: "CPU 사용량 50%" })).toBeInTheDocument();
  expect(m.overview).toHaveBeenCalledWith(target);
  expect(screen.getByText(SEC_WARNINGS)).toBeInTheDocument();
  // 단추는 상세의 오른쪽 위 도구 모음이 갖는다
  expect(screen.queryByRole("button")).toBeNull();
});

test("without a chosen context it points to the EKS tab and does not connect", async () => {
  m.context.mockResolvedValue(info([cand("a"), cand("b")]));
  setup();
  expect(await screen.findByText(CLUSTER_DETAIL_NO_CONTEXT)).toBeInTheDocument();
  expect(m.open).not.toHaveBeenCalled();
});
