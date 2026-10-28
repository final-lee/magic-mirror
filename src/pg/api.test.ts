import { invoke } from "../api/invoke";
import { pgApi } from "./api";
import { addBobToWriters, grantAuditRead, ordersTable, pgTarget } from "./fixtures";

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
  // 2단계: 변경
  ["overview", "pg_overview", () => pgApi.overview(t), { target: t }],
  ["preview", "pg_preview", () => pgApi.preview(t, grantAuditRead), { target: t, change: grantAuditRead }],
  ["apply", "pg_apply", () => pgApi.apply(t, grantAuditRead, "app_read", "log-1"), { target: t, change: grantAuditRead, confirmText: "app_read", undoOf: "log-1" }],
  ["previewBatch", "pg_preview_batch", () => pgApi.previewBatch(t, "orders", [grantAuditRead, addBobToWriters]), { target: t, database: "orders", changes: [grantAuditRead, addBobToWriters] }],
  [
    "applyBatch",
    "pg_apply_batch",
    () => pgApi.applyBatch(t, "orders", [grantAuditRead, addBobToWriters], "변경 2개 적용", ["b-1-2", "b-1-1"]),
    { target: t, database: "orders", changes: [grantAuditRead, addBobToWriters], confirmText: "변경 2개 적용", undoOf: ["b-1-2", "b-1-1"] },
  ],
  ["preset", "pg_preset", () => pgApi.preset(t, "orders", "readOnly", ["app", "audit"]), { target: t, database: "orders", preset: "readOnly", schemas: ["app", "audit"] }],
  ["dropPlan", "pg_drop_plan", () => pgApi.dropPlan(t, "alice", "iam_admin"), { target: t, role: "alice", reassignTo: "iam_admin" }],
  ["applyDrop", "pg_apply_drop", () => pgApi.applyDrop(t, "alice", "iam_admin", "alice"), { target: t, role: "alice", reassignTo: "iam_admin", confirmText: "alice" }],
  ["undo", "pg_undo", () => pgApi.undo("log-1"), { logId: "log-1" }],
  ["undoBatch", "pg_undo_batch", () => pgApi.undoBatch("b-1"), { batchId: "b-1" }],
];

test.each(wire)("pgApi.%s calls %s with camelCase arguments and the target as one object", async (_name, command, call, args) => {
  m.mockResolvedValueOnce(null);
  await call();
  expect(m).toHaveBeenCalledTimes(1);
  expect(m).toHaveBeenCalledWith(command, args);
});

test("no confirm text and no undo go over the wire as null, not as missing arguments", async () => {
  m.mockResolvedValueOnce(null);
  await pgApi.apply(t, grantAuditRead, null, null);
  expect(m).toHaveBeenLastCalledWith("pg_apply", { target: t, change: grantAuditRead, confirmText: null, undoOf: null });
  m.mockResolvedValueOnce(null);
  await pgApi.applyBatch(t, "orders", [grantAuditRead], null, null);
  expect(m).toHaveBeenLastCalledWith("pg_apply_batch", { target: t, database: "orders", changes: [grantAuditRead], confirmText: null, undoOf: null });
});

test("the change log takes no arguments: it is one list for every target", async () => {
  m.mockResolvedValueOnce([]);
  await pgApi.changeLog();
  expect(m).toHaveBeenCalledTimes(1);
  expect(m).toHaveBeenCalledWith("pg_change_log");
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
  expect(Object.keys(pgApi).sort()).toEqual([...wire.map(([name]) => name), "changeLog"].sort());
});
