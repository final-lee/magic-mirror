import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { pgApi } from "./api";
import {
  LOGIN_USER,
  alice,
  ordersTable,
  pgTarget,
  sampleCellDetail,
  sampleDatabaseView,
  sampleFindings,
  sampleOverview,
  sampleSessions,
  sampleTargetInfo,
  sampleWhoCan,
  touchOrderFn,
} from "./fixtures";
import {
  closePg,
  pgKeys,
  refreshPg,
  refreshPgData,
  usePgCell,
  usePgDatabase,
  usePgFindings,
  usePgObjects,
  usePgOverview,
  usePgRole,
  usePgSessions,
  usePgTarget,
  usePgWhoCan,
} from "./queries";
import type { PgObjectRef, PgRoleView, PgTarget } from "./types";

vi.mock("./api", () => ({
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
    close: vi.fn(),
  },
}));

const m = vi.mocked(pgApi);
const t = pgTarget;
const roleView: PgRoleView = { summary: alice, settings: [], members: [], databases: [], sessions: [], setRoleOnly: [] };

function makeClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.target.mockResolvedValue(sampleTargetInfo());
  m.open.mockResolvedValue(sampleOverview());
  m.database.mockResolvedValue(sampleDatabaseView());
  m.cell.mockResolvedValue(sampleCellDetail());
  m.objects.mockResolvedValue([ordersTable]);
  m.role.mockResolvedValue(roleView);
  m.whoCan.mockResolvedValue(sampleWhoCan());
  m.sessions.mockResolvedValue(sampleSessions());
  m.findings.mockResolvedValue(sampleFindings());
  m.close.mockResolvedValue(null);
});

describe("query keys", () => {
  test("every key starts with the target's key, so one prefix reaches all of a target's queries", () => {
    const keys = [
      pgKeys.target(t),
      pgKeys.overview(t, LOGIN_USER),
      pgKeys.database(t, "orders"),
      pgKeys.cell(t, "orders", "alice", "app"),
      pgKeys.objects(t, "orders", "ord"),
      pgKeys.role(t, "alice"),
      pgKeys.whoCan(t, "orders", ordersTable, "SELECT"),
      pgKeys.sessions(t),
      pgKeys.findings(t),
    ];
    for (const key of keys) expect(key.slice(0, 2)).toEqual(["pg", "prod|ap-northeast-2|cluster|orders-aurora"]);
    expect(pgKeys.root(t)).toEqual(["pg", "prod|ap-northeast-2|cluster|orders-aurora"]);
  });

  test("follow the documented shapes", () => {
    const root = ["pg", "prod|ap-northeast-2|cluster|orders-aurora"];
    expect(pgKeys.target(t)).toEqual([...root, "target"]);
    expect(pgKeys.overview(t, "iam_admin")).toEqual([...root, "overview", "iam_admin"]);
    expect(pgKeys.database(t, "orders")).toEqual([...root, "database", "orders"]);
    expect(pgKeys.cell(t, "orders", "alice", "app")).toEqual([...root, "cell", "orders", "alice", "app"]);
    expect(pgKeys.objects(t, "orders", "ord")).toEqual([...root, "objects", "orders", "ord"]);
    expect(pgKeys.role(t, "alice")).toEqual([...root, "role", "alice"]);
    expect(pgKeys.whoCan(t, "orders", ordersTable, "SELECT")).toEqual([...root, "whoCan", "orders", ordersTable, "SELECT"]);
    expect(pgKeys.sessions(t)).toEqual([...root, "sessions"]);
    expect(pgKeys.findings(t)).toEqual([...root, "findings"]);
  });

  test("a cluster and an instance with the same identifier do not share keys", () => {
    const instance: PgTarget = { ...t, kind: "instance" };
    expect(pgKeys.root(instance)).not.toEqual(pgKeys.root(t));
    expect(pgKeys.sessions(instance)).not.toEqual(pgKeys.sessions(t));
  });
});

describe("hooks", () => {
  test("each hook calls its command with the target and caches under its key", async () => {
    const { qc, wrapper } = makeClient();
    const { result } = renderHook(
      () => ({
        target: usePgTarget(t),
        overview: usePgOverview(t, LOGIN_USER),
        database: usePgDatabase(t, "orders"),
        cell: usePgCell(t, "orders", "alice", "app"),
        objects: usePgObjects(t, "orders", "ord"),
        role: usePgRole(t, "alice"),
        whoCan: usePgWhoCan(t, "orders", ordersTable, "SELECT"),
        sessions: usePgSessions(t),
        findings: usePgFindings(t, true),
      }),
      { wrapper },
    );
    await waitFor(() => {
      for (const q of Object.values(result.current)) expect(q.isSuccess).toBe(true);
    });
    expect(m.target).toHaveBeenCalledWith(t);
    expect(m.open).toHaveBeenCalledWith(t, LOGIN_USER);
    expect(m.database).toHaveBeenCalledWith(t, "orders", false);
    expect(m.cell).toHaveBeenCalledWith(t, "orders", "alice", "app");
    expect(m.objects).toHaveBeenCalledWith(t, "orders", "ord");
    expect(m.role).toHaveBeenCalledWith(t, "alice");
    expect(m.whoCan).toHaveBeenCalledWith(t, "orders", ordersTable, "SELECT");
    expect(m.sessions).toHaveBeenCalledWith(t);
    expect(m.findings).toHaveBeenCalledWith(t, false);
    expect(qc.getQueryData(pgKeys.target(t))).toEqual(sampleTargetInfo());
    expect(qc.getQueryData(pgKeys.overview(t, LOGIN_USER))).toEqual(sampleOverview());
    expect(qc.getQueryData(pgKeys.database(t, "orders"))).toEqual(sampleDatabaseView());
    expect(qc.getQueryData(pgKeys.cell(t, "orders", "alice", "app"))).toEqual(sampleCellDetail());
    expect(qc.getQueryData(pgKeys.objects(t, "orders", "ord"))).toEqual([ordersTable]);
    expect(qc.getQueryData(pgKeys.role(t, "alice"))).toEqual(roleView);
    expect(qc.getQueryData(pgKeys.whoCan(t, "orders", ordersTable, "SELECT"))).toEqual(sampleWhoCan());
    expect(qc.getQueryData(pgKeys.sessions(t))).toEqual(sampleSessions());
    expect(qc.getQueryData(pgKeys.findings(t))).toEqual(sampleFindings());
  });

  test("the queries that need a choice stay idle until it is made", () => {
    const { wrapper } = makeClient();
    const { result } = renderHook(
      () => ({
        overview: usePgOverview(t, null),
        database: usePgDatabase(t, null),
        cell: usePgCell(t, null, "alice", "app"),
        cellRole: usePgCell(t, "orders", null, "app"),
        cellSchema: usePgCell(t, "orders", "alice", null),
        objects: usePgObjects(t, null, "ord"),
        role: usePgRole(t, null),
        whoCanObject: usePgWhoCan(t, "orders", null, "SELECT"),
        whoCanPrivilege: usePgWhoCan(t, "orders", ordersTable, null),
        whoCanDatabase: usePgWhoCan(t, null, ordersTable, "SELECT"),
        findings: usePgFindings(t, false),
      }),
      { wrapper },
    );
    for (const q of Object.values(result.current)) expect(q.fetchStatus).toBe("idle");
    for (const command of [m.open, m.database, m.cell, m.objects, m.role, m.whoCan, m.findings]) expect(command).not.toHaveBeenCalled();
  });

  test("the findings load once they are enabled", async () => {
    const { wrapper } = makeClient();
    const { result, rerender } = renderHook(({ on }) => usePgFindings(t, on), { wrapper, initialProps: { on: false } });
    expect(m.findings).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(m.findings).toHaveBeenCalledWith(t, false);
  });

  test("who-can and cell reads are keyed by what was asked, so each answer stays cached on its own", async () => {
    const { qc, wrapper } = makeClient();
    const sequence: PgObjectRef = { kind: "sequence", schema: "app", name: "orders_id_seq", signature: null };
    renderHook(
      () => ({
        a: usePgWhoCan(t, "orders", ordersTable, "SELECT"),
        b: usePgWhoCan(t, "orders", ordersTable, "UPDATE"),
        c: usePgWhoCan(t, "orders", sequence, "SELECT"),
        d: usePgWhoCan(t, "orders", touchOrderFn, "EXECUTE"),
      }),
      { wrapper },
    );
    await waitFor(() => expect(m.whoCan).toHaveBeenCalledTimes(4));
    expect(qc.getQueryCache().findAll({ queryKey: [...pgKeys.root(t), "whoCan"] })).toHaveLength(4);
  });

  describe("overview", () => {
    test("connects as the chosen login user, and a different user connects again without showing the previous overview", async () => {
      const { wrapper } = makeClient();
      const { result, rerender } = renderHook(({ user }) => usePgOverview(t, user), {
        wrapper,
        initialProps: { user: LOGIN_USER as string | null },
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.loginUser).toBe(LOGIN_USER);

      m.open.mockResolvedValueOnce(sampleOverview({ loginUser: "alice", canManage: false, manageReason: "바꿀 수 없어요" }));
      rerender({ user: "alice" });
      // 이전 사용자의 개요(canManage 등)를 새 사용자의 것처럼 보여 주지 않는다
      expect(result.current.data).toBeUndefined();
      await waitFor(() => expect(result.current.data?.loginUser).toBe("alice"));
      expect(m.open).toHaveBeenLastCalledWith(t, "alice");
      expect(m.open).toHaveBeenCalledTimes(2);
    });

    test("is dropped once nothing shows it, so opening again always connects again", async () => {
      const { qc, wrapper } = makeClient();
      const first = renderHook(() => usePgOverview(t, LOGIN_USER), { wrapper });
      await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
      first.unmount();
      await waitFor(() => expect(qc.getQueryData(pgKeys.overview(t, LOGIN_USER))).toBeUndefined());

      const second = renderHook(() => usePgOverview(t, LOGIN_USER), { wrapper });
      await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
      expect(m.open).toHaveBeenCalledTimes(2);
    });

    test("keeps its error so the screen can show why the connection failed", async () => {
      m.open.mockRejectedValue({ kind: "network", message: "엔드포인트에 연결하지 못했어요(db.example:5432). VPN이 켜져 있는지 확인하세요" });
      const { wrapper } = makeClient();
      const { result } = renderHook(() => usePgOverview(t, LOGIN_USER), { wrapper });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toEqual({ kind: "network", message: "엔드포인트에 연결하지 못했어요(db.example:5432). VPN이 켜져 있는지 확인하세요" });
      expect(m.open).toHaveBeenCalledTimes(1); // 다시 시도는 사용자가 누른다
    });
  });

  test("the object search keeps the previous list while a new one loads", async () => {
    const { wrapper } = makeClient();
    m.objects.mockImplementation(async (_t, _db, query) => (query === "" ? [ordersTable] : [touchOrderFn]));
    const { result, rerender } = renderHook(({ q }) => usePgObjects(t, "orders", q), { wrapper, initialProps: { q: "" } });
    await waitFor(() => expect(result.current.data?.[0].name).toBe("orders"));

    let release!: () => void;
    m.objects.mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      return [touchOrderFn];
    });
    rerender({ q: "touch" });
    expect(result.current.data?.[0].name).toBe("orders"); // 새 목록이 올 때까지 이전 목록
    expect(result.current.isPlaceholderData).toBe(true);
    release();
    await waitFor(() => expect(result.current.data?.[0].name).toBe("touch_order"));
  });

  test("the object search does not show another database's list while a new database loads", async () => {
    const { wrapper } = makeClient();
    m.objects.mockImplementation(async (_t, db) => (db === "orders" ? [ordersTable] : [touchOrderFn]));
    const { result, rerender } = renderHook(({ db }) => usePgObjects(t, db, "o"), { wrapper, initialProps: { db: "orders" } });
    await waitFor(() => expect(result.current.data?.[0].name).toBe("orders"));

    let release!: () => void;
    m.objects.mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      return [touchOrderFn];
    });
    rerender({ db: "analytics" });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
    release();
    await waitFor(() => expect(result.current.data?.[0].name).toBe("touch_order"));
  });

  test("the object search does not show another target's list while a new target loads", async () => {
    const { wrapper } = makeClient();
    const other: PgTarget = { ...t, id: "billing" };
    m.objects.mockImplementation(async (target) => (target.id === t.id ? [ordersTable] : [touchOrderFn]));
    const { result, rerender } = renderHook(({ target }) => usePgObjects(target, "orders", "o"), { wrapper, initialProps: { target: t } });
    await waitFor(() => expect(result.current.data?.[0].name).toBe("orders"));

    let release!: () => void;
    m.objects.mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      return [touchOrderFn];
    });
    rerender({ target: other }); // 같은 이름의 데이터베이스라도 다른 대상이다
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
    release();
    await waitFor(() => expect(result.current.data?.[0].name).toBe("touch_order"));
  });

  test("sessions are read again each time their screen opens", async () => {
    const { qc, wrapper } = makeClient();
    const first = renderHook(() => usePgSessions(t), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = renderHook(() => usePgSessions(t), { wrapper });
    expect(second.result.current.data).toEqual(sampleSessions()); // 다시 읽는 동안 이전 값을 보여 준다
    await waitFor(() => expect(m.sessions).toHaveBeenCalledTimes(2));
    expect(qc.getQueryData(pgKeys.sessions(t))).toEqual(sampleSessions());
  });

  test("everything else is read once and kept until a refresh", async () => {
    const { wrapper } = makeClient();
    const first = renderHook(() => ({ target: usePgTarget(t), database: usePgDatabase(t, "orders"), role: usePgRole(t, "alice") }), { wrapper });
    await waitFor(() => expect(first.result.current.role.isSuccess && first.result.current.database.isSuccess).toBe(true));
    first.unmount();
    const second = renderHook(() => ({ target: usePgTarget(t), database: usePgDatabase(t, "orders"), role: usePgRole(t, "alice") }), { wrapper });
    expect(second.result.current.database.data).toEqual(sampleDatabaseView());
    await act(async () => {});
    expect(m.target).toHaveBeenCalledTimes(1);
    expect(m.database).toHaveBeenCalledTimes(1);
    expect(m.role).toHaveBeenCalledTimes(1);
  });
});

describe("refreshPg", () => {
  async function mounted() {
    const { qc, wrapper } = makeClient();
    const hook = renderHook(
      () => ({
        target: usePgTarget(t),
        overview: usePgOverview(t, LOGIN_USER),
        database: usePgDatabase(t, "orders"),
        findings: usePgFindings(t, true),
        role: usePgRole(t, "alice"),
        cell: usePgCell(t, "orders", "alice", "app"),
        sessions: usePgSessions(t),
      }),
      { wrapper },
    );
    await waitFor(() => {
      for (const q of Object.values(hook.result.current)) expect(q.isSuccess).toBe(true);
    });
    vi.clearAllMocks();
    return { qc, wrapper, hook };
  }

  test("reads the overview, the database and the findings again with force: true, once each", async () => {
    const { qc } = await mounted();
    await refreshPg(qc, t);
    expect(m.open).toHaveBeenCalledTimes(1);
    expect(m.open).toHaveBeenCalledWith(t, LOGIN_USER);
    expect(m.database).toHaveBeenCalledTimes(1);
    expect(m.database).toHaveBeenCalledWith(t, "orders", true);
    expect(m.findings).toHaveBeenCalledTimes(1);
    expect(m.findings).toHaveBeenCalledWith(t, true);
  });

  test("invalidates every other query of the target too", async () => {
    const { qc } = await mounted();
    await refreshPg(qc, t);
    expect(m.target).toHaveBeenCalledTimes(1);
    expect(m.role).toHaveBeenCalledTimes(1);
    expect(m.cell).toHaveBeenCalledTimes(1);
    expect(m.sessions).toHaveBeenCalledTimes(1);
  });

  test("forces only once: a later plain invalidation reads normally again", async () => {
    const { qc } = await mounted();
    await refreshPg(qc, t);
    await qc.invalidateQueries({ queryKey: pgKeys.database(t, "orders") });
    expect(m.database).toHaveBeenLastCalledWith(t, "orders", false);
    await qc.invalidateQueries({ queryKey: pgKeys.findings(t) });
    expect(m.findings).toHaveBeenLastCalledWith(t, false);
  });

  test("rebuilds the snapshots in order: the overview first, then the database and findings, then the rest", async () => {
    const { qc } = await mounted();
    const order: string[] = [];
    let finishOverview!: () => void;
    m.target.mockImplementation(async () => {
      order.push("target");
      return sampleTargetInfo();
    });
    m.open.mockImplementation(async () => {
      order.push("open");
      await new Promise<void>((r) => (finishOverview = r));
      return sampleOverview();
    });
    m.database.mockImplementation(async (_t, _db, force) => {
      order.push(`database:${force}`);
      return sampleDatabaseView();
    });
    m.findings.mockImplementation(async (_t, force) => {
      order.push(`findings:${force}`);
      return sampleFindings();
    });
    m.role.mockImplementation(async () => {
      order.push("role");
      return roleView;
    });
    m.cell.mockImplementation(async () => {
      order.push("cell");
      return sampleCellDetail();
    });
    m.sessions.mockImplementation(async () => {
      order.push("sessions");
      return sampleSessions();
    });

    const done = refreshPg(qc, t);
    await waitFor(() => expect(order).toContain("open"));
    // 개요를 새로 읽는 동안에는 그 스냅숏을 읽는 쿼리를 시작하지 않는다
    expect(order).not.toContain("database:true");
    expect(order).not.toContain("findings:true");
    expect(order).not.toContain("role");
    finishOverview();
    await done;

    const at = (name: string) => order.indexOf(name);
    expect(at("open")).toBeLessThan(at("database:true"));
    expect(at("open")).toBeLessThan(at("findings:true"));
    for (const rest of ["role", "cell", "sessions"]) {
      expect(at("database:true")).toBeLessThan(at(rest));
      expect(at("findings:true")).toBeLessThan(at(rest));
    }
  });

  test("leaves other targets alone", async () => {
    const { qc, wrapper } = await mounted();
    const other: PgTarget = { ...t, id: "billing" };
    const otherSide = renderHook(() => ({ overview: usePgOverview(other, LOGIN_USER), database: usePgDatabase(other, "orders") }), { wrapper });
    await waitFor(() => expect(otherSide.result.current.database.isSuccess).toBe(true));
    vi.clearAllMocks();

    await refreshPg(qc, t);
    expect(m.open).toHaveBeenCalledTimes(1);
    expect(m.open).toHaveBeenCalledWith(t, LOGIN_USER);
    expect(m.database).toHaveBeenCalledTimes(1);
    expect(m.database).toHaveBeenCalledWith(t, "orders", true);
  });

  test("a database nobody is showing is not read now, but is read with force: true when it is shown again", async () => {
    const { qc, wrapper, hook } = await mounted();
    hook.unmount();
    vi.clearAllMocks();

    await refreshPg(qc, t);
    expect(m.database).not.toHaveBeenCalled();
    expect(m.findings).not.toHaveBeenCalled();

    const again = renderHook(() => ({ database: usePgDatabase(t, "orders"), findings: usePgFindings(t, true) }), { wrapper });
    await waitFor(() => expect(again.result.current.database.isFetching || again.result.current.database.isSuccess).toBe(true));
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(t, "orders", true));
    await waitFor(() => expect(m.findings).toHaveBeenCalledWith(t, true));
    expect(m.database).toHaveBeenCalledTimes(1);
  });

  test("a database the user never opened is not forced on its first read", async () => {
    const { qc, wrapper } = await mounted();
    await refreshPg(qc, t);
    vi.clearAllMocks();
    renderHook(() => usePgDatabase(t, "analytics"), { wrapper });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(t, "analytics", false));
  });

  test("a findings query that was never read is not marked: its first read after a refresh is not forced", async () => {
    const { qc, wrapper } = makeClient();
    const hook = renderHook(({ on }) => usePgFindings(t, on), { wrapper, initialProps: { on: false } });
    await refreshPg(qc, t);
    expect(m.findings).not.toHaveBeenCalled();
    hook.rerender({ on: true });
    await waitFor(() => expect(m.findings).toHaveBeenCalledWith(t, false));
    expect(m.findings).toHaveBeenCalledTimes(1);
  });

  test("a database whose first read failed has nothing to refresh: the next read is not forced", async () => {
    const { qc, wrapper } = makeClient();
    m.database.mockRejectedValueOnce({ kind: "other", message: "못 읽었어요" });
    const hook = renderHook(() => usePgDatabase(t, "analytics"), { wrapper });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    await refreshPg(qc, t);
    expect(m.database).toHaveBeenCalledTimes(2);
    expect(m.database).toHaveBeenLastCalledWith(t, "analytics", false);
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  });

  test("a snapshot that was read once is marked, even when its last read failed", async () => {
    const { qc, wrapper } = makeClient();
    const hook = renderHook(() => usePgDatabase(t, "orders"), { wrapper });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    m.database.mockRejectedValueOnce({ kind: "other", message: "끊겼어요" });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.database(t, "orders") });
    });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    await refreshPg(qc, t);
    expect(m.database).toHaveBeenLastCalledWith(t, "orders", true); // 읽어 둔 값이 있으니 낡은 것을 새로 읽는다
  });

  test("marks left over in one client do not reach another", async () => {
    const first = makeClient();
    const hook = renderHook(() => usePgDatabase(t, "orders"), { wrapper: first.wrapper });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    hook.unmount();
    await refreshPg(first.qc, t); // 구독자가 없어 표시만 남는다

    vi.clearAllMocks();
    const second = makeClient();
    renderHook(() => usePgDatabase(t, "orders"), { wrapper: second.wrapper });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(t, "orders", false));
  });

  test("does not try the rest when the connection could not be re-established, and forces them on the next try", async () => {
    const { qc } = await mounted();
    m.open.mockRejectedValueOnce({ kind: "network", message: "끊겼어요" });
    await refreshPg(qc, t);
    expect(m.target).toHaveBeenCalledTimes(1); // RDS API는 DB 연결과 상관없다
    for (const command of [m.database, m.findings, m.role, m.cell, m.sessions]) expect(command).not.toHaveBeenCalled();

    await refreshPg(qc, t);
    expect(m.database).toHaveBeenCalledWith(t, "orders", true);
    expect(m.findings).toHaveBeenCalledWith(t, true);
    expect(m.role).toHaveBeenCalledTimes(1);
  });
});

describe("refreshPgData", () => {
  // refreshPg와 같은 쿼리들을 켜 둔다
  async function mounted() {
    const { qc, wrapper } = makeClient();
    const hook = renderHook(
      () => ({
        target: usePgTarget(t),
        overview: usePgOverview(t, LOGIN_USER),
        database: usePgDatabase(t, "orders"),
        findings: usePgFindings(t, true),
        role: usePgRole(t, "alice"),
        cell: usePgCell(t, "orders", "alice", "app"),
        sessions: usePgSessions(t),
      }),
      { wrapper },
    );
    await waitFor(() => {
      for (const q of Object.values(hook.result.current)) expect(q.isSuccess).toBe(true);
    });
    vi.clearAllMocks();
    return { qc, wrapper, hook };
  }

  test("reads the database and the findings again with force: true and the rest again, but does not connect again", async () => {
    const { qc } = await mounted();
    await refreshPgData(qc, t);
    expect(m.open).not.toHaveBeenCalled();
    expect(m.target).not.toHaveBeenCalled();
    expect(m.database).toHaveBeenCalledTimes(1);
    expect(m.database).toHaveBeenCalledWith(t, "orders", true);
    expect(m.findings).toHaveBeenCalledTimes(1);
    expect(m.findings).toHaveBeenCalledWith(t, true);
    for (const command of [m.role, m.cell, m.sessions]) expect(command).toHaveBeenCalledTimes(1);
  });

  test("reads the snapshots before the rest, as refreshPg does", async () => {
    const { qc } = await mounted();
    const order: string[] = [];
    let finishDatabase!: () => void;
    m.database.mockImplementation(async (_t, _db, force) => {
      order.push(`database:${force}`);
      await new Promise<void>((r) => (finishDatabase = r));
      return sampleDatabaseView();
    });
    m.findings.mockImplementation(async (_t, force) => {
      order.push(`findings:${force}`);
      return sampleFindings();
    });
    m.role.mockImplementation(async () => {
      order.push("role");
      return roleView;
    });
    const done = refreshPgData(qc, t);
    await waitFor(() => expect(order).toContain("database:true"));
    expect(order).not.toContain("role");
    finishDatabase();
    await done;
    expect(order.indexOf("database:true")).toBeLessThan(order.indexOf("role"));
    expect(order.indexOf("findings:true")).toBeLessThan(order.indexOf("role"));
  });

  test("a database nobody is showing is read with force: true when it is shown again", async () => {
    const { qc, wrapper, hook } = await mounted();
    hook.unmount();
    vi.clearAllMocks();
    await refreshPgData(qc, t);
    expect(m.database).not.toHaveBeenCalled();
    renderHook(() => usePgDatabase(t, "orders"), { wrapper });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(t, "orders", true));
  });

  test("leaves other targets alone", async () => {
    const { qc, wrapper } = await mounted();
    const other: PgTarget = { ...t, id: "billing" };
    const otherSide = renderHook(() => usePgDatabase(other, "orders"), { wrapper });
    await waitFor(() => expect(otherSide.result.current.isSuccess).toBe(true));
    vi.clearAllMocks();
    await refreshPgData(qc, t);
    expect(m.database).toHaveBeenCalledTimes(1);
    expect(m.database).toHaveBeenCalledWith(t, "orders", true);
  });
});

describe("closePg", () => {
  test("closes the target on the backend and drops every cached query of that target, only", async () => {
    const { qc, wrapper } = makeClient();
    const other: PgTarget = { ...t, id: "billing" };
    const hook = renderHook(
      () => ({
        a: usePgDatabase(t, "orders"),
        b: usePgRole(t, "alice"),
        c: usePgDatabase(other, "orders"),
      }),
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.a.isSuccess && hook.result.current.b.isSuccess && hook.result.current.c.isSuccess).toBe(true));
    hook.unmount();

    await closePg(qc, t);
    expect(m.close).toHaveBeenCalledTimes(1);
    expect(m.close).toHaveBeenCalledWith(t);
    expect(qc.getQueryCache().findAll({ queryKey: pgKeys.root(t) })).toHaveLength(0);
    expect(qc.getQueryData(pgKeys.database(other, "orders"))).toEqual(sampleDatabaseView());
  });

  test("a view that was cached before closing is read from the backend again after reopening", async () => {
    const { qc, wrapper } = makeClient();
    const first = renderHook(() => usePgDatabase(t, "orders"), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();
    await closePg(qc, t);

    const second = renderHook(() => usePgDatabase(t, "orders"), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(m.database).toHaveBeenCalledTimes(2);
  });

  test("a backend failure is logged, not thrown, and the cache is cleared anyway", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { qc } = makeClient();
    qc.setQueryData(pgKeys.sessions(t), sampleSessions());
    m.close.mockRejectedValueOnce({ kind: "other", message: "boom" });
    await expect(closePg(qc, t)).resolves.toBeUndefined();
    expect(qc.getQueryData(pgKeys.sessions(t))).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.any(String), { kind: "other", message: "boom" });
    log.mockRestore();
  });
});
