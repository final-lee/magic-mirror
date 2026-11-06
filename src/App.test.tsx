import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import App from "./App";
import { api } from "./api/client";
import { reportSsoExpired } from "./api/invoke";
import { iamApi } from "./iam/api";
import { ACCOUNT, alice, aliceView, bob, sampleFindings, sampleOverview } from "./iam/fixtures";
import { pgApi } from "./pg/api";
import { LOGIN_USER, sampleFindings as samplePgFindings, sampleOverview as samplePgOverview, sampleTargetInfo } from "./pg/fixtures";
import { pgKeys } from "./pg/queries";
import { vpcApi } from "./vpcmap/api";
import { sampleTopology } from "./vpcmap/fixtures";
import { cacheRow, dbRow, eksService, elasticacheService, makeResource, rdsService, renderWithClient, sampleServices } from "./test/utils";
import { kvApi } from "./kv/api";
import { sampleKeys as kvSampleKeys, sampleOverview as kvSampleOverview, sampleTargetInfo as kvSampleTargetInfo } from "./kv/fixtures";
import { kvKeys } from "./kv/queries";
import { FOCUS_GONE } from "./components/ResourceArea";
import { k8sApi } from "./k8s/api";
import { tabTitle } from "./k8s/text";
import { networkApi } from "./k8s/network/api";
import { loadBalancer, network as sampleNetwork, row as networkRow } from "./k8s/network/fixtures";
import { argocdApi } from "./argocd/api";
import { ARGOCD_TITLE, SERVER_HELP } from "./argocd/text";
import { costApi } from "./cost/api";
import { sampleBreakdown, sampleOverview as sampleCostOverview } from "./cost/fixtures";
import { BREAKDOWN_LABEL, COST_TITLE } from "./cost/text";
import { ARGOWF_TITLE } from "./argowf/text";
import { tailscaleApi } from "./tailscale/api";

vi.mock("./api/client", () => ({
  api: {
    listProfiles: vi.fn(),
    getAccount: vi.fn(),
    listServices: vi.fn(),
    listResources: vi.fn(),
    resourceIndex: vi.fn(),
    clearResourceIndex: vi.fn(),
    listS3Objects: vi.fn(),
    ssoLogin: vi.fn(),
    ssoLoginCancel: vi.fn(),
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
vi.mock("./pg/api", () => ({
  pgApi: {
    target: vi.fn(),
    open: vi.fn(),
    database: vi.fn(),
    cell: vi.fn(),
    objects: vi.fn(),
    role: vi.fn(),
    whoCan: vi.fn(),
    sessions: vi.fn(),
    findings: vi.fn(),
    close: vi.fn(async () => null),
  },
}));
vi.mock("./kv/api", () => ({
  kvApi: { target: vi.fn(), open: vi.fn(), overview: vi.fn(), scan: vi.fn(), key: vi.fn(), slowlog: vi.fn(), clients: vi.fn(), bigkeys: vi.fn(), bigkeysStop: vi.fn(), bigkeysReport: vi.fn(async () => null), close: vi.fn(async () => null), forgetPassword: vi.fn(), bullQueues: vi.fn(), bullQueueSummaries: vi.fn(), bullQueue: vi.fn(), bullJobs: vi.fn(), bullJob: vi.fn(), bullFlow: vi.fn(), bullTransitions: vi.fn(), bullTopology: vi.fn() },
}));
// 터미널(xterm)은 k8s/PodTerminal.test에서 본다
vi.mock("./k8s/PodTerminal", () => ({ PodTerminal: () => null }));
vi.mock("./k8s/api", () => ({
  k8sApi: { context: vi.fn(), open: vi.fn(), close: vi.fn(async () => null), rules: vi.fn(), watch: vi.fn(), unwatch: vi.fn() },
}));
vi.mock("./k8s/network/api", () => ({ networkApi: { network: vi.fn() } }));
vi.mock("./iam/api", () => ({
  iamApi: { overview: vi.fn(), principal: vi.fn(), principalActions: vi.fn(), policy: vi.fn(), accessKeys: vi.fn(), findings: vi.fn() },
}));
vi.mock("./argocd/api", () => ({
  argocdApi: { session: vi.fn(), setToken: vi.fn(), forgetToken: vi.fn(), apps: vi.fn(), appsets: vi.fn(), app: vi.fn(), tree: vi.fn(), refresh: vi.fn(), sync: vi.fn() },
}));
vi.mock("./cost/api", () => ({ costApi: { overview: vi.fn(), breakdown: vi.fn(), tagKeys: vi.fn(), usage: vi.fn() } }));
vi.mock("./tailscale/api", () => ({ tailscaleApi: { node: vi.fn(), diagnose: vi.fn(), acceptRoutes: vi.fn() } }));
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

test("Tailscale은 새 탭 없이 리소스 탭의 오른쪽 칸에 열리고, 리소스를 골랐다 돌아와도·프로필을 바꿔도 그대로예요", async () => {
  vi.mocked(tailscaleApi.node).mockResolvedValue({ cli: null, version: null, backendState: null, health: [], tailnet: null, magicDnsSuffix: null, user: null, self: null, prefs: null, peers: [] });
  renderWithClient(<App />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "프로필" })).toHaveValue("prod"));
  fireEvent.click(screen.getByRole("button", { name: "Tailscale" }));
  expect(await screen.findByText(/Tailscale 앱을 설치/)).toBeInTheDocument();
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["리소스"]);
  expect(screen.getByRole("button", { name: "Tailscale" })).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "기기" }));

  // 리소스 종류를 고르면 오른쪽 칸이 목록으로 바뀐다
  fireEvent.click(screen.getByText("EC2"));
  fireEvent.click(await screen.findByText("Instances"));
  expect(await screen.findByText("web-1")).toBeVisible();
  expect(screen.getByRole("button", { name: "기기", hidden: true })).not.toBeVisible();
  expect(screen.getByRole("button", { name: "Tailscale" })).not.toHaveAttribute("aria-current");

  // 다시 열면 고른 화면(기기)이 남아 있고, 프로필을 바꿔도 닫히지 않는다
  fireEvent.click(screen.getByRole("button", { name: "Tailscale" }));
  expect(screen.getByRole("button", { name: "기기" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.change(screen.getByRole("combobox", { name: "프로필" }), { target: { value: "dev" } });
  expect(screen.getByRole("button", { name: "기기" })).toHaveAttribute("aria-pressed", "true");
});

test("Argo Workflows는 단일 탭으로 열리고 프로필을 바꿔도 남는다", async () => {
  m.listServices.mockResolvedValue([...sampleServices, eksService]);
  m.getSettings.mockResolvedValue({ enabledServices: ["eks"], favorites: [], lastProfile: "prod", lastRegion: null });
  renderWithClient(<App />);
  fireEvent.click(await screen.findByText("EKS"));
  fireEvent.click(screen.getByText(ARGOWF_TITLE));
  fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
  fireEvent.click(screen.getByText(ARGOWF_TITLE, { selector: ".typ span" }));
  expect(screen.getAllByRole("tab", { name: ARGOWF_TITLE })).toHaveLength(1);
  expect(await screen.findByText("Argo Server 주소를 넣어 주세요")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "프로필" }), { target: { value: "dev" } });
  expect(screen.getByText("Argo Server 주소를 넣어 주세요")).toBeInTheDocument();
  const tab = screen.getByRole("tab", { name: new RegExp(ARGOWF_TITLE) });
  expect(tab).toBeInTheDocument();
});

test("restores last profile, uses its region, shows only enabled services", async () => {
  renderWithClient(<App />);
  const profile = await screen.findByRole("combobox", { name: "프로필" });
  // 첫 렌더에는 아직 마지막 프로필이 복원되기 전이라 첫 옵션이 보인다. 복원 이펙트의 재렌더를 기다린다.
  await waitFor(() => expect(profile).toHaveValue("prod"));
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

test("loads and saves the selected theme", async () => {
  m.getSettings.mockResolvedValue({ enabledServices: ["ec2"], favorites: [], lastProfile: "prod", lastRegion: null, theme: "dark" });
  renderWithClient(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "서비스 설정" }));
  expect(screen.getByLabelText("어둡게")).toBeChecked();
  expect(document.documentElement.dataset.theme).toBe("dark");
  fireEvent.click(screen.getByLabelText("밝게"));
  expect(m.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "light" }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
});

test("⌘F opens a find line inside the visible list that filters only it; Esc clears and closes it", async () => {
  m.getSettings.mockResolvedValue({ enabledServices: ["ec2", "iam", "s3"], favorites: [], lastProfile: "prod", lastRegion: null });
  m.listResources.mockResolvedValue({ items: [makeResource("assets", { name: "assets" }), makeResource("logs", { name: "logs" })], truncated: false });
  renderWithClient(<App />);
  fireEvent.click((await screen.findAllByText("S3"))[0]);
  fireEvent.click(screen.getByText("Buckets"));
  const table = await screen.findByTestId("resource-table");
  await within(table).findByText("logs");
  // 평소에는 찾기 줄이 없다
  expect(screen.queryByRole("search")).toBeNull();
  // 대문자(Caps Lock)도 같은 키
  fireEvent.keyDown(window, { key: "F", metaKey: true });
  const input = screen.getByRole("textbox", { name: "목록에서 찾기" });
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "ass" } });
  expect(within(table).queryByText("logs")).toBeNull();
  expect(table).toHaveTextContent("assets");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("search")).toBeNull();
  expect(within(table).getByText("logs")).toBeInTheDocument();
});

test("no profiles shows setup guide", async () => {
  m.listProfiles.mockResolvedValue([]);
  renderWithClient(<App />);
  expect(await screen.findByText(/aws configure sso/)).toBeInTheDocument();
});

test("an expired SSO session logs in automatically and shows the banner", async () => {
  m.listProfiles.mockResolvedValue([
    { name: "dev", region: "us-east-1", ssoLogin: "dev", ssoKey: "session:corp" },
    { name: "prod", region: "ap-northeast-2", ssoLogin: "dev", ssoKey: "session:corp" },
  ]);
  // Once: 끝나지 않는 구현이 파일 끝까지 남아 뒤의 테스트가 이어받지 않게 한다
  m.ssoLogin.mockReturnValueOnce(new Promise(() => {}));
  renderWithClient(<App />);
  await screen.findByRole("combobox", { name: "프로필" });
  act(() => reportSsoExpired("prod"));
  expect(m.ssoLogin).toHaveBeenCalledWith("dev");
  expect(await screen.findByText("prod: SSO 로그인 중이에요. 브라우저에서 승인해 주세요")).toBeInTheDocument();
});

describe("SSO auto-login across profile switches", () => {
  // 프로필마다 다른 SSO 세션
  beforeEach(() => {
    m.listProfiles.mockResolvedValue([
      { name: "dev", region: "us-east-1", ssoLogin: "dev", ssoKey: "session:dev" },
      { name: "prod", region: "ap-northeast-2", ssoLogin: "prod", ssoKey: "session:prod" },
    ]);
  });
  const openProd = async () => {
    renderWithClient(<App />);
    const profile = await screen.findByRole("combobox", { name: "프로필" });
    await waitFor(() => expect(profile).toHaveValue("prod"));
    return profile;
  };

  test("choosing a profile again re-arms automatic login after a failure", async () => {
    m.ssoLogin.mockRejectedValueOnce({ kind: "other", message: "aws CLI를 찾을 수 없어요" });
    const profile = await openProd();
    await act(async () => reportSsoExpired("prod"));
    expect(await screen.findByText("prod: SSO 로그인에 실패했어요: aws CLI를 찾을 수 없어요")).toBeInTheDocument();
    act(() => reportSsoExpired("prod"));
    expect(m.ssoLogin).toHaveBeenCalledTimes(1); // 실패한 세션은 자동으로 다시 열지 않는다

    fireEvent.change(profile, { target: { value: "dev" } });
    fireEvent.change(profile, { target: { value: "prod" } });
    expect(screen.queryByText(/SSO 로그인에 실패했어요/)).not.toBeInTheDocument();
    m.ssoLogin.mockReturnValueOnce(new Promise(() => {}));
    act(() => reportSsoExpired("prod"));
    expect(m.ssoLogin).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("prod: SSO 로그인 중이에요. 브라우저에서 승인해 주세요")).toBeInTheDocument();
  });

  test("an expiry right after a successful login says to check the profile settings and opens no second login", async () => {
    m.ssoLogin.mockResolvedValueOnce(undefined);
    await openProd();
    await act(async () => reportSsoExpired("prod")); // 첫 만료: 로그인하고 성공한다
    await waitFor(() => expect(screen.queryByText(/SSO 로그인 중이에요/)).not.toBeInTheDocument());
    expect(m.ssoLogin).toHaveBeenCalledTimes(1);

    act(() => reportSsoExpired("prod")); // 로그인이 끝난 뒤에 시작한 호출이 또 만료로 실패했다
    expect(await screen.findByText("prod: 로그인했는데도 자격 증명을 받지 못했어요. 프로필 설정을 확인해 주세요")).toBeInTheDocument();
    expect(screen.queryByText(/SSO 로그인에 실패했어요/)).not.toBeInTheDocument(); // 로그인이 실패한 것이 아니다
    expect(m.ssoLogin).toHaveBeenCalledTimes(1);
  });

  test("a late expiry report from the profile we just left does not open a login", async () => {
    const profile = await openProd();
    fireEvent.change(profile, { target: { value: "dev" } });
    act(() => reportSsoExpired("prod")); // 바꾸기 전에 부른 prod 호출이 뒤늦게 실패했다
    expect(m.ssoLogin).not.toHaveBeenCalled();
    expect(screen.queryByText(/SSO 로그인/)).not.toBeInTheDocument();
  });
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

describe("IAM 작업 공간 탭", () => {
  const IAM_TAB = `🔐 IAM · ${ACCOUNT}`;
  const iam = vi.mocked(iamApi);
  beforeEach(() => {
    iam.overview.mockResolvedValue(sampleOverview());
    iam.principal.mockImplementation(async (_profile, arn) => aliceView(arn === bob.arn ? { summary: bob } : {}));
    iam.principalActions.mockResolvedValue([]);
    iam.findings.mockResolvedValue(sampleFindings());
    m.listResources.mockResolvedValue({ items: [makeResource("alice", { name: "alice" }, { arn: alice.arn })], truncated: false });
  });
  const openFromSidebar = async () => {
    renderWithClient(<App />);
    fireEvent.click(await screen.findByText("IAM"));
    fireEvent.click(await screen.findByText("🔐 IAM 관리"));
  };
  // IAM 탭은 점검 화면으로 열린다. 사용자 목록이 필요하면 메뉴로 이동한다.
  const findingCards = () => screen.findByRole("group", { name: "점검 항목" });
  const openIamUsers = async () => {
    await openFromSidebar();
    fireEvent.click(within(await screen.findByRole("navigation", { name: "IAM 메뉴" })).getByRole("button", { name: /사용자/ }));
    return screen.findByTestId("iam-list");
  };
  const openUserFromList = async () => {
    fireEvent.click(await screen.findByText("IAM"));
    fireEvent.click(screen.getByText("Users"));
    fireEvent.doubleClick(await screen.findByText("alice"));
  };
  const iamTabs = () => screen.queryAllByRole("tab", { name: /🔐 IAM/ });

  test("the sidebar entry opens an active IAM tab titled with the account id", async () => {
    await openFromSidebar();
    const tab = await screen.findByRole("tab", { name: IAM_TAB });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(iam.overview).toHaveBeenCalledWith("prod", false);
    expect(await findingCards()).toBeVisible();
    expect(iam.findings).toHaveBeenCalledWith("prod");
  });

  test("the title is just 🔐 IAM until the overview has loaded", async () => {
    let resolve!: (v: ReturnType<typeof sampleOverview>) => void;
    iam.overview.mockReturnValue(new Promise((r) => (resolve = r)));
    await openFromSidebar();
    expect(await screen.findByRole("tab", { name: "🔐 IAM" })).toBeInTheDocument();
    resolve(sampleOverview());
    expect(await screen.findByRole("tab", { name: IAM_TAB })).toBeInTheDocument();
  });

  test("opening it again reuses the tab", async () => {
    await openFromSidebar();
    await screen.findByRole("tab", { name: IAM_TAB });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    expect(screen.getByRole("tab", { name: IAM_TAB })).toHaveAttribute("aria-selected", "false");
    fireEvent.click(screen.getByText("🔐 IAM 관리"));
    expect(iamTabs()).toHaveLength(1);
    expect(screen.getByRole("tab", { name: IAM_TAB })).toHaveAttribute("aria-selected", "true");
  });

  test("double-clicking an IAM user opens the tab on that user", async () => {
    renderWithClient(<App />);
    await openUserFromList();
    expect(await screen.findByRole("heading", { name: "alice" })).toBeVisible();
    expect(iam.principal).toHaveBeenCalledWith("prod", alice.arn);
    expect(screen.getByRole("tab", { name: IAM_TAB })).toHaveAttribute("aria-selected", "true");
  });

  test("an open tab moves to the target of a later double click", async () => {
    await openFromSidebar();
    await findingCards();
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.click(screen.getByText("Users"));
    fireEvent.doubleClick(await screen.findByText("alice", { selector: "[data-testid=resource-table] *" }));
    expect(await screen.findByRole("heading", { name: "alice" })).toBeVisible();
    expect(iamTabs()).toHaveLength(1);
  });

  test("closing the tab returns to the resources tab", async () => {
    await openFromSidebar();
    const tab = await screen.findByRole("tab", { name: IAM_TAB });
    fireEvent.click(within(tab.parentElement as HTMLElement).getByRole("button", { name: /닫기/ }));
    expect(iamTabs()).toHaveLength(0);
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("iam-list")).not.toBeInTheDocument();
  });

  test("changing the profile closes the IAM tab", async () => {
    await openFromSidebar();
    await screen.findByRole("tab", { name: IAM_TAB });
    fireEvent.change(screen.getByRole("combobox", { name: "프로필" }), { target: { value: "dev" } });
    expect(iamTabs()).toHaveLength(0);
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
  });

  test("the IAM tab sits right after the resources tab, before bucket tabs", async () => {
    m.getSettings.mockResolvedValue({ enabledServices: ["ec2", "iam", "s3"], favorites: [], lastProfile: "prod", lastRegion: null });
    m.listResources.mockImplementation(async (_p, _r, service) =>
      service === "s3"
        ? { items: [makeResource("assets", { name: "assets", region: "us-west-2" })], truncated: false }
        : { items: [makeResource("alice", { name: "alice" }, { arn: alice.arn })], truncated: false },
    );
    m.listS3Objects.mockResolvedValue({ entries: [], nextToken: null });
    renderWithClient(<App />);
    await openAssetsBucket();
    await screen.findByRole("tab", { name: /S3: assets/ });
    fireEvent.click(screen.getByText("IAM"));
    fireEvent.click(await screen.findByText("🔐 IAM 관리"));
    await screen.findByRole("tab", { name: IAM_TAB });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["리소스", IAM_TAB, "S3: assets"]);
  });

  test("⌘F on the IAM tab opens the find line in the IAM list and filters only it; the hidden resources tab does not react", async () => {
    // 리소스 탭에 Users 목록을 열어 둔 채 IAM 탭으로 간다
    renderWithClient(<App />);
    fireEvent.click(await screen.findByText("IAM"));
    fireEvent.click(screen.getByText("Users"));
    const resources = await screen.findByTestId("resource-table");
    await within(resources).findByText("alice");
    fireEvent.click(await screen.findByText("🔐 IAM 관리"));
    fireEvent.click(within(await screen.findByRole("navigation", { name: "IAM 메뉴" })).getByRole("button", { name: /사용자/ }));
    const list = await screen.findByTestId("iam-list");
    await within(list).findByText("bob");
    // 평소에는 어느 목록에도 찾기 줄이 없다
    expect(screen.queryByRole("search")).toBeNull();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const input = screen.getByRole("textbox", { name: "목록에서 찾기" });
    expect(list.closest(".find-host")).toContainElement(input);
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "bob" } });
    expect(within(list).queryByText("alice")).not.toBeInTheDocument();
    expect(within(list).getByText("bob")).toBeInTheDocument();
    // 숨은 리소스 탭의 목록은 그대로다(줄도 없고 거르지도 않는다)
    expect(within(resources).getByText("alice")).toBeInTheDocument();
    expect(resources.closest("[hidden]")).not.toBeNull();
    expect(resources.closest("section")!.querySelector(".list-find")).toBeNull();
    // 탭을 옮겼다 돌아와도 그 목록의 검색은 그대로다. 리소스 탭에는 찾기 줄이 없다
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    expect(screen.queryByRole("search")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: IAM_TAB }));
    expect(screen.getByRole("textbox", { name: "목록에서 찾기" })).toHaveValue("bob");
    expect(within(screen.getByTestId("iam-list")).queryByText("alice")).not.toBeInTheDocument();
    // Esc는 검색어를 지우고 줄을 닫는다
    fireEvent.keyDown(screen.getByRole("textbox", { name: "목록에서 찾기" }), { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(within(screen.getByTestId("iam-list")).getByText("alice")).toBeInTheDocument();
  });

  test("⌘R rebuilds the IAM snapshot with a forced overview call", async () => {
    await openFromSidebar();
    await findingCards();
    fireEvent.keyDown(window, { key: "r", metaKey: true });
    await waitFor(() => expect(iam.overview).toHaveBeenLastCalledWith("prod", true));
  });

  test("history keys only act while the IAM tab is the active one", async () => {
    renderWithClient(<App />);
    await openUserFromList();
    await screen.findByRole("heading", { name: "alice" });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    fireEvent.click(screen.getByRole("tab", { name: IAM_TAB }));
    expect(screen.getByRole("heading", { name: "alice" })).toBeVisible();
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    expect(await findingCards()).toBeVisible();
    // 목록에서 다른 행으로 열면 새 기록이 쌓인다
    fireEvent.click(within(screen.getByRole("navigation", { name: "IAM 메뉴" })).getByRole("button", { name: /사용자/ }));
    fireEvent.doubleClick(within(await screen.findByTestId("iam-list")).getByText(bob.name));
    expect(await screen.findByRole("heading", { name: "bob" })).toBeVisible();
  });
});

describe("💰 비용 탭", () => {
  const cost = vi.mocked(costApi);
  beforeEach(() => {
    cost.overview.mockResolvedValue(sampleCostOverview());
    cost.breakdown.mockResolvedValue(sampleBreakdown());
    cost.usage.mockResolvedValue({ yearMonth: "2026-10", requests: 3 });
  });
  const openCost = async () => {
    renderWithClient(<App />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "프로필" })).toHaveValue("prod"));
    fireEvent.click(await screen.findByRole("button", { name: COST_TITLE }));
    await screen.findByRole("table", { name: BREAKDOWN_LABEL });
  };

  test("the sidebar row above the services opens one active cost tab for the profile", async () => {
    await openCost();
    expect(screen.getByRole("tab", { name: COST_TITLE })).toHaveAttribute("aria-selected", "true");
    expect(cost.overview).toHaveBeenCalledWith("prod", expect.objectContaining({ period: "thisMonth" }), false);
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "서비스" })).getByRole("button", { name: COST_TITLE }));
    expect(screen.getAllByRole("tab", { name: COST_TITLE })).toHaveLength(1);
  });

  test("⌘R on the cost tab skips the cost cache; ⌘R elsewhere leaves the cost queries alone", async () => {
    await openCost();
    fireEvent.keyDown(window, { key: "r", metaKey: true });
    await waitFor(() => expect(cost.overview).toHaveBeenLastCalledWith("prod", expect.anything(), true));
    const calls = cost.overview.mock.calls.length;
    const accountReads = m.getAccount.mock.calls.length;
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.keyDown(window, { key: "r", metaKey: true });
    // 같은 ⌘R이 다른 것(계정 ID)은 다시 읽는다
    await waitFor(() => expect(m.getAccount.mock.calls.length).toBeGreaterThan(accountReads));
    expect(cost.overview).toHaveBeenCalledTimes(calls);
  });

  test("changing the profile closes the cost tab", async () => {
    await openCost();
    fireEvent.change(screen.getByRole("combobox", { name: "프로필" }), { target: { value: "dev" } });
    expect(screen.queryByRole("tab", { name: COST_TITLE })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("PostgreSQL 탭", () => {
  const target = (id: string, kind: "cluster" | "instance" = "cluster") => ({ profile: "prod", region: "ap-northeast-2", kind, id });
  const arnOf = (id: string) => `arn:aws:rds:ap-northeast-2:123456789012:cluster:${id}`;
  const pgTabs = () => screen.queryAllByRole("tab", { name: /🐘/ });
  const closeButtonOf = (tab: HTMLElement) => within(tab.parentElement as HTMLElement).getByRole("button", { name: /닫기/ });

  beforeEach(() => {
    // 탭은 진짜 PgTab을 그린다. 대상 확인 → 연결 → 점검 순으로 읽으니 그 명령들이 답한다.
    vi.mocked(pgApi.target).mockImplementation(async (t) => sampleTargetInfo({ identifier: t.id, arn: arnOf(t.id) }));
    vi.mocked(pgApi.open).mockResolvedValue(samplePgOverview());
    vi.mocked(pgApi.findings).mockResolvedValue(samplePgFindings());
    m.listServices.mockResolvedValue([...sampleServices, rdsService]);
    m.getSettings.mockResolvedValue({ enabledServices: ["ec2", "rds"], favorites: [], lastProfile: "prod", lastRegion: null });
    m.listResources.mockImplementation(async (_p, _r, _service, typeId) => ({
      items:
        typeId === "db-clusters"
          ? [dbRow("orders-aurora", "aurora-postgresql"), dbRow("billing", "postgres"), dbRow("legacy", "aurora-mysql")]
          : [dbRow("orders-aurora-1", "aurora-postgresql", { cluster: "orders-aurora" }), dbRow("reports-db", "postgres", { cluster: "" })],
      truncated: false,
    }));
  });

  const showClusters = async () => {
    const view = renderWithClient(<App />);
    fireEvent.click(await screen.findByText("RDS"));
    fireEvent.click(screen.getByText("DB Clusters"));
    await screen.findByText("orders-aurora");
    return view;
  };
  const openCluster = async (name: string) => fireEvent.doubleClick(await screen.findByText(name));

  test("double-clicking a PostgreSQL cluster opens an active 🐘 tab titled with its identifier", async () => {
    await showClusters();
    await openCluster("orders-aurora");
    const tab = await screen.findByRole("tab", { name: "🐘 orders-aurora" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(pgTabs()).toHaveLength(1);
  });

  test("double-clicking an Aurora instance opens the tab of its cluster", async () => {
    renderWithClient(<App />);
    fireEvent.click(await screen.findByText("RDS"));
    fireEvent.click(screen.getByText("DB Instances"));
    fireEvent.doubleClick(await screen.findByText("orders-aurora-1"));
    expect(await screen.findByRole("tab", { name: "🐘 orders-aurora" })).toHaveAttribute("aria-selected", "true");
  });

  test("a PostgreSQL instance outside a cluster opens its own tab", async () => {
    renderWithClient(<App />);
    fireEvent.click(await screen.findByText("RDS"));
    fireEvent.click(screen.getByText("DB Instances"));
    fireEvent.doubleClick(await screen.findByText("reports-db"));
    expect(await screen.findByRole("tab", { name: "🐘 reports-db" })).toBeInTheDocument();
  });

  test("opening the same target twice keeps one tab and activates it", async () => {
    await showClusters();
    await openCluster("orders-aurora");
    await screen.findByRole("tab", { name: "🐘 orders-aurora" });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    expect(screen.getByRole("tab", { name: "🐘 orders-aurora" })).toHaveAttribute("aria-selected", "false");
    // 열린 🐘 탭의 위쪽 줄에도 같은 이름이 있으니 보이는 리소스 표 안에서 찾는다
    fireEvent.doubleClick(within(screen.getByRole("table")).getByText("orders-aurora"));
    expect(pgTabs()).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "🐘 orders-aurora" })).toHaveAttribute("aria-selected", "true");
    expect(pgApi.close).not.toHaveBeenCalled();
  });

  test("different targets get their own tabs, in the order they were opened", async () => {
    await showClusters();
    await openCluster("orders-aurora");
    await screen.findByRole("tab", { name: "🐘 orders-aurora" });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.doubleClick(screen.getByText("billing"));
    await screen.findByRole("tab", { name: "🐘 billing" });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["리소스", "🐘 orders-aurora", "🐘 billing"]);
  });

  test("a MySQL cluster shows the notice and opens no tab", async () => {
    await showClusters();
    await openCluster("legacy");
    const notice = await screen.findByText("PostgreSQL 엔진만 열 수 있어요");
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(pgTabs()).toHaveLength(0);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["리소스"]);
  });

  test("closing the tab calls pgApi.close with its target and returns to the resources tab", async () => {
    await showClusters();
    await openCluster("orders-aurora");
    const tab = await screen.findByRole("tab", { name: "🐘 orders-aurora" });
    fireEvent.click(closeButtonOf(tab));
    expect(pgApi.close).toHaveBeenCalledTimes(1);
    expect(pgApi.close).toHaveBeenCalledWith(target("orders-aurora"));
    expect(pgTabs()).toHaveLength(0);
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
  });

  test("closing a tab does not close the other PostgreSQL tabs", async () => {
    await showClusters();
    await openCluster("orders-aurora");
    const first = await screen.findByRole("tab", { name: "🐘 orders-aurora" });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.doubleClick(screen.getByText("billing"));
    await screen.findByRole("tab", { name: "🐘 billing" });
    fireEvent.click(closeButtonOf(first));
    expect(pgApi.close).toHaveBeenCalledTimes(1);
    expect(pgApi.close).toHaveBeenCalledWith(target("orders-aurora"));
    expect(screen.getByRole("tab", { name: "🐘 billing" })).toHaveAttribute("aria-selected", "true");
  });

  test("closing the tab drops that target's cached reads and no other target's", async () => {
    const { qc } = await showClusters();
    await openCluster("orders-aurora");
    const tab = await screen.findByRole("tab", { name: "🐘 orders-aurora" });
    const key = pgKeys.overview(target("orders-aurora"), LOGIN_USER);
    qc.setQueryData(key, samplePgOverview());
    qc.setQueryData(pgKeys.sessions(target("billing")), []);
    fireEvent.click(closeButtonOf(tab));
    expect(qc.getQueryData(key)).toBeUndefined();
    expect(qc.getQueryData(pgKeys.sessions(target("billing")))).toEqual([]); // 다른 대상은 그대로
  });

  test("changing profile closes all PostgreSQL tabs and closes each target", async () => {
    await showClusters();
    await openCluster("orders-aurora");
    await screen.findByRole("tab", { name: "🐘 orders-aurora" });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.doubleClick(screen.getByText("billing"));
    await screen.findByRole("tab", { name: "🐘 billing" });

    fireEvent.change(screen.getByRole("combobox", { name: "프로필" }), { target: { value: "dev" } });
    expect(pgTabs()).toHaveLength(0);
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
    expect(pgApi.close).toHaveBeenCalledTimes(2);
    expect(pgApi.close).toHaveBeenCalledWith(target("orders-aurora"));
    expect(pgApi.close).toHaveBeenCalledWith(target("billing"));
  });

  test("changing profile closes the PostgreSQL tabs even when the resources tab is the active one", async () => {
    await showClusters();
    await openCluster("orders-aurora");
    await screen.findByRole("tab", { name: "🐘 orders-aurora" });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.change(screen.getByRole("combobox", { name: "프로필" }), { target: { value: "dev" } });
    expect(pgTabs()).toHaveLength(0);
    expect(pgApi.close).toHaveBeenCalledWith(target("orders-aurora"));
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
  });

  test("changing the region keeps the tab, like the other tabs that carry their own region", async () => {
    await showClusters();
    await openCluster("orders-aurora");
    await screen.findByRole("tab", { name: "🐘 orders-aurora" });
    fireEvent.change(screen.getByRole("combobox", { name: "리전" }), { target: { value: "us-east-1" } });
    expect(pgTabs()).toHaveLength(1);
    expect(pgApi.close).not.toHaveBeenCalled();
  });

  describe("refreshing (⌘R and the toolbar button)", () => {
    /** 두 대상 모두 DB 사용자가 기억돼 있어서 탭을 열면 바로 연결한다 */
    const rememberBoth = () =>
      m.getSettings.mockResolvedValue({
        enabledServices: ["ec2", "rds"],
        favorites: [],
        lastProfile: "prod",
        lastRegion: null,
        pgLogins: { [arnOf("orders-aurora")]: LOGIN_USER, [arnOf("billing")]: LOGIN_USER },
      });
    const opensOf = (id: string) => vi.mocked(pgApi.open).mock.calls.filter(([t]) => t.id === id).length;
    const targetsOf = (id: string) => vi.mocked(pgApi.target).mock.calls.filter(([t]) => t.id === id).length;
    const cmdR = () => fireEvent.keyDown(window, { key: "r", metaKey: true });
    /** orders-aurora 탭을 열어 연결이 끝나고 역할 목록이 보일 때까지 기다린다 */
    const openConnected = async (id = "orders-aurora") => {
      await openCluster(id);
      await screen.findByRole("tab", { name: `🐘 ${id}` });
      await screen.findByRole("navigation", { name: "PostgreSQL 메뉴" });
      await screen.findByRole("table", { name: "역할 목록" });
    };

    test("⌘R with a PostgreSQL tab showing reads that target again, from the connection on", async () => {
      rememberBoth();
      await showClusters();
      await openConnected();
      expect(opensOf("orders-aurora")).toBe(1);
      cmdR();
      await waitFor(() => expect(opensOf("orders-aurora")).toBe(2));
      expect(pgApi.open).toHaveBeenLastCalledWith(target("orders-aurora"), LOGIN_USER);
      expect(targetsOf("orders-aurora")).toBe(2);
    });

    test("⌘R on 역할 sends no pg_findings, as the findings are only read while 점검 is showing", async () => {
      rememberBoth();
      await showClusters();
      await openConnected();
      cmdR();
      await waitFor(() => expect(opensOf("orders-aurora")).toBe(2));
      await act(async () => {});
      expect(pgApi.findings).not.toHaveBeenCalled();
    });

    test("⌘R with 점검 showing reads the findings again with force", async () => {
      rememberBoth();
      await showClusters();
      await openConnected();
      fireEvent.click(within(screen.getByRole("navigation", { name: "PostgreSQL 메뉴" })).getByText("점검").closest("button")!);
      await waitFor(() => expect(pgApi.findings).toHaveBeenCalledTimes(1));
      expect(pgApi.findings).toHaveBeenLastCalledWith(target("orders-aurora"), false);
      cmdR();
      await waitFor(() => expect(pgApi.findings).toHaveBeenCalledTimes(2));
      expect(pgApi.findings).toHaveBeenLastCalledWith(target("orders-aurora"), true);
    });

    test("the toolbar refresh button does the same", async () => {
      rememberBoth();
      await showClusters();
      await openConnected();
      fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
      await waitFor(() => expect(opensOf("orders-aurora")).toBe(2));
    });

    test("it is the tab that is showing that is read, not the other PostgreSQL tabs", async () => {
      rememberBoth();
      await showClusters();
      await openConnected("orders-aurora");
      fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
      fireEvent.doubleClick(screen.getByText("billing"));
      await screen.findByRole("tab", { name: "🐘 billing" });
      await waitFor(() => expect(opensOf("billing")).toBe(1));
      cmdR();
      await waitFor(() => expect(opensOf("billing")).toBe(2));
      await act(async () => {});
      expect(opensOf("orders-aurora")).toBe(1);
    });

    test("with the resources tab showing, no PostgreSQL tab is read again", async () => {
      rememberBoth();
      await showClusters();
      await openConnected();
      fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
      cmdR();
      await act(async () => {});
      await waitFor(() => expect(m.listResources.mock.calls.length).toBeGreaterThan(2)); // 리소스 목록은 다시 읽는다
      expect(opensOf("orders-aurora")).toBe(1);
      expect(targetsOf("orders-aurora")).toBe(1);
    });

    test("the rest of the refresh still happens when a PostgreSQL tab is showing", async () => {
      rememberBoth();
      await showClusters();
      await openConnected();
      const reads = m.listResources.mock.calls.length;
      cmdR();
      await waitFor(() => expect(m.listResources.mock.calls.length).toBeGreaterThan(reads));
    });

    test("a PostgreSQL tab that is not connected yet is read through the same refresh", async () => {
      // DB 사용자를 기억하지 않아 연결 전(로그인 창)이다. 새로 고침은 대상 확인부터 다시 읽을 뿐 연결을 시도하지 않는다.
      await showClusters();
      await openCluster("orders-aurora");
      await screen.findByRole("heading", { name: "DB 사용자" });
      cmdR();
      await waitFor(() => expect(targetsOf("orders-aurora")).toBe(2));
      expect(pgApi.open).not.toHaveBeenCalled();
    });
  });
});

describe("⚡ Valkey·Redis 탭", () => {
  const target = (id: string, kind: "replicationGroup" | "serverlessCache" | "cacheCluster" = "replicationGroup") => ({ profile: "prod", region: "ap-northeast-2", kind, id });
  const arnOf = (id: string) => `arn:aws:elasticache:ap-northeast-2:123456789012:replicationgroup:${id}`;
  const kvTabs = () => screen.queryAllByRole("tab", { name: /⚡/ });
  const closeButtonOf = (tab: HTMLElement) => within(tab.parentElement as HTMLElement).getByRole("button", { name: /닫기/ });
  const login = { mode: "none" as const, user: "", database: 0 };

  beforeEach(() => {
    // 탭은 진짜 KvTab을 그린다. 대상 확인 → 연결 → 키 읽기 순이다. 연결 방식은 기억해 두어 바로 연결한다.
    vi.mocked(kvApi.target).mockImplementation(async (t) => kvSampleTargetInfo({ identifier: t.id, arn: arnOf(t.id), users: null, userGroupIds: [] }));
    vi.mocked(kvApi.open).mockResolvedValue(kvSampleOverview());
    vi.mocked(kvApi.overview).mockResolvedValue(kvSampleOverview());
    vi.mocked(kvApi.scan).mockResolvedValue({ keys: kvSampleKeys, cursor: null, scanned: 10 });
    m.listServices.mockResolvedValue([...sampleServices, elasticacheService]);
    m.getSettings.mockResolvedValue({ enabledServices: ["ec2", "elasticache"], favorites: [], lastProfile: "prod", lastRegion: null, kvLogins: { [arnOf("sessions")]: login, [arnOf("cart")]: login } });
    m.listResources.mockImplementation(async (_p, _r, _service, typeId) => ({
      items:
        typeId === "replication-groups"
          ? [cacheRow("sessions", "valkey"), cacheRow("cart", "redis"), cacheRow("mc-group", "memcached")]
          : typeId === "cache-clusters"
            ? [cacheRow("sessions-001", "valkey", { group: "sessions" }), cacheRow("catalog-mc", "memcached", { group: "" })]
            : [cacheRow("feature-flags", "valkey")],
      truncated: false,
    }));
  });

  const showGroups = async () => {
    const view = renderWithClient(<App />);
    fireEvent.click(await screen.findByText("ElastiCache"));
    fireEvent.click(screen.getByText("Replication Groups"));
    await screen.findByText("sessions");
    return view;
  };
  const openGroup = async (name: string) => fireEvent.doubleClick(await screen.findByText(name));
  const connected = () => screen.findByRole("navigation", { name: "Valkey·Redis 메뉴" });

  test("double-clicking a Valkey replication group opens an active ⚡ tab titled with its identifier", async () => {
    await showGroups();
    await openGroup("sessions");
    const tab = await screen.findByRole("tab", { name: "⚡ sessions" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(kvTabs()).toHaveLength(1);
    await connected();
    expect(kvApi.open).toHaveBeenCalledWith(target("sessions"), { mode: "none", user: "", database: 0, password: null, rememberPassword: false });
  });

  test("a member of a replication group opens the tab of its group", async () => {
    renderWithClient(<App />);
    fireEvent.click(await screen.findByText("ElastiCache"));
    fireEvent.click(screen.getByText("Cache Clusters"));
    fireEvent.doubleClick(await screen.findByText("sessions-001"));
    expect(await screen.findByRole("tab", { name: "⚡ sessions" })).toHaveAttribute("aria-selected", "true");
  });

  test("a serverless cache opens its own tab", async () => {
    renderWithClient(<App />);
    fireEvent.click(await screen.findByText("ElastiCache"));
    fireEvent.click(screen.getByText("Serverless Caches"));
    fireEvent.doubleClick(await screen.findByText("feature-flags"));
    expect(await screen.findByRole("tab", { name: "⚡ feature-flags" })).toBeInTheDocument();
    expect(kvApi.target).toHaveBeenCalledWith(target("feature-flags", "serverlessCache"));
  });

  test("a Memcached cluster shows the notice and opens no tab", async () => {
    renderWithClient(<App />);
    fireEvent.click(await screen.findByText("ElastiCache"));
    fireEvent.click(screen.getByText("Cache Clusters"));
    fireEvent.doubleClick(await screen.findByText("catalog-mc"));
    const notice = await screen.findByText("Valkey·Redis OSS 캐시만 열 수 있어요");
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(kvTabs()).toHaveLength(0);
    expect(kvApi.target).not.toHaveBeenCalled();
  });

  test("opening the same target twice keeps one tab and activates it", async () => {
    await showGroups();
    await openGroup("sessions");
    await screen.findByRole("tab", { name: "⚡ sessions" });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    expect(screen.getByRole("tab", { name: "⚡ sessions" })).toHaveAttribute("aria-selected", "false");
    fireEvent.doubleClick(within(screen.getByRole("table")).getByText("sessions"));
    expect(kvTabs()).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "⚡ sessions" })).toHaveAttribute("aria-selected", "true");
    expect(kvApi.close).not.toHaveBeenCalled();
  });

  test("closing the tab closes the connection of that target only and returns to the resources tab", async () => {
    const { qc } = await showGroups();
    await openGroup("sessions");
    const first = await screen.findByRole("tab", { name: "⚡ sessions" });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.doubleClick(screen.getByText("cart"));
    await screen.findByRole("tab", { name: "⚡ cart" });
    qc.setQueryData(kvKeys.slowlog(target("sessions")), []);
    fireEvent.click(closeButtonOf(first));
    expect(kvApi.close).toHaveBeenCalledTimes(1);
    expect(kvApi.close).toHaveBeenCalledWith(target("sessions"));
    expect(qc.getQueryData(kvKeys.slowlog(target("sessions")))).toBeUndefined();
    expect(screen.getByRole("tab", { name: "⚡ cart" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(closeButtonOf(screen.getByRole("tab", { name: "⚡ cart" })));
    expect(kvApi.close).toHaveBeenLastCalledWith(target("cart"));
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
  });

  test("changing profile closes all ⚡ tabs and each connection, even from the resources tab", async () => {
    await showGroups();
    await openGroup("sessions");
    await screen.findByRole("tab", { name: "⚡ sessions" });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.doubleClick(screen.getByText("cart"));
    await screen.findByRole("tab", { name: "⚡ cart" });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.change(screen.getByRole("combobox", { name: "프로필" }), { target: { value: "dev" } });
    expect(kvTabs()).toHaveLength(0);
    expect(kvApi.close).toHaveBeenCalledTimes(2);
    expect(kvApi.close).toHaveBeenCalledWith(target("sessions"));
    expect(kvApi.close).toHaveBeenCalledWith(target("cart"));
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
  });

  test("changing the region keeps the tab", async () => {
    await showGroups();
    await openGroup("sessions");
    await screen.findByRole("tab", { name: "⚡ sessions" });
    fireEvent.change(screen.getByRole("combobox", { name: "리전" }), { target: { value: "us-east-1" } });
    expect(kvTabs()).toHaveLength(1);
    expect(kvApi.close).not.toHaveBeenCalled();
  });

  describe("refreshing (⌘R)", () => {
    const cmdR = () => fireEvent.keyDown(window, { key: "r", metaKey: true });
    const overviewsOf = (id: string) => vi.mocked(kvApi.overview).mock.calls.filter(([t]) => t.id === id).length;

    test("⌘R with a ⚡ tab showing reconnects that target and reads the keys again", async () => {
      await showGroups();
      await openGroup("sessions");
      await connected();
      await screen.findByRole("tree", { name: "키 목록" });
      cmdR();
      await waitFor(() => expect(overviewsOf("sessions")).toBe(1));
      await waitFor(() => expect(kvApi.scan).toHaveBeenCalledTimes(2));
    });

    test("it is the tab that is showing that is read, and with the resources tab showing no ⚡ tab is", async () => {
      await showGroups();
      await openGroup("sessions");
      await connected();
      fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
      fireEvent.doubleClick(screen.getByText("cart"));
      await screen.findByRole("tab", { name: "⚡ cart" });
      await waitFor(() => expect(vi.mocked(kvApi.open).mock.calls.filter(([t]) => t.id === "cart")).toHaveLength(1));
      cmdR();
      await waitFor(() => expect(overviewsOf("cart")).toBe(1));
      expect(overviewsOf("sessions")).toBe(0);
      fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
      cmdR();
      await act(async () => {});
      expect(overviewsOf("sessions")).toBe(0);
      expect(overviewsOf("cart")).toBe(1);
    });
  });

  test("the login that worked is remembered in the settings under the target's ARN", async () => {
    m.getSettings.mockResolvedValue({ enabledServices: ["ec2", "elasticache"], favorites: [], lastProfile: "prod", lastRegion: null });
    await showGroups();
    await openGroup("sessions");
    fireEvent.click(await screen.findByRole("button", { name: "연결" }));
    await waitFor(() => expect(m.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ kvLogins: { [arnOf("sessions")]: login } })));
  });
});

describe("EKS 탭", () => {
  const target = (cluster: string) => ({ profile: "prod", region: "ap-northeast-2", cluster });
  const k8sTabs = () => screen.queryAllByRole("tab", { name: /☸️/ });
  const closeButtonOf = (tab: HTMLElement) => within(tab.parentElement as HTMLElement).getByRole("button", { name: /닫기/ });

  beforeEach(() => {
    // 탭은 진짜 K8sTab을 그린다. 연결은 끝나지 않는 채로 둔다.
    vi.mocked(k8sApi.context).mockReturnValue(new Promise(() => {}));
    m.listServices.mockResolvedValue([...sampleServices, eksService]);
    m.getSettings.mockResolvedValue({ enabledServices: ["ec2", "eks"], favorites: [], lastProfile: "prod", lastRegion: null });
    m.listResources.mockImplementation(async (_p, _r, _service, typeId) => ({
      items:
        typeId === "clusters"
          ? [makeResource("prod", { name: "prod", version: "1.31", status: "ACTIVE" }), makeResource("staging", { name: "staging", version: "1.31", status: "ACTIVE" })]
          : [],
      truncated: false,
    }));
  });

  const showClusters = async () => {
    renderWithClient(<App />);
    fireEvent.click(await screen.findByText("EKS"));
    fireEvent.click(screen.getByText("Clusters"));
    await screen.findByText("staging");
  };
  const open = async (name: string) => fireEvent.doubleClick(await within(screen.getByRole("table")).findByText(name));

  test("opening the same cluster twice keeps one active tab titled ☸️ prod", async () => {
    await showClusters();
    await open("prod");
    const tab = await screen.findByRole("tab", { name: tabTitle("prod") });
    expect(tab).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    await open("prod");
    expect(k8sTabs()).toHaveLength(1);
    expect(screen.getByRole("tab", { name: tabTitle("prod") })).toHaveAttribute("aria-selected", "true");
  });

  test("closing the tab calls k8s close once and returns to the resources tab", async () => {
    await showClusters();
    await open("prod");
    const tab = await screen.findByRole("tab", { name: tabTitle("prod") });
    fireEvent.click(closeButtonOf(tab));
    expect(k8sTabs()).toHaveLength(0);
    expect(k8sApi.close).toHaveBeenCalledTimes(1);
    expect(k8sApi.close).toHaveBeenCalledWith(target("prod"), "prod");
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
  });

  test("changing profile closes every k8s tab and leaves the active one for the resources tab", async () => {
    await showClusters();
    await open("prod");
    await screen.findByRole("tab", { name: tabTitle("prod") });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    await open("staging");
    await screen.findByRole("tab", { name: tabTitle("staging") });

    fireEvent.change(screen.getByRole("combobox", { name: "프로필" }), { target: { value: "dev" } });
    expect(k8sTabs()).toHaveLength(0);
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
    expect(k8sApi.close).toHaveBeenCalledTimes(2);
    expect(k8sApi.close).toHaveBeenCalledWith(target("prod"), "prod");
    expect(k8sApi.close).toHaveBeenCalledWith(target("staging"), "prod");
  });

  /** 연결까지 끝나는 EKS 탭: context가 하나라 바로 열린다 */
  const connectable = () => {
    vi.mocked(k8sApi.context).mockResolvedValue({
      arn: "arn:aws:eks:ap-northeast-2:1:cluster/x", endpoint: "https://x", version: "1.30", endpointPublic: true, endpointPrivate: false, publicCidrs: [],
      kubeconfigMissing: false, kubeconfigPaths: [], candidates: [{ name: "ctx", cluster: "x", user: "u", namespace: null, execProfile: null }], chosen: null, savedMissing: null, updateCommand: "",
    });
    vi.mocked(k8sApi.open).mockResolvedValue({ context: "ctx", execProfile: null, serverVersion: "1.30", identity: { username: "a", groups: [], arn: null, source: "kubeconfig" } });
    vi.mocked(k8sApi.watch).mockResolvedValue(1);
  };

  test("⌘R on an active k8s tab refreshes that target only", async () => {
    connectable();
    await showClusters();
    await open("prod");
    await screen.findByRole("tab", { name: tabTitle("prod") });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    await open("staging");
    await screen.findByRole("tab", { name: tabTitle("staging") });
    vi.mocked(k8sApi.close).mockClear();
    fireEvent.keyDown(window, { key: "r", metaKey: true });
    await waitFor(() => expect(k8sApi.close).toHaveBeenCalledTimes(1));
    expect(k8sApi.close).toHaveBeenCalledWith(target("staging"), "prod");
    // 닫은 뒤 그 탭만 다시 연다
    await waitFor(() => expect(vi.mocked(k8sApi.open).mock.calls.filter(([t]) => t.cluster === "staging")).toHaveLength(2));
    expect(vi.mocked(k8sApi.open).mock.calls.filter(([t]) => t.cluster === "prod")).toHaveLength(1);
  });

  test("changing the kubeconfig path in the settings saves it and refreshes each open k8s tab", async () => {
    m.saveSettings.mockResolvedValue(undefined as never);
    connectable();
    await showClusters();
    await open("prod");
    await screen.findByRole("tab", { name: tabTitle("prod") });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    await open("staging");
    await screen.findByRole("tab", { name: tabTitle("staging") });
    vi.mocked(k8sApi.close).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "서비스 설정" }));
    const input = screen.getByLabelText("kubeconfig 경로");
    fireEvent.change(input, { target: { value: "/tmp/kube" } });
    fireEvent.blur(input);
    await waitFor(() => expect(m.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ kubeconfigPath: "/tmp/kube" })));
    await waitFor(() => expect(k8sApi.close).toHaveBeenCalledTimes(2));
    expect(k8sApi.close).toHaveBeenCalledWith(target("prod"), "prod");
    expect(k8sApi.close).toHaveBeenCalledWith(target("staging"), "prod");
  });
  describe("네트워크 화면에서 VPC 구조도 열기", () => {
    const tile = (id: string) => document.querySelector(`.vm-tile[data-id="${id}"]`);
    const openNetwork = async () => {
      connectable();
      vi.mocked(vpcApi.topology).mockResolvedValue(sampleTopology());
      // 구조도의 로드 밸런서 타일 ID(alb-1)와 EC2 타일 ID(i-1)를 쓴다
      vi.mocked(networkApi.network).mockResolvedValue(
        sampleNetwork({ highlight: ["i-1", "alb-1"], loadBalancers: [networkRow({ loadBalancer: loadBalancer({ arn: "alb-1" }) })] }),
      );
      await showClusters();
      await open("prod");
      fireEvent.click(await screen.findByRole("button", { name: "네트워크" }));
    };

    test("the cluster's VPC opens as a map tab with its nodes and load balancers highlighted", async () => {
      await openNetwork();
      fireEvent.click(await screen.findByRole("button", { name: "VPC 다이어그램 열기" }));
      expect(await screen.findByRole("tab", { name: /🗺 prod VPC/ })).toHaveAttribute("aria-selected", "true");
      expect(vpcApi.topology).toHaveBeenCalledWith("prod", "ap-northeast-2", "vpc-1");
      await screen.findByText("pub-a");
      expect(tile("i-1")).toHaveClass("highlighted");
      expect(tile("alb-1")).toHaveClass("highlighted");
      expect(tile("nat-1")).not.toHaveClass("highlighted");
      expect(screen.getByTestId("vpc-highlight")).toHaveTextContent("prod 강조 2개");
    });

    test("opening again from a load balancer replaces the highlight in the same tab", async () => {
      await openNetwork();
      fireEvent.click(await screen.findByRole("button", { name: "VPC 다이어그램 열기" }));
      await screen.findByText("pub-a");
      expect(tile("i-1")).toHaveClass("highlighted");
      fireEvent.click(screen.getByRole("tab", { name: tabTitle("prod") }));
      fireEvent.click((await screen.findByText("shop/web")).closest("tr")!);
      fireEvent.click(await screen.findByRole("button", { name: "VPC 다이어그램에서 보기" }));
      expect(screen.getAllByRole("tab", { name: /🗺/ })).toHaveLength(1);
      await waitFor(() => expect(tile("i-1")).not.toHaveClass("highlighted"));
      expect(tile("alb-1")).toHaveClass("highlighted");
    });
  });
});

describe("🐙 ArgoCD 탭", () => {
  const argocd = vi.mocked(argocdApi);
  beforeEach(() => {
    m.listServices.mockResolvedValue([...sampleServices, eksService]);
    m.getSettings.mockResolvedValue({ enabledServices: ["ec2", "eks"], favorites: [], lastProfile: "prod", lastRegion: null });
    argocd.session.mockResolvedValue(null);
    argocd.apps.mockResolvedValue([]);
    argocd.appsets.mockResolvedValue([]);
  });
  const open = async () => {
    renderWithClient(<App />);
    fireEvent.click(await screen.findByText("EKS"));
    fireEvent.click(await screen.findByText(ARGOCD_TITLE));
  };
  const argocdTabs = () => screen.queryAllByRole("tab", { name: new RegExp(ARGOCD_TITLE) });

  test("the entry under EKS opens an active closable tab that starts by asking for the server", async () => {
    await open();
    const tab = await screen.findByRole("tab", { name: ARGOCD_TITLE });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(SERVER_HELP)).toBeVisible();
    expect(within(tab.parentElement as HTMLElement).getByRole("button", { name: /닫기/ })).toBeInTheDocument();
    expect(argocd.session).not.toHaveBeenCalled();
  });

  test("opening it again reuses the single tab", async () => {
    await open();
    await screen.findByRole("tab", { name: ARGOCD_TITLE });
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    expect(screen.getByRole("tab", { name: ARGOCD_TITLE })).toHaveAttribute("aria-selected", "false");
    fireEvent.click(screen.getByText(ARGOCD_TITLE, { selector: ".typ span" }));
    expect(argocdTabs()).toHaveLength(1);
    expect(screen.getByRole("tab", { name: ARGOCD_TITLE })).toHaveAttribute("aria-selected", "true");
  });

  test("closing it returns to the resources tab", async () => {
    await open();
    const tab = await screen.findByRole("tab", { name: ARGOCD_TITLE });
    fireEvent.click(within(tab.parentElement as HTMLElement).getByRole("button", { name: /닫기/ }));
    expect(argocdTabs()).toHaveLength(0);
    expect(screen.getByRole("tab", { name: "리소스" })).toHaveAttribute("aria-selected", "true");
  });

  test("changing the AWS profile does not close it", async () => {
    await open();
    await screen.findByRole("tab", { name: ARGOCD_TITLE });
    fireEvent.change(screen.getByRole("combobox", { name: "프로필" }), { target: { value: "dev" } });
    expect(argocdTabs()).toHaveLength(1);
    expect(screen.getByRole("tab", { name: ARGOCD_TITLE })).toHaveAttribute("aria-selected", "true");
  });
});

describe("⌘K 리소스 찾기와 캐시 비우기", () => {
  const cached = (region: string, id: string, name: string) => ({ region, service: "ec2", typeId: "instances", fetchedAt: Date.now(), truncated: false, items: [{ id, name, arn: null, values: { name, id }, tags: {} }] });

  beforeEach(() => {
    m.resourceIndex.mockResolvedValue([cached("ap-northeast-2", "i-1", "web-1"), cached("us-west-2", "i-9", "web-west")]);
    m.clearResourceIndex.mockResolvedValue(undefined);
    m.listResources.mockImplementation(async (_p, region) =>
      region === "us-west-2"
        ? { items: [makeResource("i-8", { name: "api-west", id: "i-8" }), makeResource("i-9", { name: "web-west", id: "i-9" })], truncated: false }
        : { items: [makeResource("i-1", { name: "web-1", id: "i-1" })], truncated: false },
    );
  });

  const openPalette = async () => {
    renderWithClient(<App />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "프로필" })).toHaveValue("prod"));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    return screen.findByRole("searchbox", { name: "리소스 찾기" });
  };

  test("picking a cached resource from another region goes to that region and type and selects its row", async () => {
    const box = await openPalette();
    await screen.findByText(/읽어 둔 목록 2개/);
    fireEvent.change(box, { target: { value: "west" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "리소스 찾기" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "리전" })).toHaveValue("us-west-2");
    await waitFor(() => expect(within(screen.getByTestId("resource-table")).getByText("web-west").closest("tr")).toHaveAttribute("aria-selected", "true"));
    expect(m.listResources).toHaveBeenCalledWith("prod", "us-west-2", "ec2", "instances");
  });

  test("a picked resource that is gone after reading the list again is reported", async () => {
    m.resourceIndex.mockResolvedValue([cached("ap-northeast-2", "i-gone", "old-box")]);
    const box = await openPalette();
    await screen.findByText(/읽어 둔 목록 1개/);
    fireEvent.change(box, { target: { value: "old" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText(FOCUS_GONE)).toBeInTheDocument();
  });

  test("cmd+shift+R clears every resource cache, on disk too, and reads the visible list again", async () => {
    renderWithClient(<App />);
    fireEvent.click(await screen.findByText("EC2"));
    fireEvent.click(screen.getByText("Instances"));
    await screen.findByText("web-1");
    const before = m.listResources.mock.calls.length;
    fireEvent.keyDown(window, { key: "R", metaKey: true, shiftKey: true });
    await waitFor(() => expect(m.clearResourceIndex).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(m.listResources.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByText("web-1")).toBeInTheDocument();
  });

  test("the cache TTL is chosen in settings and saved", async () => {
    renderWithClient(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "서비스 설정" }));
    const ttl = screen.getByRole("combobox", { name: "리소스 캐시 TTL" });
    expect(ttl).toHaveValue("15");
    fireEvent.change(ttl, { target: { value: "0" } });
    await waitFor(() => expect(m.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ resourceCacheTtlMinutes: 0 })));
  });
});
