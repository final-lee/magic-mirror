import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { newQueryClient, renderWithClient } from "../test/utils";
import { kvTarget, sampleTargetInfo } from "./fixtures";
import { KvError } from "./KvError";
import { KvLoginContext, type KvLoginApi } from "./loginContext";
import { refreshKv } from "./queries";

vi.mock("./queries", () => ({ refreshKv: vi.fn(async () => {}) }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn(async () => {}) } }));

beforeEach(() => {
  vi.clearAllMocks();
});

const login = (over: Partial<KvLoginApi> = {}): KvLoginApi => ({ info: sampleTargetInfo(), current: { mode: "user", user: "app-reader", database: 0 }, connect: vi.fn(), ...over });
const withLogin = (api: KvLoginApi, ui: React.ReactElement) => (
  <QueryClientProvider client={newQueryClient()}>
    <KvLoginContext.Provider value={api}>{ui}</KvLoginContext.Provider>
  </QueryClientProvider>
);

test("a refused login shows the login prompt with the reason, and the new login goes to the tab", async () => {
  const api = login();
  const user = userEvent.setup();
  render(withLogin(api, <KvError error={{ kind: "loginRequired", message: "IAM 인증에 실패했어요. elasticache:Connect 권한과 사용자 app-iam을 확인하세요" }} target={kvTarget} />));
  expect(screen.getByRole("alert")).toHaveTextContent("IAM 인증에 실패했어요");
  expect(screen.getByRole("radio", { name: /^사용자/ })).toBeChecked();
  await user.type(screen.getByLabelText("비밀번호"), "pw");
  await user.click(screen.getByRole("button", { name: "연결" }));
  expect(api.connect).toHaveBeenCalledWith({ mode: "user", user: "app-reader", database: 0, password: "pw", rememberPassword: true });
});

test("without a tab to take the login it only shows the reason", () => {
  renderWithClient(<KvError error={{ kind: "loginRequired", message: "이 캐시는 로그인이 필요해요" }} target={kvTarget} />);
  expect(screen.getByText("이 캐시는 로그인이 필요해요")).toBeInTheDocument();
});

test("another failure shows its message, and 다시 시도 reads the whole target again", () => {
  const { qc } = renderWithClient(<KvError error={{ kind: "network", message: "엔드포인트에 연결하지 못했어요(db:6379). VPN이 켜져 있는지 확인하세요" }} target={kvTarget} />);
  expect(screen.getByText(/VPN이 켜져 있는지 확인하세요/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(refreshKv).toHaveBeenCalledWith(qc, kvTarget);
});

test("the screen can take over the retry", () => {
  const onRetry = vi.fn();
  renderWithClient(<KvError error={{ kind: "other", message: "x" }} target={kvTarget} onRetry={onRetry} />);
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(onRetry).toHaveBeenCalled();
  expect(refreshKv).not.toHaveBeenCalled();
});

test("an expired SSO session asks for the login of the target's profile", () => {
  renderWithClient(<KvError error={{ kind: "ssoExpired" }} target={{ ...kvTarget, profile: "prod" }} />);
  expect(screen.getByText("SSO 세션이 만료됐어요 (prod)")).toBeInTheDocument();
});
