import { fireEvent, render, screen, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../../test/utils";
import { DEPLOYMENTS, NODES } from "../kinds";
import { xrayApi } from "./api";
import { XrayView } from "./XrayView";
import type { K8sXray, XrayNode } from "./types";

vi.mock("./api", () => ({ xrayApi: { get: vi.fn() } }));
vi.mock("../../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const get = vi.mocked(xrayApi.get);
const T = { profile: "app", region: "r", cluster: "c" };

const node = (over: Partial<XrayNode>): XrayNode => ({
  group: "", version: "v1", kind: "Pod", namespace: "prod", name: "web-1", edge: "owner", roles: [], current: false, presence: "found", status: null, problems: [], children: [], ...over,
});
const tree = (over: Partial<K8sXray> = {}): K8sXray => ({ sections: [], gaps: [], truncated: false, partial: [], nodes: 0, ...over });

const deployment = node({ group: "apps", kind: "Deployment", name: "web", current: true, children: [
  node({ group: "apps", kind: "ReplicaSet", name: "web-5d", children: [node({ name: "web-5d-a", status: "CrashLoopBackOff", problems: ["crashLoopBackOff"] })] }),
] });
const world = tree({
  nodes: 7,
  sections: [
    { edge: "owner", nodes: [deployment] },
    { edge: "reference", nodes: [
      node({ kind: "ConfigMap", name: "web-config", edge: "reference", roles: ["volume", "env"] }),
      node({ kind: "Secret", name: "gone", edge: "reference", presence: "missing" }),
      node({ kind: "Node", name: "node-1", namespace: null, edge: "reference", status: "Ready" }),
    ] },
    { edge: "selector", nodes: [
      node({ kind: "Service", name: "web", edge: "selector", children: [node({ group: "networking.k8s.io", kind: "Ingress", name: "web", edge: "target" })] }),
    ] },
  ],
});

function setup(props: Partial<Parameters<typeof XrayView>[0]> = {}) {
  const onOpen = vi.fn();
  const view = (extra: Partial<Parameters<typeof XrayView>[0]> = {}) =>
    withClientAndSso(
      <XrayView target={T} context="ctx" ssoProfile="p" live objectRef={{ kind: DEPLOYMENTS, namespace: "prod", name: "web" }} resourceVersion="1" kinds={[]} onOpen={onOpen} toolbar={document.body} {...props} {...extra} />,
      qc,
      ssoLoginStub(),
    );
  const qc = newQueryClient();
  const result = render(view());
  return { onOpen, rerender: (extra: Partial<Parameters<typeof XrayView>[0]>) => result.rerender(view(extra)) };
}

beforeEach(() => vi.clearAllMocks());

test("groups the tree by edge type with badges, and opens a node in its own namespace", async () => {
  get.mockResolvedValue(world);
  const { onOpen } = setup();
  const owner = await screen.findByRole("region", { name: "소유" });
  expect(screen.getByRole("region", { name: "참조" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "선택" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "대상" })).not.toBeInTheDocument();
  // 지금 보는 객체는 누르지 못하고 표시만 한다
  expect(within(owner).queryByRole("button", { name: /Deployment web 열기/ })).not.toBeInTheDocument();
  expect(within(owner).getByText("지금 보는 객체")).toBeInTheDocument();
  // 아래 단계의 Pod에 이상 표시와 상태가 붙는다
  expect(within(owner).getByText("CrashLoopBackOff", { selector: ".xray-status" })).toBeInTheDocument();
  fireEvent.click(within(owner).getByRole("button", { name: "Pod web-5d-a 열기" }));
  expect(onOpen).toHaveBeenLastCalledWith({ kind: expect.objectContaining({ kind: "Pod", plural: "pods" }), namespace: "prod", name: "web-5d-a" });
  // 참조: 역할 배지, 없는 객체는 누르지 못하고 '없음'
  const refs = screen.getByRole("region", { name: "참조" });
  expect(within(refs).getByText("볼륨")).toBeInTheDocument();
  expect(within(refs).getByText("환경 변수")).toBeInTheDocument();
  expect(within(refs).queryByRole("button", { name: /Secret gone 열기/ })).not.toBeInTheDocument();
  expect(within(refs).getByText("없음")).toBeInTheDocument();
  // 클러스터 범위 객체는 네임스페이스 없이 연다
  fireEvent.click(within(refs).getByRole("button", { name: "Node node-1 열기" }));
  expect(onOpen).toHaveBeenLastCalledWith({ kind: expect.objectContaining(NODES), namespace: null, name: "node-1" });
  // 부모와 관계가 다른 자식(Service 아래 Ingress)만 자기 관계 배지를 단다
  const selecting = screen.getByRole("region", { name: "선택" });
  expect(within(selecting).getByText("대상")).toBeInTheDocument();
  expect(within(owner).queryByText("소유", { selector: ".xray-badge" })).not.toBeInTheDocument();
});

test("a node of a kind the cluster does not serve is shown but cannot be opened", async () => {
  get.mockResolvedValue(tree({ sections: [{ edge: "reference", nodes: [node({ group: "x.example.com", kind: "Gizmo", name: "g", edge: "reference" })] }] }));
  setup({ kinds: [] });
  expect(await screen.findByText("g")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Gizmo g 열기/ })).not.toBeInTheDocument();
});

test("unreadable kinds, partial reads and truncation are told, and an empty tree says so", async () => {
  get.mockResolvedValue(tree({
    sections: [], truncated: true, partial: ["Pod"],
    gaps: [{ kind: "Service", error: { kind: "accessDenied", action: "list services" } }],
  }));
  setup();
  expect(await screen.findByText(/Service을\(를\) 읽지 못했어요: 권한 없음 \(list services\)/)).toBeInTheDocument();
  expect(screen.getByText(/Pod 목록이 길어 앞부분만 읽었어요/)).toBeInTheDocument();
  expect(screen.getByText(/일부만 보여요/)).toBeInTheDocument();
  expect(screen.getByText("이 객체와 이어진 객체가 없어요")).toBeInTheDocument();
});

test("reads again when the object's resourceVersion changes, and on demand", async () => {
  get.mockResolvedValue(world);
  const { rerender } = setup({ resourceVersion: "1" });
  await screen.findByRole("region", { name: "소유" });
  expect(get).toHaveBeenCalledTimes(1);
  rerender({ resourceVersion: "2" });
  await screen.findByRole("region", { name: "소유" });
  expect(get).toHaveBeenCalledTimes(2);
  fireEvent.click(await screen.findByRole("button", { name: "다시 읽기" }));
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
});

test("does not read while the connection is not live", () => {
  setup({ live: false });
  expect(get).not.toHaveBeenCalled();
});

test("shows the failure with a retry when the object cannot be read", async () => {
  get.mockRejectedValueOnce({ kind: "other", message: "연결이 끊겼어요" }).mockResolvedValueOnce(world);
  setup();
  expect(await screen.findByText(/연결이 끊겼어요/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByRole("region", { name: "소유" })).toBeInTheDocument();
});
