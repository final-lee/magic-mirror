import { act, fireEvent, screen, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { Findings } from "./Findings";
import { object, ordersTable, pgTarget, sampleFindings, sampleOverview } from "./fixtures";
import { pgKeys } from "./queries";
import type { PgFinding, PgFindingGroup, PgFindings, PgOverview } from "./types";

vi.mock("./api", () => ({ pgApi: { findings: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);

const FOOTNOTE = "역할별 비밀번호 해시 방식과 마지막 로그인은 RDS에서 볼 수 없어 점검하지 않아요";

function setup(overview: PgOverview = sampleOverview()) {
  const onOpenRole = vi.fn();
  const onOpenSchema = vi.fn();
  const utils = renderWithClient(<Findings target={pgTarget} overview={overview} onOpenRole={onOpenRole} onOpenSchema={onOpenSchema} />);
  return { onOpenRole, onOpenSchema, ...utils };
}

/** 점검이 읽혀 그룹이 그려질 때까지 기다린다 */
const loaded = () => screen.findAllByRole("heading");
/** 그룹의 제목들을 위에서부터 */
const groupTitles = () => screen.getAllByRole("heading").map((h) => h.firstChild?.textContent?.trim());
const heading = (title: string) => screen.getByRole("heading", { name: (n) => n.startsWith(title) });
const table = (title: string) => screen.getByRole("table", { name: title }) as HTMLTableElement;
const rows = (title: string) => within(table(title)).getAllByRole("row").slice(1);
/** 항목 줄 가운데 detail이 text인 줄 */
const rowWith = (text: string) => screen.getByText(text).closest("tr") as HTMLElement;

const group = (kind: PgFindingGroup["kind"], level: PgFindingGroup["level"], title: string, items: PgFinding[]): PgFindingGroup => ({ kind, level, title, items });
const item = (extra: Partial<PgFinding> & Pick<PgFinding, "detail">): PgFinding => ({ database: null, role: null, object: null, ...extra });
const findingsOf = (groups: PgFindingGroup[], skipped: PgFindings["skipped"] = []): PgFindings => ({ groups, skipped, fetchedAt: "2026-10-28T12:01:00Z" });

beforeEach(() => {
  vi.clearAllMocks();
  m.findings.mockResolvedValue(sampleFindings());
});

describe("loading", () => {
  test("reads the findings without force, and says so until they arrive", async () => {
    let resolve!: (v: PgFindings) => void;
    m.findings.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    expect(screen.getByText("점검하는 중…")).toBeInTheDocument();
    expect(m.findings).toHaveBeenCalledWith(pgTarget, false);
    await act(async () => resolve(sampleFindings()));
    await loaded();
    expect(screen.queryByText("점검하는 중…")).not.toBeInTheDocument();
  });

  test("shows why it failed through the error box", async () => {
    m.findings.mockRejectedValue({ kind: "other", message: "질의가 30초 안에 끝나지 않았어요. 잠시 뒤 다시 읽어 주세요" });
    setup();
    expect(await screen.findByText("질의가 30초 안에 끝나지 않았어요. 잠시 뒤 다시 읽어 주세요")).toBeInTheDocument();
    expect(screen.queryByText(FOOTNOTE)).not.toBeInTheDocument();
  });

  test("a read that fails after the findings were shown keeps them on screen with the error above", async () => {
    const { qc } = setup();
    await loaded();
    m.findings.mockRejectedValue({ kind: "network", message: "데이터베이스 연결이 끊겼어요. 다시 읽으면 새로 연결해요" });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.findings(pgTarget) });
    });
    expect(await screen.findByText(/데이터베이스 연결이 끊겼어요/)).toBeInTheDocument();
    expect(table("rds_superuser 멤버")).toBeInTheDocument();
  });
});

describe("the groups", () => {
  test("come with their title, their level and how many items they have, the highest level first", async () => {
    setup();
    await loaded();
    expect(groupTitles()).toEqual(["rds_superuser 멤버", "search_path를 고정하지 않은 SECURITY DEFINER 함수", "CREATEROLE을 가진 역할", "만료됐거나 곧 만료되는 사용자", "점검하지 못한 데이터베이스"]);
    expect(heading("rds_superuser 멤버")).toHaveTextContent("rds_superuser 멤버 위험 2건");
    expect(heading("search_path를")).toHaveTextContent("위험 1건");
    expect(heading("CREATEROLE을")).toHaveTextContent("주의 1건");
    expect(heading("만료됐거나")).toHaveTextContent("참고 1건");
  });

  test("are in order of level whatever order they come in, and keep the order they came in within a level", async () => {
    m.findings.mockResolvedValue(
      findingsOf([
        group("expiringLogin", "low", "낮은 것 하나", [item({ detail: "l1" })]),
        group("createRole", "medium", "중간 하나", [item({ detail: "m1" })]),
        group("bypassRls", "medium", "중간 둘", [item({ detail: "m2" })]),
        group("rdsSuperuser", "high", "높은 것 하나", [item({ detail: "h1" })]),
        group("securityDefinerPath", "high", "높은 것 둘", [item({ detail: "h2" })]),
      ]),
    );
    setup();
    await loaded();
    expect(groupTitles()).toEqual(["높은 것 하나", "높은 것 둘", "중간 하나", "중간 둘", "낮은 것 하나"]);
  });

  test("show a different look for each level", async () => {
    setup();
    await loaded();
    expect(within(heading("rds_superuser 멤버")).getByText("위험")).toHaveClass("iam-badge", "danger");
    expect(within(heading("CREATEROLE을")).getByText("주의")).toHaveClass("iam-badge", "warn");
    expect(within(heading("만료됐거나")).getByText("참고")).toHaveClass("iam-badge", "info");
  });

  test("list their items with the target and what is wrong", async () => {
    setup();
    await loaded();
    expect(within(table("rds_superuser 멤버").tHead!).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["대상", "내용"]);
    expect(rows("rds_superuser 멤버")).toHaveLength(2);
    expect(within(rows("rds_superuser 멤버")[0]).getByText("iam_admin은 rds_superuser 멤버라 대부분의 관리 작업을 할 수 있어요")).toBeInTheDocument();
    expect(within(rows("만료됐거나 곧 만료되는 사용자")[0]).getByText("bob은 2026-11-05에 만료돼요")).toBeInTheDocument();
  });

  test("a cluster without findings says so, and still has the footnote", async () => {
    m.findings.mockResolvedValue(findingsOf([]));
    setup();
    expect(await screen.findByText("발견된 문제가 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(FOOTNOTE)).toBeInTheDocument();
  });
});

describe("an item that names a role", () => {
  test("opens the detail of that role", async () => {
    const { onOpenRole, onOpenSchema } = setup();
    await loaded();
    fireEvent.click(within(rowWith("iam_admin은 rds_superuser 멤버라 대부분의 관리 작업을 할 수 있어요")).getByRole("button", { name: "iam_admin" }));
    expect(onOpenRole).toHaveBeenCalledTimes(1);
    expect(onOpenRole).toHaveBeenCalledWith("iam_admin");
    expect(onOpenSchema).not.toHaveBeenCalled();
  });

  test("shows the name as plain text when the cluster has no such role any more", async () => {
    m.findings.mockResolvedValue(findingsOf([group("bypassRls", "medium", "BYPASSRLS", [item({ role: "ghost", detail: "ghost는 BYPASSRLS가 있어요" })])]));
    setup();
    await loaded();
    const row = rowWith("ghost는 BYPASSRLS가 있어요");
    expect(within(row).getByText("ghost")).toBeInTheDocument();
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("an item that names an object", () => {
  const withObject = (extra: Partial<PgFinding>, text = "객체 항목") => findingsOf([group("publicObjectGrant", "medium", "PUBLIC에 테이블·시퀀스 권한이 있어요", [item({ detail: text, ...extra })])]);

  test("opens the privileges of its database with its schema: a function is in the schema it is in", async () => {
    const { onOpenRole, onOpenSchema } = setup();
    await loaded();
    const row = rowWith("app.touch_order는 SECURITY DEFINER인데 search_path를 고정하지 않았어요");
    expect(within(row).getByText("orders")).toBeInTheDocument(); // 어느 데이터베이스인지
    fireEvent.click(within(row).getByRole("button", { name: "app.touch_order(order_id integer)" }));
    expect(onOpenSchema).toHaveBeenCalledTimes(1);
    expect(onOpenSchema).toHaveBeenCalledWith({ database: "orders", schema: "app", role: null });
    expect(onOpenRole).not.toHaveBeenCalled();
  });

  test("a table is in its schema, too", async () => {
    m.findings.mockResolvedValue(withObject({ database: "analytics", object: ordersTable }));
    const { onOpenSchema } = setup();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "app.orders" }));
    expect(onOpenSchema).toHaveBeenCalledWith({ database: "analytics", schema: "app", role: null });
  });

  test("a schema is the schema itself", async () => {
    m.findings.mockResolvedValue(withObject({ database: "orders", object: object("schema", null, "audit") }));
    const { onOpenSchema } = setup();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "audit" }));
    expect(onOpenSchema).toHaveBeenCalledWith({ database: "orders", schema: "audit", role: null });
  });

  test("a database has no schema: the privileges open on the database alone", async () => {
    m.findings.mockResolvedValue(withObject({ database: "orders", object: object("database", null, "orders") }));
    const { onOpenSchema } = setup();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "orders" }));
    expect(onOpenSchema).toHaveBeenCalledWith({ database: "orders", schema: null, role: null });
  });

  test("when it names a role too, both are there: the role opens its detail, and the object opens that role's cell", async () => {
    m.findings.mockResolvedValue(withObject({ database: "orders", role: "app_read", object: object("schema", null, "audit") }, "app_read는 audit의 새 테이블을 읽지 못해요"));
    const { onOpenRole, onOpenSchema } = setup();
    await loaded();
    const row = rowWith("app_read는 audit의 새 테이블을 읽지 못해요");
    fireEvent.click(within(row).getByRole("button", { name: "app_read" }));
    expect(onOpenRole).toHaveBeenCalledWith("app_read");
    fireEvent.click(within(row).getByRole("button", { name: "audit" }));
    expect(onOpenSchema).toHaveBeenCalledWith({ database: "orders", schema: "audit", role: "app_read" });
  });

  test("a role that is not there any more is not asked for", async () => {
    m.findings.mockResolvedValue(withObject({ database: "orders", role: "ghost", object: object("schema", null, "audit") }));
    const { onOpenSchema } = setup();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "audit" }));
    expect(onOpenSchema).toHaveBeenCalledWith({ database: "orders", schema: "audit", role: null });
  });

  test.each([
    ["no database", { database: null, object: ordersTable }],
    ["a database that does not take connections", { database: "legacy_archive", object: ordersTable }],
    ["a database the cluster does not have", { database: "dropped", object: ordersTable }],
  ])("is plain text with %s, as there is nowhere to open it", async (_name, extra) => {
    m.findings.mockResolvedValue(withObject(extra));
    setup();
    await loaded();
    const row = rowWith("객체 항목");
    expect(within(row).getByText("app.orders")).toBeInTheDocument();
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("an item that names no one", () => {
  test("shows the dash of the tab in the target, with what is wrong", async () => {
    m.findings.mockResolvedValue(findingsOf([group("md5Encryption", "medium", "password_encryption이 md5예요", [item({ detail: "비밀번호가 md5로 저장돼요" })])]));
    setup();
    await loaded();
    const row = rowWith("비밀번호가 md5로 저장돼요");
    expect(within(row).getAllByRole("cell")[0]).toHaveTextContent("—");
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
  });

  test("with a database alone, shows the database", async () => {
    m.findings.mockResolvedValue(findingsOf([group("md5Encryption", "medium", "그냥 제목", [item({ database: "orders", detail: "데이터베이스만 있는 항목" })])]));
    setup();
    await loaded();
    expect(within(rowWith("데이터베이스만 있는 항목")).getAllByRole("cell")[0]).toHaveTextContent("orders");
  });
});

describe("the databases that were skipped", () => {
  test("are listed with the reason each was left out", async () => {
    m.findings.mockResolvedValue(
      findingsOf([], [
        { database: "analytics", reason: 'analytics에 연결하지 못했어요: permission denied for database "analytics"' },
        { database: "reports", reason: "질의가 30초 안에 끝나지 않았어요. 잠시 뒤 다시 읽어 주세요" },
      ]),
    );
    setup();
    await screen.findByRole("heading", { name: /점검하지 못한 데이터베이스/ });
    expect(heading("점검하지 못한 데이터베이스")).toHaveTextContent("점검하지 못한 데이터베이스 2");
    const skipped = table("점검하지 못한 데이터베이스");
    expect(within(skipped.tHead!).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["데이터베이스", "이유"]);
    const [first, second] = within(skipped).getAllByRole("row").slice(1);
    expect(within(first).getAllByRole("cell").map((c) => c.textContent)).toEqual(["analytics", 'analytics에 연결하지 못했어요: permission denied for database "analytics"']);
    expect(within(second).getAllByRole("cell").map((c) => c.textContent)).toEqual(["reports", "질의가 30초 안에 끝나지 않았어요. 잠시 뒤 다시 읽어 주세요"]);
  });

  test("come after the groups of findings", async () => {
    setup();
    await loaded();
    const titles = groupTitles();
    expect(titles[titles.length - 1]).toBe("점검하지 못한 데이터베이스");
  });

  test("have no place when every database was read", async () => {
    m.findings.mockResolvedValue(sampleFindings({ skipped: [] }));
    setup();
    await loaded();
    expect(screen.queryByRole("heading", { name: /점검하지 못한 데이터베이스/ })).not.toBeInTheDocument();
  });
});

describe("the footnote", () => {
  test("says what the checks cannot see, with the text of the constraints, at the end", async () => {
    setup();
    await loaded();
    const note = screen.getByText(FOOTNOTE);
    expect(note).toBeInTheDocument();
    const last = table("점검하지 못한 데이터베이스");
    expect(last.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("is there once", async () => {
    setup();
    await loaded();
    expect(screen.getAllByText(FOOTNOTE)).toHaveLength(1);
  });
});

test("reads the findings once for the whole screen", async () => {
  setup();
  await loaded();
  expect(m.findings).toHaveBeenCalledTimes(1);
});
