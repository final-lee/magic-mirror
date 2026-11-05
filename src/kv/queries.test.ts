import { newQueryClient } from "../test/utils";
import { kvApi } from "./api";
import { kvTarget, sampleOverview, sampleTargetInfo } from "./fixtures";
import { closeKv, forgetKvData, kvKeys } from "./queries";

vi.mock("./api", () => ({ kvApi: { close: vi.fn(async () => null) } }));

const other = { ...kvTarget, id: "cart" };
const login = { login: { mode: "user" as const, user: "u", database: 0, password: null, rememberPassword: false }, attempt: 1 };

function seed() {
  const qc = newQueryClient();
  for (const t of [kvTarget, other]) {
    qc.setQueryData(kvKeys.target(t), sampleTargetInfo());
    qc.setQueryData(kvKeys.overview(t, login), sampleOverview());
    qc.setQueryData(kvKeys.slowlog(t), []);
    qc.setQueryData(kvKeys.scan(t, "*", null), { pages: [], pageParams: [] });
    qc.setQueryData(kvKeys.bullQueues(t, "bull"), { pages: [], pageParams: [] });
  }
  return qc;
}

beforeEach(() => vi.clearAllMocks());

test("every key of a target starts with kv and its target key, so one prefix reaches all of them", () => {
  expect(kvKeys.slowlog(kvTarget).slice(0, 2)).toEqual(kvKeys.root(kvTarget));
  expect(kvKeys.bullJob(kvTarget, "bull", "q", "1").slice(0, 2)).toEqual(kvKeys.root(kvTarget));
  expect(kvKeys.key(kvTarget, { text: "a", base64: null })[2]).toBe("key");
});

test("the password stays out of the overview key", () => {
  const withPassword = { login: { ...login.login, password: "secret" }, attempt: 1 };
  expect(JSON.stringify(kvKeys.overview(kvTarget, withPassword))).not.toContain("secret");
});

test("closing a tab closes the connection and drops every query of that target only", async () => {
  const qc = seed();
  await closeKv(qc, kvTarget);
  expect(kvApi.close).toHaveBeenCalledWith(kvTarget);
  expect(qc.getQueryCache().findAll({ queryKey: kvKeys.root(kvTarget) })).toHaveLength(0);
  expect(qc.getQueryCache().findAll({ queryKey: kvKeys.root(other) })).toHaveLength(5);
});

test("a close that fails still drops the queries", async () => {
  const qc = seed();
  vi.mocked(kvApi.close).mockRejectedValueOnce(new Error("gone"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await closeKv(qc, kvTarget);
  expect(qc.getQueryCache().findAll({ queryKey: kvKeys.root(kvTarget) })).toHaveLength(0);
  expect(log).toHaveBeenCalled();
  log.mockRestore();
});

test("a new login forgets what the old one read, but keeps the target and the connection", () => {
  const qc = seed();
  forgetKvData(qc, kvTarget);
  const left = qc.getQueryCache().findAll({ queryKey: kvKeys.root(kvTarget) }).map((q) => q.queryKey[2]);
  expect(left.sort()).toEqual(["overview", "target"]);
  expect(qc.getQueryCache().findAll({ queryKey: kvKeys.root(other) })).toHaveLength(5);
});
