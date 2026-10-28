import { invoke } from "../api/invoke";
import { pgApi } from "./api";
import { ordersTable, pgTarget } from "./fixtures";

vi.mock("../api/invoke", () => ({ invoke: vi.fn() }));
const m = vi.mocked(invoke);

beforeEach(() => vi.clearAllMocks());

// 명령 이름과 인자 이름은 백엔드와 맞춘 계약이다. 어긋나면 화면을 열기 전에는 드러나지 않으므로 하나씩 못 박아 둔다.
const t = pgTarget;
const wire: [string, string, () => Promise<unknown>, Record<string, unknown>][] = [
  ["target", "pg_target", () => pgApi.target(t), { target: t }],
  ["open", "pg_open", () => pgApi.open(t, "iam_admin"), { target: t, loginUser: "iam_admin" }],
  ["database", "pg_database", () => pgApi.database(t, "orders", true), { target: t, database: "orders", force: true }],
  ["cell", "pg_cell", () => pgApi.cell(t, "orders", "alice", "app"), { target: t, database: "orders", role: "alice", schema: "app" }],
  ["objects", "pg_objects", () => pgApi.objects(t, "orders", "ord"), { target: t, database: "orders", query: "ord" }],
  ["role", "pg_role", () => pgApi.role(t, "alice"), { target: t, role: "alice" }],
  [
    "whoCan",
    "pg_who_can",
    () => pgApi.whoCan(t, "orders", ordersTable, "SELECT"),
    { target: t, database: "orders", object: ordersTable, privilege: "SELECT" },
  ],
  ["sessions", "pg_sessions", () => pgApi.sessions(t), { target: t }],
  ["findings", "pg_findings", () => pgApi.findings(t, false), { target: t, force: false }],
  ["close", "pg_close", () => pgApi.close(t), { target: t }],
];

test.each(wire)("pgApi.%s calls %s with camelCase arguments and the target as one object", async (_name, command, call, args) => {
  m.mockResolvedValueOnce(null);
  await call();
  expect(m).toHaveBeenCalledTimes(1);
  expect(m).toHaveBeenCalledWith(command, args);
});

test("each wrapper returns what the command returned", async () => {
  m.mockResolvedValueOnce(["a", "b"]);
  await expect(pgApi.objects(t, "orders", "")).resolves.toEqual(["a", "b"]);
});

test("a failed command rejects with the same error", async () => {
  m.mockRejectedValueOnce({ kind: "other", message: "먼저 연결해 주세요" });
  await expect(pgApi.sessions(t)).rejects.toEqual({ kind: "other", message: "먼저 연결해 주세요" });
});

test("there is one wrapper per command and no more", () => {
  expect(Object.keys(pgApi).sort()).toEqual(wire.map(([name]) => name).sort());
});
