import { invoke } from "../api/invoke";
import { pgApi } from "./api";
import { ordersTable, pgTarget } from "./fixtures";

vi.mock("../api/invoke", () => ({ invoke: vi.fn() }));
const m = vi.mocked(invoke);

beforeEach(() => vi.clearAllMocks());

// 명령 이름과 인자 이름은 백엔드와 맞춘 계약이다. 어긋나면 화면을 열기 전에는 드러나지 않으므로 하나씩 못 박아 둔다.
const t = pgTarget;
const wire: [string, () => Promise<unknown>, string, Record<string, unknown>][] = [
  ["target", () => pgApi.target(t), "pg_target", { target: t }],
  ["open", () => pgApi.open(t, "iam_admin"), "pg_open", { target: t, loginUser: "iam_admin" }],
  ["database", () => pgApi.database(t, "orders", true), "pg_database", { target: t, database: "orders", force: true }],
  ["cell", () => pgApi.cell(t, "orders", "alice", "app"), "pg_cell", { target: t, database: "orders", role: "alice", schema: "app" }],
  ["objects", () => pgApi.objects(t, "orders", "ord"), "pg_objects", { target: t, database: "orders", query: "ord" }],
  ["role", () => pgApi.role(t, "alice"), "pg_role", { target: t, role: "alice" }],
  [
    "whoCan",
    () => pgApi.whoCan(t, "orders", ordersTable, "SELECT"),
    "pg_who_can",
    { target: t, database: "orders", object: ordersTable, privilege: "SELECT" },
  ],
  ["sessions", () => pgApi.sessions(t), "pg_sessions", { target: t }],
  ["findings", () => pgApi.findings(t, false), "pg_findings", { target: t, force: false }],
  ["close", () => pgApi.close(t), "pg_close", { target: t }],
];

test.each(wire)("%s calls %s with camelCase arguments and the target as one object", async (_name, call, command, args) => {
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
