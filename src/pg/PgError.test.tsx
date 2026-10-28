import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { SsoLogin } from "../lib/useSsoLogin";
import { newQueryClient, renderWithClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { pgTarget } from "./fixtures";
import { PgError } from "./PgError";
import { refreshPg } from "./queries";

vi.mock("./queries", () => ({ refreshPg: vi.fn(async () => {}) }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn(async () => {}) } }));

beforeEach(() => {
  vi.clearAllMocks();
});

const network = { kind: "network", message: "엔드포인트에 연결하지 못했어요(db.example:5432). VPN이 켜져 있는지 확인하세요" };

test("shows the message of the failure, and 다시 시도 re-reads the whole target", () => {
  const { qc } = renderWithClient(<PgError error={network} target={pgTarget} />);
  expect(screen.getByText(`네트워크 오류: ${network.message}`)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(refreshPg).toHaveBeenCalledTimes(1);
  expect(refreshPg).toHaveBeenCalledWith(qc, pgTarget);
});

test("a permission failure has no retry, as for every other box", () => {
  renderWithClient(<PgError error={{ kind: "accessDenied", action: "rds:DescribeDBClusters" }} target={pgTarget} />);
  expect(screen.getByText("권한 없음 (rds:DescribeDBClusters)")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
});

test("asks for the login of the target's profile when the SSO session ran out", () => {
  renderWithClient(<PgError error={{ kind: "ssoExpired" }} target={{ ...pgTarget, profile: "prod" }} />);
  expect(screen.getByText("SSO 세션이 만료됐어요 (prod)")).toBeInTheDocument();
});

test("after a login through the app's login manager the whole target is read again, once, and not through 다시 시도", () => {
  const sso = ssoLoginStub();
  const box = (qc: QueryClient, value: SsoLogin) => withClientAndSso(<PgError error={{ kind: "ssoExpired" }} target={pgTarget} />, qc, value);
  const qc = newQueryClient();
  const view = render(box(qc, sso));
  expect(refreshPg).not.toHaveBeenCalled();
  const later = Date.now() + 1000;
  view.rerender(box(qc, { ...sso, lastSuccessAt: () => later }));
  expect(refreshPg).toHaveBeenCalledTimes(1);
  expect(refreshPg).toHaveBeenCalledWith(qc, pgTarget);
});

test("without a login manager the login button reads the target again when the login is done", async () => {
  renderWithClient(<PgError error={{ kind: "ssoExpired" }} target={pgTarget} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  });
  expect(refreshPg).toHaveBeenCalledTimes(1);
});

test("the compact look is the banner under a bar", () => {
  const { container } = renderWithClient(<PgError error={network} target={pgTarget} compact />);
  expect(container.querySelector(".error-banner")).not.toBeNull();
});

// 대상 전체를 다시 읽는 것이 맞지 않는 화면(변경 기록: 로컬 파일을 읽는다)은 자기 다시 시도를 넘긴다.
describe("a retry given by the screen", () => {
  test("다시 시도 does that instead of reading the whole target again", () => {
    const onRetry = vi.fn();
    renderWithClient(<PgError error={network} target={pgTarget} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(refreshPg).not.toHaveBeenCalled();
  });

  test("so does a login that finishes through the app's login manager, once", () => {
    const onRetry = vi.fn();
    const sso = ssoLoginStub();
    const qc = newQueryClient();
    const box = (value: SsoLogin) => withClientAndSso(<PgError error={{ kind: "ssoExpired" }} target={pgTarget} onRetry={onRetry} />, qc, value);
    const view = render(box(sso));
    expect(onRetry).not.toHaveBeenCalled();
    view.rerender(box({ ...sso, lastSuccessAt: () => Date.now() + 1000 }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(refreshPg).not.toHaveBeenCalled();
  });

  test("and so does the login button when there is no login manager", async () => {
    const onRetry = vi.fn();
    renderWithClient(<PgError error={{ kind: "ssoExpired" }} target={pgTarget} onRetry={onRetry} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(refreshPg).not.toHaveBeenCalled();
  });
});
