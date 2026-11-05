import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { ARGOCD_TITLE } from "../argocd/text";
import { ARGOWF_TITLE } from "../argowf/text";
import { eksService, makeResource, renderWithClient, sampleServices } from "../test/utils";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: { listResources: vi.fn() },
}));

const listResources = vi.mocked(api.listResources);

beforeEach(() => {
  listResources.mockReset();
  listResources.mockResolvedValue({ items: [makeResource("a", {}), makeResource("b", {})], truncated: false });
});

const base = {
  services: sampleServices,
  profile: "prod",
  region: "ap-northeast-2",
  selection: null,
  favorites: [],
  onSelect: () => {},
  onToggleFavorite: () => {},
  onServiceOrderChange: () => {},
  onTypeOrderChange: () => {},
  onFavoritesChange: () => {},
};

test("shows services collapsed and fetches counts only when expanded", async () => {
  renderWithClient(<Sidebar {...base} />);
  expect(screen.getByText("EC2")).toBeInTheDocument();
  expect(screen.queryByText("Instances")).not.toBeInTheDocument();
  expect(listResources).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("EC2"));
  expect(screen.getByText("Instances")).toBeInTheDocument();
  await waitFor(() => expect(listResources).toHaveBeenCalledWith("prod", "ap-northeast-2", "ec2", "instances"));
  expect(listResources).toHaveBeenCalledWith("prod", "ap-northeast-2", "ec2", "volumes");
  await waitFor(() => expect(screen.getAllByText("2")).toHaveLength(2));
});

test("shows dash when count fetch fails", async () => {
  listResources.mockRejectedValue({ kind: "accessDenied", action: "iam:ListUsers" });
  renderWithClient(<Sidebar {...base} />);
  fireEvent.click(screen.getByText("IAM"));
  await waitFor(() => expect(screen.getByText("—")).toBeInTheDocument());
});

test("selected service starts expanded and clicking type selects", () => {
  const onSelect = vi.fn();
  renderWithClient(<Sidebar {...base} selection={{ service: "ec2", type: "volumes" }} onSelect={onSelect} />);
  expect(screen.getByText("Volumes").closest("[role=button]")).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByText("Instances"));
  expect(onSelect).toHaveBeenCalledWith({ service: "ec2", type: "instances" });
});

test("right click toggles favorite and favorites section lists entries", () => {
  const onToggleFavorite = vi.fn();
  renderWithClient(
    <Sidebar {...base} favorites={[{ service: "s3", type: "buckets" }]} onToggleFavorite={onToggleFavorite} />,
  );
  expect(screen.getByText("즐겨찾기")).toBeInTheDocument();
  expect(screen.getByText("S3 › Buckets")).toBeInTheDocument();
  fireEvent.contextMenu(screen.getByText("S3 › Buckets"));
  expect(onToggleFavorite).toHaveBeenCalledWith({ service: "s3", type: "buckets" });
  // 즐겨찾기 행은 조회를 일으키지 않는다
  expect(listResources).not.toHaveBeenCalled();
});

test("favorite of a disabled service is hidden", () => {
  renderWithClient(<Sidebar {...base} favorites={[{ service: "lambda", type: "functions" }]} />);
  expect(screen.queryByText("즐겨찾기")).not.toBeInTheDocument();
});

describe("IAM 관리 entry", () => {
  test("is the first row under an expanded IAM group and opens the IAM tab", () => {
    const onOpenIam = vi.fn();
    renderWithClient(<Sidebar {...base} onOpenIam={onOpenIam} />);
    expect(screen.queryByText("🔐 IAM 관리")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("IAM"));
    const entry = screen.getByText("🔐 IAM 관리");
    // 다른 타입 행(Users)보다 앞에 놓인다
    expect(entry.compareDocumentPosition(screen.getByText("Users")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(entry);
    expect(onOpenIam).toHaveBeenCalledTimes(1);
  });

  test("collapsing the IAM group hides it again", () => {
    renderWithClient(<Sidebar {...base} onOpenIam={vi.fn()} />);
    fireEvent.click(screen.getByText("IAM"));
    fireEvent.click(screen.getByText("IAM"));
    expect(screen.queryByText("🔐 IAM 관리")).not.toBeInTheDocument();
  });

  test("other services do not get it", () => {
    renderWithClient(<Sidebar {...base} onOpenIam={vi.fn()} />);
    fireEvent.click(screen.getByText("EC2"));
    expect(screen.queryByText("🔐 IAM 관리")).not.toBeInTheDocument();
  });

  test("is not shown when the app gives no handler", () => {
    renderWithClient(<Sidebar {...base} />);
    fireEvent.click(screen.getByText("IAM"));
    expect(screen.queryByText("🔐 IAM 관리")).not.toBeInTheDocument();
  });

  test("clicking it does not select a resource type", () => {
    const onSelect = vi.fn();
    renderWithClient(<Sidebar {...base} onSelect={onSelect} onOpenIam={vi.fn()} />);
    fireEvent.click(screen.getByText("IAM"));
    fireEvent.click(screen.getByText("🔐 IAM 관리"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("🐙 ArgoCD entry", () => {
  const withEks = { ...base, services: [...sampleServices, eksService] };

  test("sits after the cluster rows under an expanded EKS group and opens the ArgoCD tab", () => {
    const onOpenArgocd = vi.fn();
    renderWithClient(<Sidebar {...withEks} onOpenArgocd={onOpenArgocd} onOpenArgoWorkflows={vi.fn()} />);
    expect(screen.queryByText("🐙 ArgoCD")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("EKS"));
    const entry = screen.getByText("🐙 ArgoCD");
    // 클러스터가 맨 위, 단위가 큰 것부터: Clusters, Node Groups, 그다음 클러스터 위의 도구
    const rows = Array.from(entry.closest(".side-item")!.parentElement!.querySelectorAll(":scope > .side-item")).map((r) => r.textContent);
    expect(rows[0]).toMatch(/^Clusters/);
    expect(rows[1]).toMatch(/^Node Groups/);
    expect(rows.slice(2)).toEqual([ARGOCD_TITLE, ARGOWF_TITLE]);
    fireEvent.click(entry);
    expect(onOpenArgocd).toHaveBeenCalledTimes(1);
  });

  test("other services do not get it, and neither does EKS without a handler", () => {
    renderWithClient(<Sidebar {...withEks} onOpenArgocd={vi.fn()} />);
    fireEvent.click(screen.getByText("EC2"));
    expect(screen.queryByText("🐙 ArgoCD")).not.toBeInTheDocument();
    renderWithClient(<Sidebar {...withEks} />);
    fireEvent.click(screen.getAllByText("EKS")[1]);
    expect(screen.queryByText("🐙 ArgoCD")).not.toBeInTheDocument();
  });

  test("clicking it does not select a resource type", () => {
    const onSelect = vi.fn();
    renderWithClient(<Sidebar {...withEks} onSelect={onSelect} onOpenArgocd={vi.fn()} />);
    fireEvent.click(screen.getByText("EKS"));
    fireEvent.click(screen.getByText("🐙 ArgoCD"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("dragging rows in the first column", () => {
  // 형제 사이 순서대로 30px씩 쌓인 것으로 본다
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const i = Array.from(this.parentElement?.children ?? []).indexOf(this);
      return { top: i * 30, height: 30, bottom: i * 30 + 30, left: 0, right: 100, width: 100, x: 0, y: i * 30, toJSON: () => ({}) } as DOMRect;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const services = () => Array.from(document.querySelectorAll(".side .svc")).map((s) => s.lastChild!.textContent);
  const centerOf = (el: Element) => Array.from(el.parentElement!.children).indexOf(el) * 30 + 15;
  const drag = (grab: Element, item: Element, toY: number) => {
    fireEvent.mouseDown(grab, { button: 0, clientY: centerOf(item) });
    fireEvent.mouseMove(window, { clientY: toY });
    fireEvent.mouseUp(window, { clientY: toY });
    fireEvent.click(grab);
  };

  test("a service moves by its header, saves the new order without toggling, and keeps a hidden service's place", () => {
    const onServiceOrderChange = vi.fn();
    // eks는 지금 꺼져 있다(목록에 없다)
    renderWithClient(<Sidebar {...base} serviceOrder={["s3", "eks", "ec2", "iam"]} onServiceOrderChange={onServiceOrderChange} />);
    expect(services()).toEqual(["S3", "EC2", "IAM"]);
    const iam = screen.getByText("IAM");
    drag(iam, iam.closest(".side-item")!, 0);
    expect(onServiceOrderChange).toHaveBeenCalledWith(["iam", "eks", "s3", "ec2"]);
    // 놓은 뒤의 click은 IAM을 펴지 않는다
    expect(screen.queryByText("Users")).not.toBeInTheDocument();
  });

  test("pressing a row to drag does not start a text selection, but a right press is left alone", () => {
    renderWithClient(<Sidebar {...base} favorites={[{ service: "s3", type: "buckets" }]} />);
    // fireEvent는 preventDefault되면 false를 돌려준다
    expect(fireEvent.mouseDown(screen.getByText("EC2"), { button: 0 })).toBe(false);
    fireEvent.mouseUp(window);
    expect(fireEvent.mouseDown(screen.getByText("S3 › Buckets"), { button: 0 })).toBe(false);
    fireEvent.mouseUp(window);
    expect(fireEvent.mouseDown(screen.getByText("S3 › Buckets"), { button: 2 })).toBe(true);
  });

  test("rows under a service reorder within it and are saved for that service; the drop does not select", () => {
    const onTypeOrderChange = vi.fn();
    const onSelect = vi.fn();
    renderWithClient(<Sidebar {...base} services={[eksService]} onSelect={onSelect} onOpenArgocd={vi.fn()} onTypeOrderChange={onTypeOrderChange} />);
    fireEvent.click(screen.getByText("EKS"));
    const argocd = screen.getByText(ARGOCD_TITLE).closest(".side-item")!;
    drag(argocd, argocd, 0);
    expect(onTypeOrderChange).toHaveBeenCalledWith("eks", ["@argocd", "clusters", "node-groups"]);
    const clusters = screen.getByText("Clusters");
    drag(clusters, clusters.closest(".side-item")!, 200);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("a saved row order is shown, with rows it does not know after it", () => {
    renderWithClient(<Sidebar {...base} services={[eksService]} onOpenArgocd={vi.fn()} typeOrder={{ eks: ["node-groups", "@argocd"] }} />);
    fireEvent.click(screen.getByText("EKS"));
    const rows = Array.from(document.querySelectorAll(".svc ~ .side-item")).map((r) => r.querySelector("span")!.textContent);
    expect(rows).toEqual(["Node Groups", ARGOCD_TITLE, "Clusters"]);
  });

  test("favorites reorder and a disabled service's favorite keeps its place", () => {
    const onFavoritesChange = vi.fn();
    const favorites = [{ service: "s3", type: "buckets" }, { service: "lambda", type: "functions" }, { service: "ec2", type: "instances" }];
    renderWithClient(<Sidebar {...base} favorites={favorites} onFavoritesChange={onFavoritesChange} />);
    const ec2 = screen.getByText("EC2 › Instances").closest(".side-item")!;
    drag(ec2, ec2, 0);
    expect(onFavoritesChange).toHaveBeenCalledWith([favorites[2], favorites[1], favorites[0]]);
  });
});
