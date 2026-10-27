import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import App from "./App";
import { api } from "./api/client";
import { reportSsoExpired } from "./api/invoke";
import { iamApi } from "./iam/api";
import { ACCOUNT, alice, aliceView, bob, sampleFindings, sampleOverview } from "./iam/fixtures";
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
vi.mock("./iam/api", () => ({
  iamApi: { overview: vi.fn(), principal: vi.fn(), principalActions: vi.fn(), policy: vi.fn(), accessKeys: vi.fn(), findings: vi.fn() },
}));
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

  test("the toolbar filter narrows the IAM list only while that tab is active", async () => {
    const list = await openIamUsers();
    expect(within(list).getByText("alice")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/필터/), { target: { value: "bob" } });
    expect(within(list).queryByText("alice")).not.toBeInTheDocument();
    expect(within(list).getByText("bob")).toBeInTheDocument();
    // 다른 탭으로 갔다 오면 필터가 지워진다(다른 탭과 같은 동작)
    fireEvent.click(screen.getByRole("tab", { name: "리소스" }));
    fireEvent.click(screen.getByRole("tab", { name: IAM_TAB }));
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
