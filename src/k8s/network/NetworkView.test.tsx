import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../../test/utils";
import { LB_ARN, network, policy, row } from "./fixtures";
import { networkApi } from "./api";
import { NetworkView } from "./NetworkView";
import { OPEN_VPC_UNKNOWN } from "./text";
import type { Network } from "./types";

vi.mock("./api", () => ({ networkApi: { network: vi.fn() } }));
vi.mock("../../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(networkApi);
const T = { profile: "app", region: "ap-northeast-2", cluster: "prod" };
const lanes = { width: () => undefined, resize: vi.fn(), commit: vi.fn() };

function setup(data: Network, namespace: string | null = null) {
  m.network.mockResolvedValue(data);
  const onOpenObject = vi.fn();
  const onOpenVpc = vi.fn();
  render(
    withClientAndSso(
      <NetworkView target={T} context="ctx" ssoProfile="exec" live namespace={namespace} onOpenObject={onOpenObject} onOpenVpc={onOpenVpc} lanes={lanes} />,
      newQueryClient(),
      ssoLoginStub(),
    ),
  );
  return { onOpenObject, onOpenVpc };
}

const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const detail = () => screen.getByRole("complementary", { name: "네트워크 상세" });

beforeEach(() => vi.clearAllMocks());

test("lists Services and Ingresses with their load balancer, listeners and target health, and says why a row has no match", async () => {
  setup(network());
  const table = await screen.findByRole("table", { name: "로드 밸런서 목록" });
  const web = within(table).getByText("shop/web").closest("tr")!;
  expect(within(web).getByText("ALB")).toBeInTheDocument();
  expect(within(web).getByText("HTTPS:443, HTTP:80")).toBeInTheDocument();
  // 정상 하나, 비정상 하나: 문제가 있으니 요약에 비정상이 보인다
  expect(within(web).getByText("정상 1 · 비정상 1")).toBeInTheDocument();
  expect(within(web).getByText("주소(호스트명)로 찾음")).toBeInTheDocument();
  // 짝 없음은 이유로 구분한다
  expect(within(within(table).getByText("shop/site").closest("tr")!).getByText("찾지 못함")).toHaveAttribute("title", expect.stringContaining("클래식"));
  expect(within(within(table).getByText("shop/pending").closest("tr")!).getByText("주소 없음")).toBeInTheDocument();
  // 짝 없는 로드 밸런서는 따로
  expect(screen.getByRole("region", { name: "이 클러스터 태그가 붙었지만 짝이 없는 로드 밸런서" })).toHaveTextContent("gone/svc");
});

test("clicking a row opens the detail with listeners, rules, target groups and the unhealthy reason; clicking it again closes it", async () => {
  const { onOpenObject } = setup(network());
  fireEvent.click((await screen.findByText("shop/web")).closest("tr")!);
  const d = detail();
  expect(d).toHaveStyle({ width: "70%" });
  expect(within(d).getByText("HTTPS:443")).toBeInTheDocument();
  expect(within(d).getByText("ELBSecurityPolicy-2016-08")).toBeInTheDocument();
  expect(within(d).getByText("forward: web-tg")).toBeInTheDocument();
  expect(within(d).getByText("host-header: shop.example.com")).toBeInTheDocument();
  expect(within(d).getByText(/web-tg · HTTP:8080 · ip/)).toBeInTheDocument();
  expect(within(d).getByText("Target.FailedHealthChecks")).toBeInTheDocument();
  expect(within(d).getByText("Health checks failed")).toBeInTheDocument();
  // 대상에서 Pod로 이동
  fireEvent.click(within(d).getByRole("button", { name: "Pod web-2을 워크로드에서 열기" }));
  expect(onOpenObject).toHaveBeenCalledWith(expect.objectContaining({ namespace: "shop", name: "web-2", kind: expect.objectContaining({ kind: "Pod" }) }));
  // Service 자체도 워크로드에서 연다
  fireEvent.click(within(d).getByRole("button", { name: "워크로드에서 열기" }));
  expect(onOpenObject).toHaveBeenLastCalledWith(expect.objectContaining({ namespace: "shop", name: "web", kind: expect.objectContaining({ kind: "Service" }) }));
  // 고른 행을 다시 누르면 닫힌다
  fireEvent.click(screen.getAllByText("shop/web")[0].closest("tr")!);
  return waitFor(() => expect(screen.queryByRole("complementary", { name: "네트워크 상세" })).toBeNull());
});

test("an Ingress row opens the Ingress in the workloads view", async () => {
  const { onOpenObject } = setup(network());
  fireEvent.click((await screen.findByText("shop/site")).closest("tr")!);
  fireEvent.click(within(detail()).getByRole("button", { name: "워크로드에서 열기" }));
  expect(onOpenObject).toHaveBeenCalledWith(expect.objectContaining({ name: "site", kind: expect.objectContaining({ kind: "Ingress" }) }));
  // 짝 없는 행은 이유가 요약에 있고 VPC에서 볼 로드 밸런서가 없다
  expect(within(detail()).getByText(/클래식 로드 밸런서일 수 있어요/)).toBeInTheDocument();
  expect(within(detail()).getByRole("button", { name: "VPC 다이어그램에서 보기" })).toBeDisabled();
});

test("the selected namespace narrows the rows", async () => {
  setup(network({ loadBalancers: [row(), row({ namespace: "blog", name: "posts" })] }), "blog");
  expect(await screen.findByText("blog/posts")).toBeInTheDocument();
  expect(screen.queryByText("shop/web")).toBeNull();
});

test("opens the VPC diagram with the cluster's nodes and load balancers highlighted", async () => {
  const { onOpenVpc } = setup(network());
  fireEvent.click(await screen.findByRole("button", { name: "VPC 다이어그램 열기" }));
  expect(onOpenVpc).toHaveBeenCalledWith({ vpcId: "vpc-1", name: "prod VPC", region: "ap-northeast-2", highlight: { ids: ["i-0aaa", LB_ARN], label: "prod" } });
  // 한 로드 밸런서만 강조해서 열 수도 있다
  fireEvent.click((await screen.findByText("shop/web")).closest("tr")!);
  fireEvent.click(within(detail()).getByRole("button", { name: "VPC 다이어그램에서 보기" }));
  expect(onOpenVpc).toHaveBeenLastCalledWith(expect.objectContaining({ highlight: { ids: [LB_ARN], label: "prod" } }));
});

test("without a known VPC the diagram button stays visible but disabled with the reason", async () => {
  const { onOpenVpc } = setup(network({ vpcId: null }));
  const button = await screen.findByRole("button", { name: "VPC 다이어그램 열기" });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", OPEN_VPC_UNKNOWN);
  expect(button).toHaveAttribute("aria-description", OPEN_VPC_UNKNOWN);
  fireEvent.click(button);
  expect(onOpenVpc).not.toHaveBeenCalled();
});

test("AWS read failures are gaps with the reason, grouped, and the Kubernetes side still shows", async () => {
  const same = { kind: "other", message: "자격 증명을 읽지 못했어요" } as const;
  setup(
    network({
      vpcId: null,
      subnets: null,
      gaps: [
        { section: "cluster", subject: null, error: same },
        { section: "subnets", subject: null, error: same },
        { section: "loadBalancers", subject: null, error: same },
      ],
      loadBalancers: [row({ loadBalancer: null, matchedBy: null, unmatched: "awsUnavailable" })],
    }),
  );
  const gaps = await screen.findByRole("group", { name: "읽지 못한 부분" });
  expect(gaps).toHaveTextContent("이 부분을 읽지 못했어요: 클러스터 VPC, 서브넷, 로드 밸런서");
  expect(within(gaps).getAllByText("자격 증명을 읽지 못했어요")).toHaveLength(1);
  expect(screen.getByText("AWS 읽기 실패")).toBeInTheDocument();
  // 노드 탭은 쿠버네티스 쪽 값으로 그대로 보이고, 서브넷 표는 없다
  tab("노드·서브넷");
  expect(await screen.findByRole("table", { name: "노드 목록" })).toBeInTheDocument();
  expect(screen.queryByRole("table", { name: "서브넷 목록" })).toBeNull();
});

test("a load balancer's own gaps appear in its detail with the reason", async () => {
  const lb = row().loadBalancer!;
  setup(network({ loadBalancers: [row({ loadBalancer: { ...lb, gaps: [{ section: "targetHealth", subject: "web / web-tg", error: { kind: "accessDenied", action: "elasticloadbalancing:DescribeTargetHealth" } }] } })] }));
  fireEvent.click((await screen.findByText("shop/web")).closest("tr")!);
  expect(within(detail()).getByText("이 부분을 읽지 못했어요: 대상 상태 (web / web-tg)")).toBeInTheDocument();
  expect(within(detail()).getByText(/elasticloadbalancing:DescribeTargetHealth/)).toBeInTheDocument();
});

test("nodes show instance, zone and subnet and link to the Node; Fargate nodes have no instance; subnets show free IPs and unused ones are dimmed", async () => {
  const { onOpenObject } = setup(network());
  await screen.findByRole("table", { name: "로드 밸런서 목록" });
  tab("노드·서브넷");
  const nodes = await screen.findByRole("table", { name: "노드 목록" });
  const a = within(nodes).getByText("ip-10-0-0-10").closest("tr")!;
  expect(within(a).getByText("i-0aaa")).toBeInTheDocument();
  expect(within(a).getByText("private-a (subnet-a)")).toBeInTheDocument();
  expect(within(within(nodes).getByText("fargate-x").closest("tr")!).getByText("Fargate")).toBeInTheDocument();
  fireEvent.click(within(a).getByRole("button", { name: "Node ip-10-0-0-10을 워크로드에서 열기" }));
  expect(onOpenObject).toHaveBeenCalledWith(expect.objectContaining({ namespace: null, name: "ip-10-0-0-10", kind: expect.objectContaining({ kind: "Node" }) }));
  const subnets = screen.getByRole("table", { name: "서브넷 목록" });
  expect(within(within(subnets).getByText("private-a (subnet-a)").closest("tr")!).getByText("100 / 251 (40%)")).toBeInTheDocument();
  expect(within(subnets).getByText("subnet-unused").closest("tr")).toHaveClass("net-unused");
});

test("Pod IPs: per-subnet counts with the VPC CNI, a host network pod marked, and a narrowing search", async () => {
  setup(network());
  await screen.findByRole("table", { name: "로드 밸런서 목록" });
  tab("Pod IP");
  expect(await screen.findByText(/VPC CNI라서 Pod IP를 서브넷에 이었어요/)).toBeInTheDocument();
  const perSubnet = screen.getByRole("table", { name: "서브넷별 Pod" });
  expect(within(perSubnet).getByText("3")).toBeInTheDocument();
  const pods = screen.getByRole("table", { name: "Pod IP 목록" });
  expect(within(within(pods).getByText("agent").closest("tr")!).getByText("노드 IP")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Pod 찾기"), { target: { value: "10.0.0.77" } });
  expect(within(screen.getByRole("table", { name: "Pod IP 목록" })).queryByText("agent")).toBeNull();
  expect(screen.getByText("web-1")).toBeInTheDocument();
});

test("without the VPC CNI the pod list has no subnet table and says so", async () => {
  setup(network({ pods: { vpcCni: false, items: [], outside: 0, partial: false } }));
  await screen.findByRole("table", { name: "로드 밸런서 목록" });
  tab("Pod IP");
  expect(await screen.findByText(/VPC CNI\(aws-node\)가 없어서/)).toBeInTheDocument();
  expect(screen.queryByRole("table", { name: "서브넷별 Pod" })).toBeNull();
  expect(screen.getByText("IP가 있는 Pod가 없어요")).toBeInTheDocument();
});

test("NetworkPolicy: namespaces without a policy are marked (system ones dimmed) and a detail summarizes the rules", async () => {
  const { onOpenObject } = setup(
    network({
      policies: [
        policy(),
        policy({ name: "deny-egress", types: ["Egress"], ingress: [], egress: [] }),
        policy({ name: "open", types: ["Ingress"], ingress: [{ peers: [], ports: [] }] }),
      ],
    }),
  );
  await screen.findByRole("table", { name: "로드 밸런서 목록" });
  tab("NetworkPolicy");
  const without = await screen.findByRole("region", { name: "NetworkPolicy가 없는 네임스페이스" });
  expect(within(without).getByText("1개 (시스템 네임스페이스 제외)")).toBeInTheDocument();
  expect(within(without).getByText("blog")).not.toHaveClass("net-unused");
  expect(within(without).getByText("kube-system")).toHaveClass("net-unused");
  expect(within(without).queryByText("shop")).toBeNull();

  fireEvent.click(screen.getByText("allow-web").closest("tr")!);
  let d = detail();
  expect(within(d).getByText("app=api")).toBeInTheDocument();
  expect(within(d).getByText("출발: Pod app=web")).toBeInTheDocument();
  expect(within(d).getByText("포트: TCP/8080")).toBeInTheDocument();
  // 정책이 다루지 않는 방향은 제한 없음
  expect(within(d).getByText("이 방향은 정책이 다루지 않아요(제한 없음)")).toBeInTheDocument();
  fireEvent.click(within(d).getByRole("button", { name: "워크로드에서 열기(YAML)" }));
  expect(onOpenObject).toHaveBeenCalledWith(expect.objectContaining({ namespace: "shop", name: "allow-web", kind: expect.objectContaining({ kind: "NetworkPolicy" }) }));

  fireEvent.click(screen.getByText("deny-egress").closest("tr")!);
  d = detail();
  expect(within(d).getByText("모두 차단 — 허용하는 규칙이 없어요")).toBeInTheDocument();
  fireEvent.click(screen.getByText("open").closest("tr")!);
  expect(within(detail()).getByText(/모두 허용/)).toBeInTheDocument();
});

test("every namespace having a policy says so", async () => {
  setup(network({ namespaces: [{ name: "shop", policies: 1, system: false }] }));
  await screen.findByRole("table", { name: "로드 밸런서 목록" });
  tab("NetworkPolicy");
  expect(await screen.findByText("모든 네임스페이스에 NetworkPolicy가 있어요")).toBeInTheDocument();
});

test("a failing command (no connection) shows the error instead of the view", async () => {
  m.network.mockRejectedValue({ kind: "other", message: "먼저 연결해 주세요" });
  render(
    withClientAndSso(
      <NetworkView target={T} context="ctx" ssoProfile="exec" live namespace={null} onOpenObject={vi.fn()} lanes={lanes} />,
      newQueryClient(),
      ssoLoginStub(),
    ),
  );
  expect(await screen.findByText("먼저 연결해 주세요")).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "로드밸런서" })).toBeNull();
});
