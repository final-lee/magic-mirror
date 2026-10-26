import { fireEvent, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { api } from "./api/client";
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
