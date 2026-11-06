import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import type { TsAuditLog, TsFlowLogs, TsLogStream, TsWebhook } from "./logTypes";
import * as l from "./logsText";
import { LogsView, clock, formatBytes } from "./LogsView";
import * as t from "./text";
import type { TsNode } from "./types";
import { useTailscaleApi } from "./useTailscaleApi";

vi.mock("./api", () => ({ tailscaleApi: { logsAudit: vi.fn(), logsFlows: vi.fn(), logsStream: vi.fn(), webhooks: vi.fn() } }));
vi.mock("./useTailscaleApi", () => ({ useTailscaleApi: vi.fn() }));

const a = vi.mocked(tailscaleApi);
const node = { cli: null } as TsNode;
const FORBIDDEN = { kind: "other", message: "이 자격 증명에 all:read 권한이 없어요" };

const audit: TsAuditLog = {
  start: "2026-10-29T12:00:00Z",
  end: "2026-11-05T12:00:00Z",
  total: 2,
  events: [
    {
      time: "2026-11-05T09:00:00Z",
      actor: { name: "alice@example.com", kind: "USER", property: null },
      action: "UPDATE",
      target: { name: "web-1.example.ts.net", kind: "NODE", property: "KEY_EXPIRY" },
      origin: "ADMIN_CONSOLE",
      error: null,
      details: null,
      old: "false",
      new: "true",
    },
    {
      time: "2026-11-04T10:00:00Z",
      actor: { name: "deploy bot", kind: "OAUTH_CLIENT", property: null },
      action: "DELETE",
      target: { name: "k1", kind: "API_KEY", property: null },
      origin: "CONFIG_API",
      error: "denied",
      details: "cleanup",
      old: null,
      new: null,
    },
  ],
};

const flowsOn: TsFlowLogs = {
  enabled: true,
  start: "s",
  end: "e",
  total: 1,
  flows: [{ nodeId: "nA", nodeName: "laptop", class: "tailnet", proto: "tcp", src: "100.64.0.1", srcName: "laptop", dst: "100.64.0.2:443", dstName: "router", txBytes: 1536, rxBytes: 5 * 1024 * 1024, txPkts: 3, rxPkts: 2 }],
};

const stream = (logType: TsLogStream["logType"], rest: Partial<TsLogStream> = {}): TsLogStream => ({
  logType, configured: false, destinationType: null, url: null, user: null, uploadPeriodMinutes: null, compression: null, status: null, ...rest,
});

const hooks: TsWebhook[] = [
  { id: "w1", endpoint: "https://hooks.slack.com/…", provider: "slack", creator: "a@example.com", created: "2026-01-01T00:00:00Z", modified: null, subscriptions: ["nodeCreated", "policyUpdate"] },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useTailscaleApi).mockReturnValue({ tailnet: "example.com", connected: true, isLoading: false });
  a.logsAudit.mockResolvedValue(audit);
  a.logsFlows.mockResolvedValue({ enabled: false, start: "s", end: "e", total: 0, flows: [] });
  a.logsStream.mockImplementation(async (_tailnet, logType) => stream(logType));
  a.webhooks.mockResolvedValue([]);
});

const section = (name: string) => within(screen.getByRole("region", { name }));

test("연결하지 않았으면 연결 탭으로 안내하고 아무것도 읽지 않아요", () => {
  vi.mocked(useTailscaleApi).mockReturnValue({ tailnet: null, connected: false, isLoading: false });
  renderWithClient(<LogsView node={node} />);
  expect(screen.getByText(t.API_REQUIRED)).toBeInTheDocument();
  expect(a.logsAudit).not.toHaveBeenCalled();
  expect(a.logsFlows).not.toHaveBeenCalled();
});

describe("설정 감사 로그", () => {
  test("기본은 최근 7일이고 누가·무엇을·어디에·어디서 했는지 보여요", async () => {
    renderWithClient(<LogsView node={node} />);
    const logs = section(l.AUDIT_TITLE);
    expect(await logs.findByText("alice@example.com")).toBeInTheDocument();
    expect(a.logsAudit).toHaveBeenCalledWith("example.com", 7);
    expect(logs.getByRole("button", { name: l.auditRange(7) })).toHaveAttribute("aria-pressed", "true");

    const rows = logs.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const update = within(rows[0]);
    expect(update.getByText(clock("2026-11-05T09:00:00Z"))).toBeInTheDocument();
    expect(update.getByText("바꾸기")).toBeInTheDocument();
    expect(update.getByText("web-1.example.ts.net")).toBeInTheDocument();
    expect(update.getByText("NODE · KEY_EXPIRY")).toBeInTheDocument();
    expect(update.getByText("ADMIN_CONSOLE")).toBeInTheDocument();
    expect(update.getByText("false")).toBeInTheDocument();
    expect(update.getByText("true")).toBeInTheDocument();
    const failed = within(rows[1]);
    expect(failed.getByText(`${l.FAILED}: denied`)).toBeInTheDocument();
    expect(failed.getByText("cleanup")).toBeInTheDocument();
  });

  test("기간을 1일·30일로 바꾸면 그 기간으로 다시 읽어요", async () => {
    renderWithClient(<LogsView node={node} />);
    const logs = section(l.AUDIT_TITLE);
    await logs.findByText("alice@example.com");
    fireEvent.click(logs.getByRole("button", { name: l.auditRange(30) }));
    await waitFor(() => expect(a.logsAudit).toHaveBeenCalledWith("example.com", 30));
    fireEvent.click(logs.getByRole("button", { name: l.auditRange(1) }));
    await waitFor(() => expect(a.logsAudit).toHaveBeenCalledWith("example.com", 1));
    expect(logs.getAllByRole("button", { pressed: true }).map((b) => b.textContent)).toEqual([l.auditRange(1)]);
  });

  test("검색어로 행위자·대상·경로를 좁혀요", async () => {
    renderWithClient(<LogsView node={node} />);
    const logs = section(l.AUDIT_TITLE);
    await logs.findByText("alice@example.com");
    fireEvent.change(screen.getByLabelText(l.AUDIT_FILTER), { target: { value: "deploy" } });
    expect(logs.queryByText("alice@example.com")).not.toBeInTheDocument();
    expect(logs.getByText("deploy bot")).toBeInTheDocument();
    expect(logs.getByText(l.auditCount(1, 2))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(l.AUDIT_FILTER), { target: { value: "zzzzz" } });
    expect(logs.getByText(l.AUDIT_NO_MATCH)).toBeInTheDocument();
  });

  test("기간 안에 기록이 없으면 그렇게 말해요", async () => {
    a.logsAudit.mockResolvedValue({ ...audit, events: [], total: 0 });
    renderWithClient(<LogsView node={node} />);
    expect(await section(l.AUDIT_TITLE).findByText(l.AUDIT_EMPTY)).toBeInTheDocument();
  });

  test("많아서 잘렸으면 전체 수를 알려요", async () => {
    a.logsAudit.mockResolvedValue({ ...audit, total: 1500 });
    renderWithClient(<LogsView node={node} />);
    expect(await section(l.AUDIT_TITLE).findByText(new RegExp(l.auditTruncated(2, 1500).replace(/[()]/g, "\\$&")))).toBeInTheDocument();
  });
});

describe("네트워크 흐름 로그", () => {
  test("꺼져 있으면 꺼져 있다고 설명하고 표는 없어요", async () => {
    renderWithClient(<LogsView node={node} />);
    const flows = section(l.FLOW_TITLE);
    expect(await flows.findByText(l.FLOW_OFF)).toBeInTheDocument();
    expect(flows.queryByRole("table")).not.toBeInTheDocument();
  });

  test("켜져 있으면 기기 이름과 전송량을 보여요", async () => {
    a.logsFlows.mockResolvedValue(flowsOn);
    renderWithClient(<LogsView node={node} />);
    const flows = section(l.FLOW_TITLE);
    const row = within((await flows.findAllByRole("row"))[1]);
    expect(a.logsFlows).toHaveBeenCalledWith("example.com");
    expect(row.getAllByText("laptop")).toHaveLength(2);
    expect(row.getByText("router")).toBeInTheDocument();
    expect(row.getByText("100.64.0.2:443")).toBeInTheDocument();
    expect(row.getByText(l.FLOW_CLASS.tailnet)).toBeInTheDocument();
    expect(row.getByText("1.5 KiB")).toBeInTheDocument();
    expect(row.getByText("5.0 MiB")).toBeInTheDocument();
  });

  test("묶은 행이 잘렸으면 전체 수를 알려요", async () => {
    a.logsFlows.mockResolvedValue({ ...flowsOn, total: 450 });
    renderWithClient(<LogsView node={node} />);
    expect(await section(l.FLOW_TITLE).findByText(l.flowTruncated(1, 450))).toBeInTheDocument();
  });
});

describe("로그 스트리밍", () => {
  test("설정과 전송 상태를 보여 주고 설정하지 않은 종류는 그렇게 말해요", async () => {
    a.logsStream.mockImplementation(async (_tailnet, logType) =>
      logType === "configuration"
        ? stream(logType, {
            configured: true,
            destinationType: "elastic",
            url: "https://logs.example.com/ingest",
            user: "me",
            uploadPeriodMinutes: 5,
            compression: "zstd",
            status: { lastActivity: "2026-11-05T11:59:00Z", lastError: "timeout", entriesSent: 8363, bytesSent: 17238983, requests: 10610, failedRequests: 5434 },
          })
        : stream(logType),
    );
    renderWithClient(<LogsView node={node} />);
    const config = within(await screen.findByRole("group", { name: l.STREAM_TYPES.configuration }));
    expect(await config.findByText("elastic")).toBeInTheDocument();
    expect(config.getByText("https://logs.example.com/ingest")).toBeInTheDocument();
    expect(config.getByText(l.streamPeriod(5))).toBeInTheDocument();
    expect(config.getByText(l.streamSent(8363, formatBytes(17238983)))).toBeInTheDocument();
    expect(config.getByText(l.streamRequests(10610, 5434))).toBeInTheDocument();
    expect(config.getByText("timeout")).toBeInTheDocument();
    expect(a.logsStream).toHaveBeenCalledWith("example.com", "configuration");
    expect(a.logsStream).toHaveBeenCalledWith("example.com", "network");
    const network = within(screen.getByRole("group", { name: l.STREAM_TYPES.network }));
    expect(await network.findByText(l.STREAM_NOT_CONFIGURED)).toBeInTheDocument();
  });
});

describe("웹훅", () => {
  test("받는 곳, 종류, 구독 이벤트를 보여요", async () => {
    a.webhooks.mockResolvedValue(hooks);
    renderWithClient(<LogsView node={node} />);
    const list = section(l.WEBHOOK_TITLE);
    expect(await list.findByText("https://hooks.slack.com/…")).toBeInTheDocument();
    for (const text of ["slack", "nodeCreated", "policyUpdate", "a@example.com", "2026-01-01"]) expect(list.getByText(text)).toBeInTheDocument();
  });

  test("없으면 없다고 말해요", async () => {
    renderWithClient(<LogsView node={node} />);
    expect(await section(l.WEBHOOK_TITLE).findByText(l.WEBHOOK_EMPTY)).toBeInTheDocument();
  });
});

test("한 구역의 권한 오류는 그 구역에만 보이고 나머지는 그대로예요", async () => {
  a.logsAudit.mockRejectedValue(FORBIDDEN);
  a.logsFlows.mockRejectedValue({ kind: "other", message: "이 자격 증명에 logs:network:read 권한이 없어요" });
  a.logsStream.mockImplementation(async (_tailnet, logType) => {
    if (logType === "network") throw FORBIDDEN;
    return stream(logType);
  });
  a.webhooks.mockResolvedValue(hooks);
  renderWithClient(<LogsView node={node} />);

  expect(await section(l.AUDIT_TITLE).findByRole("alert")).toHaveTextContent(FORBIDDEN.message);
  expect(await section(l.FLOW_TITLE).findByRole("alert")).toHaveTextContent("logs:network:read");
  expect(await within(screen.getByRole("group", { name: l.STREAM_TYPES.network })).findByRole("alert")).toHaveTextContent(FORBIDDEN.message);
  // 같은 구역의 다른 종류와 다른 구역은 멀쩡하다
  expect(await within(screen.getByRole("group", { name: l.STREAM_TYPES.configuration })).findByText(l.STREAM_NOT_CONFIGURED)).toBeInTheDocument();
  expect(await section(l.WEBHOOK_TITLE).findByText("https://hooks.slack.com/…")).toBeInTheDocument();
  // 오류가 난 구역에서도 기간은 바꿀 수 있다
  expect(section(l.AUDIT_TITLE).getByRole("button", { name: l.auditRange(30) })).toBeEnabled();
});

test("다시 읽기는 모든 구역을 다시 읽어요", async () => {
  renderWithClient(<LogsView node={node} />);
  await section(l.AUDIT_TITLE).findByText("alice@example.com");
  fireEvent.click(screen.getByRole("button", { name: l.REFRESH }));
  await waitFor(() => expect(a.logsAudit).toHaveBeenCalledTimes(2));
  expect(a.logsFlows).toHaveBeenCalledTimes(2);
  expect(a.webhooks).toHaveBeenCalledTimes(2);
});

test("전송량은 1024 단위로 줄여 써요", () => {
  expect([0, 1023, 1024, 1536, 10 * 1024, 5 * 1024 ** 2, 3 * 1024 ** 3].map(formatBytes)).toEqual(["0 B", "1023 B", "1.0 KiB", "1.5 KiB", "10 KiB", "5.0 MiB", "3.0 GiB"]);
});
