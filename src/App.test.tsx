import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import App from "./App";
import { api } from "./api/client";
import { vpcApi } from "./vpcmap/api";
import { sampleTopology } from "./vpcmap/fixtures";
import { makeResource, renderWithClient, sampleServices } from "./test/utils";

vi.mock("./api/client", () => ({
  api: {
    listProfiles: vi.fn(),
    getAccount: vi.fn(),
    listServices: vi.fn(),
    listResources: vi.fn(),
    listS3Objects: vi.fn(),
    ssoLogin: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
  },
}));
vi.mock("./explorer/api", () => ({
  explorerApi: {
    localHome: vi.fn(async () => "/home/me"),
    localList: vi.fn(async () => []),
    diffFiles: vi.fn(),
    startTransfers: vi.fn(),
  },
  onTransferProgress: vi.fn(async () => () => {}),
  onMouseNav: vi.fn(async () => () => {}),
}));
vi.mock("./vpcmap/api", () => ({ vpcApi: { topology: vi.fn(), savePng: vi.fn() } }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }),
}));
vi.mock("./api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const m = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  m.listProfiles.mockResolvedValue([
    { name: "dev", region: "us-east-1" },
    { name: "prod", region: "ap-northeast-2" },
  ]);
  m.getAccount.mockResolvedValue("123456789012");
  m.listServices.mockResolvedValue(sampleServices);
  m.getSettings.mockResolvedValue({ enabledServices: ["ec2", "iam"], favorites: [], lastProfile: "prod", lastRegion: null });
  m.saveSettings.mockResolvedValue(undefined);
  m.listResources.mockResolvedValue({ items: [makeResource("i-1", { name: "web-1", id: "i-1" })], truncated: false });
});

test("restores last profile, uses its region, shows only enabled services", async () => {
  renderWithClient(<App />);
  expect(await screen.findByRole("combobox", { name: "프로필" })).toHaveValue("prod");
  expect(screen.getByRole("combobox", { name: "리전" })).toHaveValue("ap-northeast-2");
  expect(screen.getByText("EC2")).toBeInTheDocument();
  expect(screen.getByText("IAM")).toBeInTheDocument();
  expect(screen.queryByText("S3")).not.toBeInTheDocument();
});

test("selecting a type lists resources", async () => {
  renderWithClient(<App />);
  fireEvent.click(await screen.findByText("EC2"));
  fireEvent.click(screen.getByText("Instances"));
  expect(await screen.findByText("web-1")).toBeInTheDocument();
  expect(m.listResources).toHaveBeenCalledWith("prod", "ap-northeast-2", "ec2", "instances");
});

test("changing profile switches region and saves settings", async () => {
  renderWithClient(<App />);
  const profile = await screen.findByRole("combobox", { name: "프로필" });
  fireEvent.change(profile, { target: { value: "dev" } });
  expect(screen.getByRole("combobox", { name: "리전" })).toHaveValue("us-east-1");
  await waitFor(() =>
    expect(m.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ lastProfile: "dev", lastRegion: "us-east-1" })),
  );
});

test("service settings toggles sidebar services", async () => {
  renderWithClient(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "서비스 설정" }));
  fireEvent.click(screen.getByLabelText(/S3/));
  fireEvent.click(screen.getByRole("button", { name: "완료" }));
  // 서비스 이름과 배지 약어가 모두 "S3"라 getAllByText를 쓴다
  expect(screen.getAllByText("S3").length).toBeGreaterThan(0);
  expect(m.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ enabledServices: ["ec2", "iam", "s3"] }));
});

test("cmd+F focuses the filter", async () => {
  renderWithClient(<App />);
  const filter = await screen.findByPlaceholderText(/필터/);
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  expect(filter).toHaveFocus();
});

test("cmd+F is case-insensitive (caps lock)", async () => {
  renderWithClient(<App />);
  const filter = await screen.findByPlaceholderText(/필터/);
  fireEvent.keyDown(window, { key: "F", metaKey: true });
  expect(filter).toHaveFocus();
});

test("no profiles shows setup guide", async () => {
  m.listProfiles.mockResolvedValue([]);
  renderWithClient(<App />);
  expect(await screen.findByText(/aws configure sso/)).toBeInTheDocument();
});

test("startup load failure shows error with retry", async () => {
  m.listServices.mockRejectedValue({ kind: "other", message: "boom" });
  renderWithClient(<App />);
  expect(await screen.findByText("boom")).toBeInTheDocument();
  m.listServices.mockResolvedValue(sampleServices);
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByText("EC2")).toBeInTheDocument();
});

// 탐색기 탭들도 같은 버킷 목록을 그리므로, 리소스 탭(DOM 첫 번째 패널)의 행만 고른다.
async function resourceBucket() {
  return (await screen.findAllByText("assets"))[0];
}

async function openAssetsBucket() {
  fireEvent.click((await screen.findAllByText("S3"))[0]);
  fireEvent.click(screen.getByText("Buckets"));
  fireEvent.doubleClick(await resourceBucket());
}

describe("bucket explorer tabs", () => {
  beforeEach(() => {
    m.getSettings.mockResolvedValue({ enabledServices: ["ec2", "iam", "s3"], favorites: [], lastProfile: "prod", lastRegion: null });
    m.listResources.mockResolvedValue({ items: [makeResource("assets", { name: "assets", region: "us-west-2" })], truncated: false });
    m.listS3Objects.mockResolvedValue({
      entries: [{ name: "a.txt", key: "a.txt", isFolder: false, size: 1, lastModified: null, storageClass: null }],
      nextToken: null,
    });
  });

  test("double clicking a bucket opens an active S3: tab showing its objects", async () => {
    renderWithClient(<App />);
    await openAssetsBucket();
    const tab = await screen.findByRole("tab", { name: /S3: assets/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    const pane = await screen.findByText("📄 a.txt", { selector: "[data-pane=s3] *" });
    expect(pane).toBeVisible();
    expect(m.listS3Objects).toHaveBeenCalledWith("prod", "us-west-2", "assets", "", null);
  });

  test("opening the same bucket again reuses the tab", async () => {
    renderWithClient(<App />);
    await openAssetsBucket();
    await screen.findByRole("tab", { name: /S3: assets/ });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.doubleClick(await resourceBucket());
    expect(screen.getAllByRole("tab", { name: /S3: assets/ })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: /S3: assets/ })).toHaveAttribute("aria-selected", "true");
  });

  test("closing a bucket tab removes it", async () => {
    renderWithClient(<App />);
    await openAssetsBucket();
    const tab = await screen.findByRole("tab", { name: /S3: assets/ });
    fireEvent.click(within(tab.parentElement as HTMLElement).getByRole("button", { name: /닫기/ }));
    expect(screen.queryByRole("tab", { name: /S3: assets/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
  });

  test("there is no explorer tab until a bucket is opened", async () => {
    renderWithClient(<App />);
    await screen.findByText("EC2");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["리소스"]);
    expect(screen.queryByTestId("pane-local")).not.toBeInTheDocument();
  });

  test("bucket tab keeps the resource tab mounted", async () => {
    renderWithClient(<App />);
    await openAssetsBucket();
    expect(await screen.findByTestId("pane-local")).toBeVisible();
    expect(await resourceBucket()).not.toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    expect(await resourceBucket()).toBeVisible();
  });

  test("local path change is persisted to settings", async () => {
    renderWithClient(<App />);
    await openAssetsBucket();
    const local = await screen.findByTestId("pane-local");
    fireEvent.click(await within(local).findByRole("button", { name: "상위 폴더" }));
    await waitFor(() => expect(m.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ explorerLocalPath: "/home" })));
  });

  test("changing profile closes bucket tabs", async () => {
    renderWithClient(<App />);
    await openAssetsBucket();
    await screen.findByRole("tab", { name: /S3: assets/ });
    fireEvent.change(screen.getByRole("combobox", { name: "프로필" }), { target: { value: "dev" } });
    expect(screen.queryByRole("tab", { name: /S3: assets/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("VPC 구조도 탭", () => {
  const vpcService = {
    id: "vpc",
    name: "VPC",
    global: false,
    types: [{ id: "vpcs", name: "VPCs", columns: [{ key: "name", label: "Name", kind: "text" as const }] }],
  };
  beforeEach(() => {
    m.listServices.mockResolvedValue([...sampleServices, vpcService]);
    m.getSettings.mockResolvedValue({ enabledServices: ["ec2", "vpc"], favorites: [], lastProfile: "prod", lastRegion: null });
    m.listResources.mockResolvedValue({ items: [makeResource("vpc-1", { name: "prod-vpc" })], truncated: false });
    vi.mocked(vpcApi.topology).mockResolvedValue(sampleTopology());
  });
  const openVpc = async () => {
    renderWithClient(<App />);
    fireEvent.click(await screen.findByText("VPC"));
    fireEvent.click(screen.getByText("VPCs"));
    fireEvent.doubleClick(await screen.findByText("prod-vpc"));
  };

  test("double-clicking a VPC opens a map tab and reuses it", async () => {
    await openVpc();
    expect(await screen.findByRole("tab", { name: /🗺 prod-vpc/ })).toBeInTheDocument();
    expect(vpcApi.topology).toHaveBeenCalledWith("prod", "ap-northeast-2", "vpc-1");
    expect(await screen.findByText("pub-a")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.doubleClick(screen.getByText("prod-vpc"));
    expect(screen.getAllByRole("tab", { name: /🗺/ })).toHaveLength(1);
  });

  test("closing the tab returns to resources; profile change closes it", async () => {
    await openVpc();
    await screen.findByRole("tab", { name: /🗺 prod-vpc/ });
    fireEvent.click(screen.getByRole("button", { name: /닫기/ }));
    expect(screen.queryByRole("tab", { name: /🗺/ })).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText("prod-vpc"));
    await screen.findByRole("tab", { name: /🗺 prod-vpc/ });
    fireEvent.change(screen.getByRole("combobox", { name: "프로필" }), { target: { value: "dev" } });
    expect(screen.queryByRole("tab", { name: /🗺/ })).not.toBeInTheDocument();
  });
});
