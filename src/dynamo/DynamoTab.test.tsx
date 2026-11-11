import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/client";
import { newQueryClient } from "../test/utils";
import { dynamoApi } from "./api";
import { DynamoTab } from "./DynamoTab";
import { finding, gsi, table } from "./fixtures";
import type { DynamoOverview, DynamoTable } from "./types";

vi.mock("./api", () => ({ dynamoApi: { overview: vi.fn(), table: vi.fn(), topKeys: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { resourceMetrics: vi.fn() } }));

const m = vi.mocked(dynamoApi);
const overview = (tables: DynamoTable[], extra: Partial<DynamoOverview> = {}): DynamoOverview => ({ tables, truncated: false, gaps: [], ...extra });

const orders = table("orders", {
  keys: { pk: { name: "pk", type: "S" }, sk: { name: "sk", type: "N" } },
  indexes: [gsi("by-user", { pk: { name: "user", type: "S" }, projection: { type: "INCLUDE", attrs: ["email"] }, itemCount: 12 })],
  findings: [finding("warn", "특정 시점 복구(PITR)가 꺼져 있어요")],
  scaling: null,
  ttl: { status: "ENABLED", attribute: "expiresAt" },
  stream: { arn: "arn:stream", viewType: "NEW_AND_OLD_IMAGES" },
});
const users = table("users");

function setup(props: { active?: boolean; focus?: { table: string; nonce: number } | null } = {}) {
  const qc = newQueryClient();
  const ui = (p: typeof props) => (
    <QueryClientProvider client={qc}>
      <DynamoTab profile="personal" region="ap-northeast-2" active={p.active ?? true} focus={p.focus ?? null} />
    </QueryClientProvider>
  );
  const view = render(ui(props));
  return { ...view, rerenderWith: (p: typeof props) => view.rerender(ui(p)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.overview.mockResolvedValue(overview([orders, users]));
  m.table.mockImplementation(async (_p, _r, name) => [orders, users].find((t) => t.name === name)!);
  vi.mocked(api.resourceMetrics).mockReturnValue(new Promise(() => {}));
});

const row = (name: string) => screen.getByRole("option", { name: new RegExp(name) });

describe("DynamoTab 목록", () => {
  it("테이블을 보이고, 문제 있는 테이블만 거를 수 있다", async () => {
    setup();
    await screen.findByRole("option", { name: /orders/ });
    expect(screen.getAllByRole("option")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /문제 있는 테이블만/ }));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByRole("option", { name: /users/ })).not.toBeInTheDocument();
  });

  it("테이블을 고르면 키·인덱스·설정·진단을 보인다", async () => {
    setup();
    fireEvent.click(await screen.findByRole("option", { name: /orders/ }));

    expect(await screen.findByText("pk (문자열)")).toBeInTheDocument();
    expect(screen.getByText("sk (숫자)")).toBeInTheDocument();
    expect(screen.getByText("by-user")).toBeInTheDocument();
    expect(screen.getByText("포함: email")).toBeInTheDocument();
    expect(screen.getByText("켜짐 · 속성 expiresAt")).toBeInTheDocument();
    expect(screen.getByText("특정 시점 복구(PITR)가 꺼져 있어요")).toBeInTheDocument();
    expect(row("orders")).toHaveAttribute("aria-selected", "true");
  });

  it("리소스 목록에서 연 테이블(focus)을 고르고, 다시 열면 그 테이블로 돌아온다", async () => {
    const { rerenderWith } = setup({ focus: { table: "users", nonce: 1 } });
    await screen.findByRole("option", { name: /users/ });
    expect(row("users")).toHaveAttribute("aria-selected", "true");

    fireEvent.click(row("orders"));
    expect(row("orders")).toHaveAttribute("aria-selected", "true");
    rerenderWith({ focus: { table: "users", nonce: 2 } });
    await waitFor(() => expect(row("users")).toHaveAttribute("aria-selected", "true"));
  });

  it("권한이 없어 읽지 못한 부분은 알리고 나머지는 그린다", async () => {
    m.overview.mockResolvedValue(overview([orders], { gaps: [{ section: "autoscaling", error: "권한 없음 (application-autoscaling:DescribeScalableTargets)" }] }));
    setup();
    expect(await screen.findByText(/오토스케일링: 권한 없음/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /orders/ })).toBeInTheDocument();
  });

  it("목록에 없는 테이블이 골라져 있으면 그렇게 알린다", async () => {
    setup({ focus: { table: "gone", nonce: 1 } });
    expect(await screen.findByText(/지금 목록에 없어요/)).toBeInTheDocument();
  });
});

describe("DynamoTab 다시 읽기", () => {
  it("활성 테이블은 따로 다시 읽지 않는다", async () => {
    setup({ focus: { table: "orders", nonce: 1 } });
    await screen.findByText("pk (문자열)");
    expect(m.table).not.toHaveBeenCalled();
  });

  it("바뀌는 중인 테이블은 따로 다시 읽고, 읽은 값이 화면에 반영된다", async () => {
    const creating = table("orders", { status: "CREATING" });
    m.overview.mockResolvedValue(overview([creating]));
    m.table.mockResolvedValue(table("orders", { status: "ACTIVE", findings: [finding("fail", "읽은 뒤 생긴 지적")] }));
    setup({ focus: { table: "orders", nonce: 1 } });
    expect(await screen.findByText("읽은 뒤 생긴 지적")).toBeInTheDocument();
    expect(m.table).toHaveBeenCalledWith("personal", "ap-northeast-2", "orders");
  });

  it("탭이 보이지 않으면 바뀌는 중인 테이블도 읽지 않는다", async () => {
    m.overview.mockResolvedValue(overview([table("orders", { status: "UPDATING" })]));
    setup({ active: false, focus: { table: "orders", nonce: 1 } });
    await screen.findByRole("option", { name: /orders/ });
    expect(m.table).not.toHaveBeenCalled();
  });
});

describe("DynamoTab Contributor Insights", () => {
  it("켜져 있을 때만 상위 키를 읽어 보인다", async () => {
    m.overview.mockResolvedValue(overview([table("orders", { contributorInsights: "ENABLED" }), users]));
    m.topKeys.mockResolvedValue({ windowSecs: 3600, groups: [{ kind: "accessed", withSortKey: false, entries: [{ keys: ["user#1"], count: 1234 }] }] });
    setup({ focus: { table: "orders", nonce: 1 } });
    expect(await screen.findByText("user#1")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(m.topKeys).toHaveBeenCalledWith("personal", "ap-northeast-2", "orders");

    fireEvent.click(row("users"));
    await screen.findByText("id (문자열)");
    expect(m.topKeys).toHaveBeenCalledTimes(1);
  });
});
