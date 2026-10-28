import { fireEvent, render, screen, within } from "@testing-library/react";
import { addBobToWriters, defaultAuditRead, grantAuditRead, sampleBatchPreview, samplePreview } from "./fixtures";
import { PreviewBody } from "./PreviewBody";
import type { PgDefaultAclRow, PgImpact, PgPrivDelta, PgRoleDelta } from "./types";

const delta = (extra: Partial<PgPrivDelta> = {}): PgPrivDelta => ({
  database: "orders",
  schema: "audit",
  objectKind: "table",
  privilege: "SELECT",
  count: 1,
  sample: ["audit.events"],
  ...extra,
});
const impact = (role: string, extra: Partial<PgImpact> = {}): PgImpact => ({ role, gained: [], lost: [], ...extra });
const roleDelta = (role: string, extra: Partial<PgRoleDelta> = {}): PgRoleDelta => ({ role, created: false, dropped: false, attributes: [], groupsAdded: [], groupsRemoved: [], ...extra });
const defaultRow = (extra: Partial<PgDefaultAclRow> = {}): PgDefaultAclRow => ({
  creator: "app_owner",
  schema: "audit",
  objectType: "tables",
  grants: [{ grantee: "app_read", privileges: ["SELECT"], grantable: false }],
  ...extra,
});

/** 영향 말고는 아무것도 없는 미리보기 */
const bare = (extra: Parameters<typeof samplePreview>[0] = {}) => samplePreview({ sql: [], impacts: [], impactsOmitted: 0, roles: [], defaults: [], warnings: [], ...extra });
type BodyProps = React.ComponentProps<typeof PreviewBody>;
const show = (preview: BodyProps["preview"] = samplePreview(), props: Partial<BodyProps> = {}) => render(<PreviewBody preview={preview} {...props} />);
const effects = () => screen.getByRole("heading", { name: "영향" }).parentElement as HTMLElement;

describe("실행할 SQL", () => {
  test("lists the statements in run order, numbered, in monospace", () => {
    const sql = ['GRANT USAGE ON SCHEMA "audit" TO "app_read"', 'GRANT SELECT ON ALL TABLES IN SCHEMA "audit" TO "app_read"'];
    show(samplePreview({ sql }));
    expect(screen.getByRole("heading", { name: "실행할 SQL" })).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "실행할 SQL" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    rows.forEach((row, i) => {
      expect(within(row).getByText(String(i + 1))).toBeInTheDocument();
      const code = within(row).getByText(sql[i]);
      expect(code.tagName).toBe("CODE");
      expect(code).toHaveClass("mono");
    });
  });

  test("shows the password as the mask the backend sent, and quotes as they are", () => {
    const sql = [`CREATE ROLE "o'brien" LOGIN PASSWORD '••••••••'`];
    show(samplePreview({ sql }));
    expect(screen.getByText(sql[0])).toBeInTheDocument();
  });

  test("a preview with nothing to run has no empty list", () => {
    show(bare());
    expect(screen.queryByRole("heading", { name: "실행할 SQL" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "실행할 SQL" })).not.toBeInTheDocument();
  });
});

describe("영향: the roles", () => {
  test("a role's gained and lost privileges are lines of schema · kind count privilege, with the sample names after", () => {
    show(
      bare({
        impacts: [
          impact("alice", {
            gained: [delta({ count: 2, sample: ["audit.events", "audit.logs"] })],
            lost: [delta({ schema: "app", objectKind: "sequence", privilege: "USAGE", count: 1, sample: ["app.orders_id_seq"] })],
          }),
        ],
      }),
    );
    const item = screen.getByTestId("impact-alice");
    expect(within(item).getByText("alice")).toBeInTheDocument();
    const gained = within(item).getByRole("list", { name: "얻는 권한" });
    expect(gained).toHaveClass("cp-gain");
    expect(within(gained).getByText("audit · 테이블 2개 SELECT")).toBeInTheDocument();
    expect(within(gained).getByText("audit.events, audit.logs")).toHaveClass("mono");
    const lost = within(item).getByRole("list", { name: "잃는 권한" });
    expect(lost).toHaveClass("cp-lose");
    expect(within(lost).getByText("app · 시퀀스 1개 USAGE")).toBeInTheDocument();
    expect(within(lost).getByText("app.orders_id_seq")).toBeInTheDocument();
  });

  test("the captions are visible too, not only the list names", () => {
    show(bare({ impacts: [impact("alice", { gained: [delta()], lost: [delta({ privilege: "INSERT" })] })] }));
    const item = screen.getByTestId("impact-alice");
    expect(within(item).getByText("얻는 권한")).toBeVisible();
    expect(within(item).getByText("잃는 권한")).toBeVisible();
  });

  test("an object of the database itself, with no schema, is named by the database", () => {
    show(bare({ impacts: [impact("app_read", { gained: [delta({ schema: null, objectKind: "database", privilege: "CONNECT", sample: ["orders"] })] })] }));
    expect(screen.getByText("orders · 데이터베이스 1개 CONNECT")).toBeInTheDocument();
  });

  test("every kind of object has its own word", () => {
    const kinds = [
      ["schema", "스키마"],
      ["view", "뷰"],
      ["matview", "구체화 뷰"],
      ["partitioned", "파티션 테이블"],
      ["foreign", "외부 테이블"],
      ["function", "함수"],
    ] as const;
    show(bare({ impacts: [impact("alice", { gained: kinds.map(([objectKind]) => delta({ objectKind, count: 3, sample: [] })) })] }));
    for (const [, word] of kinds) expect(screen.getByText(`audit · ${word} 3개 SELECT`)).toBeInTheDocument();
  });

  test("a line with more objects than sample names says how many were left out", () => {
    show(bare({ impacts: [impact("alice", { gained: [delta({ count: 12, sample: ["a", "b", "c", "d", "e"] })] })] }));
    expect(screen.getByText("audit · 테이블 12개 SELECT")).toBeInTheDocument();
    expect(screen.getByText("a, b, c, d, e")).toBeInTheDocument();
    expect(screen.getByText("외 7개")).toBeInTheDocument();
  });

  test("a line whose samples are all of its objects does not claim more", () => {
    show(bare({ impacts: [impact("alice", { gained: [delta({ count: 1, sample: ["audit.events"] })] })] }));
    expect(screen.queryByText(/^외 \d+개$/)).not.toBeInTheDocument();
  });

  test("a role that only gains has no 잃는 권한 list, and the other way round", () => {
    show(bare({ impacts: [impact("alice", { gained: [delta()] }), impact("bob", { lost: [delta()] })] }));
    expect(within(screen.getByTestId("impact-alice")).queryByRole("list", { name: "잃는 권한" })).not.toBeInTheDocument();
    expect(within(screen.getByTestId("impact-bob")).queryByRole("list", { name: "얻는 권한" })).not.toBeInTheDocument();
  });

  test("the roles are listed in the order the backend sent", () => {
    show(bare({ impacts: [impact("alice", { gained: [delta()] }), impact("app_read", { gained: [delta()] }), impact("app_write", { gained: [delta()] })] }));
    const names = within(screen.getByRole("list", { name: "영향받는 역할" }))
      .getAllByTestId(/^impact-/)
      .map((li) => li.getAttribute("data-testid"));
    expect(names).toEqual(["impact-alice", "impact-app_read", "impact-app_write"]);
  });

  test("when roles were left out, the list ends with how many", () => {
    show(bare({ impacts: [impact("alice", { gained: [delta()] }), impact("bob", { gained: [delta()] })], impactsOmitted: 17 }));
    const list = screen.getByRole("list", { name: "영향받는 역할" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[rows.length - 1]).toHaveTextContent(/^그 밖에 17개 역할$/);
    expect(within(list).getAllByTestId(/^impact-/)).toHaveLength(2);
  });

  test("with every role listed there is no 그 밖에 line", () => {
    show(bare({ impacts: [impact("alice", { gained: [delta()] })], impactsOmitted: 0 }));
    expect(screen.queryByText(/그 밖에/)).not.toBeInTheDocument();
  });
});

describe("영향: the changes of roles", () => {
  test("a role that is created or dropped says so", () => {
    show(bare({ roles: [roleDelta("carol", { created: true }), roleDelta("app_audit", { dropped: true })] }));
    const list = screen.getByRole("list", { name: "역할 변화" });
    expect(within(within(list).getByTestId("role-carol")).getByText("새로 만들어요")).toBeInTheDocument();
    expect(within(within(list).getByTestId("role-app_audit")).getByText("삭제돼요")).toBeInTheDocument();
    expect(within(list).getAllByText("새로 만들어요")).toHaveLength(1);
    expect(within(list).getAllByText("삭제돼요")).toHaveLength(1);
  });

  test("an attribute reads name: before → after", () => {
    show(
      bare({
        roles: [
          roleDelta("alice", {
            attributes: [
              { name: "LOGIN", before: "없음", after: "있음" },
              { name: "연결 수 제한", before: "제한 없음", after: "5" },
            ],
          }),
        ],
      }),
    );
    const item = screen.getByTestId("role-alice");
    expect(within(item).getByText("alice")).toBeInTheDocument();
    expect(within(item).getByText("LOGIN: 없음 → 있음")).toBeInTheDocument();
    expect(within(item).getByText("연결 수 제한: 제한 없음 → 5")).toBeInTheDocument();
  });

  test("groups that come in and go out are listed by name", () => {
    show(bare({ roles: [roleDelta("alice", { groupsAdded: ["app_read", "app_write"], groupsRemoved: ["legacy"] })] }));
    const item = screen.getByTestId("role-alice");
    expect(within(item).getByText("들어가는 그룹: app_read, app_write")).toBeInTheDocument();
    expect(within(item).getByText("빠지는 그룹: legacy")).toBeInTheDocument();
  });

  test("a role with nothing to say about groups shows neither line", () => {
    show(bare({ roles: [roleDelta("alice", { attributes: [{ name: "LOGIN", before: "없음", after: "있음" }] })] }));
    expect(screen.queryByText(/들어가는 그룹/)).not.toBeInTheDocument();
    expect(screen.queryByText(/빠지는 그룹/)).not.toBeInTheDocument();
  });
});

describe("영향: the default privileges", () => {
  test("shows the record before and after as the sentences of the default privilege screen", () => {
    show(
      bare({
        defaults: [
          {
            before: defaultRow(),
            after: defaultRow({ grants: [{ grantee: "app_read", privileges: ["SELECT", "INSERT"], grantable: false }] }),
          },
        ],
      }),
    );
    const item = within(screen.getByRole("list", { name: "기본 권한 변화" }));
    expect(item.getByText("바뀌기 전")).toBeInTheDocument();
    expect(item.getByText("바뀐 뒤")).toBeInTheDocument();
    expect(item.getByText("app_owner 역할이 audit에 새 테이블을 만들면 app_read 역할이 SELECT 권한을 받아요")).toBeInTheDocument();
    expect(item.getByText("app_owner 역할이 audit에 새 테이블을 만들면 app_read 역할이 SELECT, INSERT 권한을 받아요")).toBeInTheDocument();
  });

  test("the sentences keep the particle, PUBLIC and grant option rules of the default privilege screen", () => {
    show(
      bare({
        defaults: [
          {
            before: null,
            after: defaultRow({
              schema: null,
              objectType: "sequences",
              grants: [
                { grantee: "PUBLIC", privileges: ["USAGE"], grantable: false },
                { grantee: "app_read", privileges: ["SELECT"], grantable: true },
              ],
            }),
          },
        ],
      }),
    );
    expect(screen.getByText("app_owner 역할이 모든 스키마에 새 시퀀스를 만들면 모든 역할(PUBLIC)이 USAGE 권한을 받아요")).toBeInTheDocument();
    expect(screen.getByText("app_owner 역할이 모든 스키마에 새 시퀀스를 만들면 app_read 역할이 SELECT (GRANT OPTION 포함) 권한을 받아요")).toBeInTheDocument();
  });

  test("a record with no grants left reads that nobody receives anything", () => {
    show(bare({ defaults: [{ before: defaultRow(), after: defaultRow({ grants: [] }) }] }));
    expect(screen.getByText("app_owner 역할이 audit에 새 테이블을 만들어도 아무 역할도 권한을 받지 않아요")).toBeInTheDocument();
  });

  test("a side with no record at all says so", () => {
    show(bare({ defaults: [{ before: null, after: defaultRow() }] }));
    const item = screen.getByRole("list", { name: "기본 권한 변화" });
    expect(within(item).getByText("설정 없음")).toBeInTheDocument();
    expect(within(item).getByText("app_owner 역할이 audit에 새 테이블을 만들면 app_read 역할이 SELECT 권한을 받아요")).toBeInTheDocument();
  });

  test("a record that disappears has nothing after it", () => {
    show(bare({ defaults: [{ before: defaultRow(), after: null }] }));
    const lists = within(screen.getByRole("list", { name: "기본 권한 변화" }));
    expect(lists.getByText("설정 없음")).toBeInTheDocument();
  });

  test("one entry per change, in the order sent", () => {
    show(bare({ defaults: [{ before: null, after: defaultRow() }, { before: null, after: defaultRow({ schema: "app" }) }] }));
    const rows = within(screen.getByRole("list", { name: "기본 권한 변화" })).getAllByTestId("default-delta");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("audit에");
    expect(rows[1]).toHaveTextContent("app에");
  });
});

describe("영향: nothing changes", () => {
  test("with no role impact, no role change and no default change it says so", () => {
    show(bare());
    expect(effects()).toHaveTextContent("권한 변화 없음");
    expect(screen.getByText("권한 변화 없음")).toBeInTheDocument();
  });

  test.each([
    ["a role impact", { impacts: [impact("alice", { gained: [delta()] })] }],
    ["a role change", { roles: [roleDelta("alice", { groupsAdded: ["app_read"] })] }],
    ["a default privilege change", { defaults: [{ before: null, after: defaultRow() }] }],
  ])("%s means there is a change to show", (_name, extra) => {
    show(bare(extra));
    expect(screen.queryByText("권한 변화 없음")).not.toBeInTheDocument();
  });
});

describe("warnings", () => {
  test("a warning with something to add shows 기본 권한도 담기 only when the caller can add it", () => {
    const { unmount } = show(samplePreview());
    expect(screen.queryByRole("button", { name: "기본 권한도 담기" })).not.toBeInTheDocument();
    expect(screen.getByText("새로 만드는 테이블에는 적용되지 않아요")).toBeInTheDocument();
    unmount();

    const onAddDefaults = vi.fn();
    show(samplePreview(), { onAddDefaults });
    fireEvent.click(screen.getByRole("button", { name: "기본 권한도 담기" }));
    expect(onAddDefaults).toHaveBeenCalledTimes(1);
    expect(onAddDefaults).toHaveBeenCalledWith([defaultAuditRead]);
  });

  test("the button sits in the warning it belongs to, and a warning with nothing to add has none", () => {
    const second = { ...defaultAuditRead, objectType: "sequences" as const };
    show(
      samplePreview({
        warnings: [
          { level: "warn", message: "새로 만드는 테이블에는 적용되지 않아요", add: [defaultAuditRead] },
          { level: "warn", message: "새로 만드는 시퀀스에는 적용되지 않아요", add: [second] },
          { level: "warn", message: "이미 그 상태라 달라지는 게 없어요", add: [] },
        ],
      }),
      { onAddDefaults: vi.fn() },
    );
    const items = within(screen.getAllByTestId("cp-warnings")[0]).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByRole("button", { name: "기본 권한도 담기" })).toBeInTheDocument();
    expect(within(items[1]).getByRole("button", { name: "기본 권한도 담기" })).toBeInTheDocument();
    expect(within(items[2]).queryByRole("button")).not.toBeInTheDocument();
  });

  test("each button adds what its own warning carries", () => {
    const second = { ...defaultAuditRead, objectType: "sequences" as const };
    const onAddDefaults = vi.fn();
    show(
      samplePreview({
        warnings: [
          { level: "warn", message: "새로 만드는 테이블에는 적용되지 않아요", add: [defaultAuditRead] },
          { level: "warn", message: "새로 만드는 시퀀스에는 적용되지 않아요", add: [second] },
        ],
      }),
      { onAddDefaults },
    );
    fireEvent.click(screen.getAllByRole("button", { name: "기본 권한도 담기" })[1]);
    expect(onAddDefaults).toHaveBeenCalledWith([second]);
  });

  test("blocks come first, then confirms, then warns, as in IAM", () => {
    show(
      samplePreview({
        warnings: [
          { level: "block", message: "막혔어요", add: [] },
          { level: "confirm", message: "확인하세요", add: [] },
          { level: "warn", message: "주의하세요", add: [] },
        ],
      }),
    );
    expect(screen.getAllByTestId("cp-warnings").map((g) => g.getAttribute("data-level"))).toEqual(["block", "confirm", "warn"]);
  });
});

describe("되돌릴 수 있는지", () => {
  test("says whether the change can be undone", () => {
    const { unmount } = show(samplePreview({ reversible: true }));
    expect(screen.getByText("되돌릴 수 있어요")).toBeInTheDocument();
    unmount();
    show(samplePreview({ reversible: false }));
    expect(screen.getByText("되돌릴 수 없어요")).toBeInTheDocument();
  });
});

describe("a batch", () => {
  test("lists the changes in run order, numbered, each with its own warnings", () => {
    const preview = sampleBatchPreview();
    show(preview, { items: preview.items });
    const rows = Array.from(screen.getByRole("list", { name: "변경 목록" }).children) as HTMLElement[]; // 경고도 목록 항목이라 한 줄 안에 또 있다
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/^1권한 주기: app_read · audit 스키마의 모든 테이블 SELECT/);
    expect(within(rows[0]).getByText("새로 만드는 테이블에는 적용되지 않아요")).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent(/^2그룹에 넣기: bob → app_write$/);
  });

  test("the add button of a change's warning works from inside the list", () => {
    const preview = sampleBatchPreview();
    const onAddDefaults = vi.fn();
    show(preview, { items: preview.items, onAddDefaults });
    const row = screen.getByRole("list", { name: "변경 목록" }).children[0] as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "기본 권한도 담기" }));
    expect(onAddDefaults).toHaveBeenCalledWith([defaultAuditRead]);
  });

  test("a body without items has no list of changes", () => {
    show(samplePreview());
    expect(screen.queryByRole("list", { name: "변경 목록" })).not.toBeInTheDocument();
  });
});

describe("order", () => {
  test("warnings, the changes of a batch, 실행할 SQL, 영향 and then whether it can be undone", () => {
    const preview = sampleBatchPreview({
      warnings: [{ level: "warn", message: "묶음 전체에 거는 주의", add: [] }],
    });
    show(preview, { items: [{ change: addBobToWriters, summary: "그룹에 넣기: bob → app_write", sql: [], warnings: [] }] });
    const marks = [
      screen.getByText("묶음 전체에 거는 주의"),
      screen.getByRole("list", { name: "변경 목록" }),
      screen.getByRole("heading", { name: "실행할 SQL" }),
      screen.getByRole("heading", { name: "영향" }),
      screen.getByText("되돌릴 수 있어요"),
    ];
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i - 1].compareDocumentPosition(marks[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    }
  });

  test("a single change's grant is the example of the whole body", () => {
    show(samplePreview({ change: grantAuditRead }));
    expect(screen.getByTestId("impact-alice")).toBeInTheDocument();
    expect(screen.getByTestId("impact-app_read")).toBeInTheDocument();
    expect(screen.getByTestId("impact-app_write")).toBeInTheDocument();
  });
});
