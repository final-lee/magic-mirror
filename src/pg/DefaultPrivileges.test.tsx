import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { DefaultPrivileges } from "./DefaultPrivileges";
import { pgTarget, sampleDatabaseView, sampleOverview } from "./fixtures";
import { pgKeys } from "./queries";
import { BUILTIN_NOTE } from "./sentences";
import type { PgDatabaseView, PgDefaultAclRow } from "./types";

vi.mock("./api", () => ({ pgApi: { database: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);

const overview = sampleOverview();

type Props = Partial<React.ComponentProps<typeof DefaultPrivileges>>;

/** 고른 데이터베이스는 PgTab이 경로에 기억한다. 여기서는 같은 일을 하는 작은 부모를 쓴다. */
function Harness({ database: initial, onDatabase, ...rest }: Props) {
  const [database, setDatabase] = useState(initial);
  return (
    <DefaultPrivileges
      target={pgTarget}
      overview={overview}
      database={database}
      onDatabase={(next) => {
        setDatabase(next);
        onDatabase?.(next);
      }}
      {...rest}
    />
  );
}

function setup(props: Props = {}) {
  const onDatabase = vi.fn();
  const utils = renderWithClient(<Harness onDatabase={onDatabase} {...props} />);
  return { onDatabase, ...utils };
}

const table = () => screen.getByRole("table", { name: "기본 권한" });
const picker = () => screen.getByRole("combobox", { name: "데이터베이스" });
const loaded = () => screen.findByRole("table", { name: "기본 권한" });
const rowOf = (name: string) => within(table()).getByRole("rowheader", { name }).closest("tr") as HTMLElement;
/** 행의 칸들: 테이블, 시퀀스, 함수, 타입, 스키마 */
const cellsOf = (name: string) => within(rowOf(name)).getAllByRole("cell");
const sentencesOf = (name: string) =>
  within(screen.getByRole("list", { name: `${name} 문장` }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

const aclRow = (creator: string, schema: string | null, objectType: PgDefaultAclRow["objectType"], ...grants: [string, string[]][]): PgDefaultAclRow => ({
  creator,
  schema,
  objectType,
  grants: grants.map(([grantee, privileges]) => ({ grantee, privileges, grantable: false })),
});
const withDefaults = (defaultPrivileges: PgDefaultAclRow[]): PgDatabaseView => sampleDatabaseView({ defaultPrivileges });

beforeEach(() => {
  vi.clearAllMocks();
  m.database.mockImplementation(async (_t, database) => sampleDatabaseView({ database }));
});

describe("loading", () => {
  test("reads the default database of the target, without force, and says so until it arrives", async () => {
    let resolve!: (v: PgDatabaseView) => void;
    m.database.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    expect(screen.getByText("불러오는 중…")).toBeInTheDocument();
    expect(m.database).toHaveBeenCalledTimes(1);
    expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", false);
    expect(picker()).toHaveValue("orders");
    await act(async () => resolve(sampleDatabaseView()));
    expect(await loaded()).toBeInTheDocument();
  });

  test("shows why it failed through the error box, and keeps the picker", async () => {
    m.database.mockRejectedValueOnce({ kind: "other", message: "먼저 연결해 주세요" });
    setup();
    expect(await screen.findByText("먼저 연결해 주세요")).toBeInTheDocument();
    expect(picker()).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(BUILTIN_NOTE)).not.toBeInTheDocument();
  });

  test("a read that fails after the table was shown keeps it on screen with the error above", async () => {
    const { qc } = setup();
    await loaded();
    m.database.mockRejectedValueOnce({ kind: "network", message: "끊겼어요" });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.database(pgTarget, "orders") });
    });
    expect(await screen.findByText("네트워크 오류: 끊겼어요")).toBeInTheDocument();
    expect(table()).toBeInTheDocument();
    expect(screen.getByText(BUILTIN_NOTE)).toBeInTheDocument();
  });
});

describe("the database", () => {
  test("is chosen from the databases that accept connections and starts at the default one", async () => {
    setup();
    await loaded();
    expect(within(picker()).getAllByRole("option").map((o) => o.textContent)).toEqual(["analytics", "orders", "postgres"]);
    expect(picker()).toHaveValue("orders");
  });

  test("a database remembered in the route is the one that is read", async () => {
    setup({ database: "analytics" });
    await loaded();
    expect(picker()).toHaveValue("analytics");
    expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false);
  });

  test("choosing another one tells the screen that remembers it, and shows the defaults of that database", async () => {
    m.database.mockImplementation(async (_t, database) =>
      database === "analytics" ? withDefaults([aclRow("etl", "staging", "tables", ["analyst", ["SELECT"]])]) : sampleDatabaseView({ database }),
    );
    const { onDatabase } = setup();
    await loaded();
    expect(screen.getByRole("rowheader", { name: "app_owner · app" })).toBeInTheDocument();
    fireEvent.change(picker(), { target: { value: "analytics" } });
    expect(onDatabase).toHaveBeenCalledWith("analytics");
    expect(await screen.findByRole("rowheader", { name: "etl · staging" })).toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: "app_owner · app" })).not.toBeInTheDocument();
  });

  test("a cluster with no database to connect to says so, and reads nothing", () => {
    setup({ overview: sampleOverview({ databases: [{ name: "legacy_archive", owner: "app_owner", allowConn: false }] }) });
    expect(screen.getByText("연결할 수 있는 데이터베이스가 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "데이터베이스" })).not.toBeInTheDocument();
    expect(m.database).not.toHaveBeenCalled();
  });
});

describe("the note about what PostgreSQL grants by default", () => {
  test("is the exact text, above the table", async () => {
    setup();
    await loaded();
    const note = screen.getByText("PostgreSQL 기본값: 함수는 모든 역할(PUBLIC)이 EXECUTE, 타입은 USAGE를 받아요. 위 표에서 바꾸지 않았다면 그대로예요");
    expect(note.compareDocumentPosition(table()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("is shown once, also when no default privilege was set", async () => {
    m.database.mockResolvedValue(withDefaults([]));
    setup();
    expect(await screen.findByText(BUILTIN_NOTE)).toBeInTheDocument();
    expect(screen.getAllByText(BUILTIN_NOTE)).toHaveLength(1);
  });
});

describe("the table", () => {
  test("has a row for each creator and schema, and a column for each kind of object", async () => {
    setup();
    await loaded();
    expect(within(table()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["만드는 역할 · 스키마", "테이블", "시퀀스", "함수", "타입", "스키마"]);
    expect(within(table()).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["app_owner · app", "app_owner · 모든 스키마", "postgres · 모든 스키마"]);
  });

  test("lists in each cell who gets which privileges", async () => {
    setup();
    await loaded();
    const [tables, sequences, functions, types, schemas] = cellsOf("app_owner · app");
    expect(within(tables).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["app_read SELECT", "app_write INSERT, UPDATE, DELETE"]);
    expect(within(sequences).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["app_write USAGE, SELECT"]);
    expect(within(functions).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["app_write EXECUTE"]);
    // 이 행에는 타입과 스키마의 기본 권한이 없다
    expect(within(types).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(schemas).queryAllByRole("listitem")).toHaveLength(0);
  });

  test("a default for every schema is its own row, and PUBLIC reads as 모든 역할(PUBLIC)", async () => {
    setup();
    await loaded();
    const [tables, sequences, functions, types, schemas] = cellsOf("app_owner · 모든 스키마");
    for (const empty of [tables, sequences, functions]) expect(within(empty).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(types).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["모든 역할(PUBLIC) USAGE"]);
    expect(within(schemas).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["app_read USAGE"]);
    expect(within(cellsOf("postgres · 모든 스키마")[0]).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["iam_admin SELECT"]);
  });

  test("puts the rows of one creator and schema together, even when the backend sends them apart", async () => {
    m.database.mockResolvedValue(
      withDefaults([
        aclRow("etl", "staging", "tables", ["analyst", ["SELECT"]]),
        aclRow("loader", null, "functions", ["PUBLIC", ["EXECUTE"]]),
        aclRow("etl", "staging", "sequences", ["analyst", ["USAGE"]]),
      ]),
    );
    setup();
    await loaded();
    expect(within(table()).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["etl · staging", "loader · 모든 스키마"]);
    expect(within(cellsOf("etl · staging")[0]).getByText("analyst")).toBeInTheDocument();
    expect(within(cellsOf("etl · staging")[1]).getByText("analyst")).toBeInTheDocument();
  });

  test("says so when no default privilege was set, and shows no table", async () => {
    m.database.mockResolvedValue(withDefaults([]));
    setup();
    expect(await screen.findByText("설정한 기본 권한이 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("the sentences", () => {
  test("under each row, one for each grantee and kind of object, in the order of the columns", async () => {
    setup();
    await loaded();
    expect(sentencesOf("app_owner · app")).toEqual([
      "app_owner 역할이 app에 새 테이블을 만들면 app_read 역할이 SELECT 권한을 받아요",
      "app_owner 역할이 app에 새 테이블을 만들면 app_write 역할이 INSERT, UPDATE, DELETE 권한을 받아요",
      "app_owner 역할이 app에 새 시퀀스를 만들면 app_write 역할이 USAGE, SELECT 권한을 받아요",
      "app_owner 역할이 app에 새 함수를 만들면 app_write 역할이 EXECUTE 권한을 받아요",
    ]);
  });

  test("a row for every schema says 모든 스키마, and PUBLIC is named 모든 역할(PUBLIC)", async () => {
    setup();
    await loaded();
    expect(sentencesOf("app_owner · 모든 스키마")).toEqual([
      "app_owner 역할이 모든 스키마에 새 타입을 만들면 모든 역할(PUBLIC) 역할이 USAGE 권한을 받아요",
      "app_owner 역할이 모든 스키마에 새 스키마를 만들면 app_read 역할이 USAGE 권한을 받아요",
    ]);
    expect(sentencesOf("postgres · 모든 스키마")).toEqual(["postgres 역할이 모든 스키마에 새 테이블을 만들면 iam_admin 역할이 SELECT 권한을 받아요"]);
  });

  test("follow the columns even when the backend sends the kinds in another order", async () => {
    m.database.mockResolvedValue(
      withDefaults([
        aclRow("etl", "staging", "schemas", ["a", ["USAGE"]]),
        aclRow("etl", "staging", "types", ["b", ["USAGE"]]),
        aclRow("etl", "staging", "functions", ["c", ["EXECUTE"]]),
        aclRow("etl", "staging", "sequences", ["d", ["SELECT"]]),
        aclRow("etl", "staging", "tables", ["e", ["SELECT"]]),
      ]),
    );
    setup();
    await loaded();
    expect(sentencesOf("etl · staging").map((s) => /새 (\S+) 만들면/.exec(s)?.[1])).toEqual(["테이블을", "시퀀스를", "함수를", "타입을", "스키마를"]);
  });

  test("are not changed by the grant option, which the sentence does not mention", async () => {
    setup();
    await loaded();
    // postgres의 iam_admin은 위임 가능으로 받는다(픽스처)
    expect(sentencesOf("postgres · 모든 스키마")[0]).not.toMatch(/GRANT|위임/);
  });
});
