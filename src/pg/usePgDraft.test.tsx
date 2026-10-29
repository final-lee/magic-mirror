import { act, render, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import {
  addBobToWriters,
  createAppAudit,
  defaultAuditRead,
  grantAuditRead,
  pgTarget,
  removeBobFromWriters,
  revokeAuditRead,
  sampleOverview,
} from "./fixtures";
import { FULL_NOTICE, MAX_DRAFT, OTHER_DATABASE_NOTICE, draftItem, draftKey, type PgDraftItem } from "./draft";
import type { PgAttributesSet, PgChange, PgOverview, PgTarget } from "./types";
import { usePgDraft } from "./usePgDraft";

const ov = sampleOverview();
type Props = { target: PgTarget; ov: PgOverview | undefined };

function setup(props: Props = { target: pgTarget, ov }) {
  return renderHook((p: Props) => usePgDraft(p.target, p.ov), { initialProps: props });
}

const item = (change: PgChange): PgDraftItem => {
  const made = draftItem(change);
  if (!made) throw new Error(`not a tray change: ${change.kind}`);
  return made;
};
const labels = (items: PgDraftItem[]) => items.map((d) => d.label);

type Grant = Extract<PgChange, { kind: "grant" }>;
const usage = (grantee: string, database = "orders"): Grant => ({
  kind: "grant",
  database,
  grantee,
  add: true,
  items: [{ target: { kind: "schema", name: "app" }, privileges: ["USAGE"] }],
});
const attributes = (role: string, set: Partial<PgAttributesSet>): PgChange => ({
  kind: "attributes",
  role,
  set: { login: true, createDb: false, createRole: false, inherit: false, connectionLimit: -1, validUntil: "2026-11-05T12:00:00Z", ...set },
});
const crowd = (n: number) => Array.from({ length: n }, (_, i) => item(usage(`user_${String(i).padStart(2, "0")}`)));

test("starts with an empty tray, no notices, and no database", () => {
  const { result } = setup();
  expect(result.current.items).toEqual([]);
  expect(result.current.notices).toEqual([]);
  expect(result.current.database).toBeNull();
});

describe("queueing", () => {
  test("two toggles in one act compose: the second sees the first", () => {
    const { result } = setup();
    act(() => {
      result.current.toggle(item(grantAuditRead));
      result.current.toggle(item(addBobToWriters));
    });
    expect(labels(result.current.items)).toEqual(["권한 주기: app_read · audit 스키마의 모든 테이블 SELECT", "그룹에 넣기: bob → app_write"]);
  });

  test("a toggle and the same toggle again in one act cancel out, and so do a grant and its revoke", () => {
    const { result } = setup();
    act(() => {
      result.current.toggle(item(grantAuditRead));
      result.current.toggle(item(revokeAuditRead));
    });
    expect(result.current.items).toEqual([]);
  });

  test("an item keeps its key, change and label as the tray shows them", () => {
    const { result } = setup();
    act(() => result.current.toggle(item(grantAuditRead)));
    expect(result.current.items).toEqual([{ key: draftKey(grantAuditRead), change: grantAuditRead, label: "권한 주기: app_read · audit 스키마의 모든 테이블 SELECT" }]);
  });

  test("paint puts many items in, in order, and skips the ones that are there", () => {
    const { result } = setup();
    act(() => result.current.toggle(item(usage("b"))));
    act(() => result.current.paint([item(usage("a")), item(usage("b")), item(usage("c"))]));
    expect(result.current.items.map((d) => d.change)).toEqual([usage("b"), usage("a"), usage("c")]);
  });

  test("add puts the changes in the tray in order, skips the ones that are there, and tells how many it added", () => {
    const { result } = setup();
    act(() => result.current.toggle(item(grantAuditRead)));
    act(() => result.current.add([defaultAuditRead, { ...defaultAuditRead, grantee: "app_write" }]));
    expect(labels(result.current.items)).toEqual([
      "권한 주기: app_read · audit 스키마의 모든 테이블 SELECT",
      "기본 권한 주기: app_owner → app_read",
      "기본 권한 주기: app_owner → app_write",
    ]);
    expect(result.current.notices).toEqual(["기본 권한 2개를 담았어요"]);
    act(() => result.current.add([defaultAuditRead, { ...defaultAuditRead, grantee: "app_extra" }]));
    expect(result.current.items).toHaveLength(4);
    expect(result.current.notices).toEqual(["기본 권한 2개를 담았어요", "기본 권한 1개를 담았어요"]);
  });

  test("add says nothing when everything was in the tray already", () => {
    const { result } = setup();
    act(() => result.current.add([defaultAuditRead]));
    act(() => result.current.dismissNotice(0));
    act(() => result.current.add([defaultAuditRead]));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.notices).toEqual([]);
  });

  test("add leaves out what does not go in the tray (a role to create, a session to end)", () => {
    const { result } = setup();
    act(() => result.current.add([createAppAudit, defaultAuditRead]));
    expect(result.current.items.map((d) => d.change)).toEqual([defaultAuditRead]);
    expect(result.current.notices).toEqual(["기본 권한 1개를 담았어요"]);
  });

  test("remove takes out one item by key and clear takes out all of them", () => {
    const { result } = setup();
    act(() => result.current.paint([item(usage("a")), item(usage("b")), item(usage("c"))]));
    act(() => result.current.remove(result.current.items[1].key));
    expect(result.current.items.map((d) => d.change)).toEqual([usage("a"), usage("c")]);
    act(() => result.current.remove("grant|nobody"));
    expect(result.current.items).toHaveLength(2);
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
  });

  test("removeApplied takes out the items whose keys the applied changes have, and only those", () => {
    const { result } = setup();
    act(() => result.current.paint([item(grantAuditRead), item(addBobToWriters), item(usage("alice"))]));
    act(() => result.current.removeApplied([revokeAuditRead, removeBobFromWriters, createAppAudit]));
    expect(result.current.items.map((d) => d.change)).toEqual([usage("alice")]);
  });

  test("without an overview nothing is queued; once it arrives the tray works", () => {
    const { result, rerender } = setup({ target: pgTarget, ov: undefined });
    act(() => result.current.toggle(item(grantAuditRead)));
    act(() => result.current.add([defaultAuditRead]));
    expect(result.current.items).toEqual([]);
    expect(result.current.notices).toEqual([]);
    rerender({ target: pgTarget, ov });
    act(() => result.current.toggle(item(grantAuditRead)));
    expect(result.current.items).toHaveLength(1);
  });

  test("the functions keep their identity from one render to the next, so a grid that gets them is not drawn again for nothing", () => {
    const { result, rerender } = setup();
    const before = result.current;
    rerender({ target: pgTarget, ov });
    for (const name of ["toggle", "paint", "add", "remove", "clear", "removeApplied", "dismissNotice"] as const) {
      expect(result.current[name], name).toBe(before[name]);
    }
  });
});

describe("the database", () => {
  test("is the one of the grants and default privileges in the tray, and none for the cluster-wide changes", () => {
    const { result } = setup();
    act(() => result.current.toggle(item(addBobToWriters)));
    expect(result.current.database).toBeNull();
    act(() => result.current.toggle(item(grantAuditRead)));
    expect(result.current.database).toBe("orders");
    act(() => result.current.toggle(item(grantAuditRead)));
    expect(result.current.database).toBeNull();
  });

  test("an item for another database is refused with the notice, and the tray stays as it was", () => {
    const { result } = setup();
    act(() => result.current.toggle(item(grantAuditRead)));
    act(() => result.current.toggle(item(usage("alice", "analytics"))));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.notices).toEqual([OTHER_DATABASE_NOTICE]);
  });

  test("the notice does not stack, and says so again once the user has dismissed it", () => {
    const { result } = setup();
    act(() => result.current.toggle(item(grantAuditRead)));
    act(() => {
      result.current.toggle(item(usage("alice", "analytics")));
      result.current.paint([item(usage("bob", "analytics")), item(usage("carol", "analytics"))]);
    });
    expect(result.current.notices).toEqual([OTHER_DATABASE_NOTICE]);
    act(() => result.current.dismissNotice(0));
    act(() => result.current.toggle(item(usage("alice", "analytics"))));
    expect(result.current.notices).toEqual([OTHER_DATABASE_NOTICE]);
  });

  test("add refuses the default privileges of another database in the same way", () => {
    const { result } = setup();
    act(() => result.current.toggle(item(grantAuditRead)));
    act(() => result.current.add([{ ...defaultAuditRead, database: "analytics" }]));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.notices).toEqual([OTHER_DATABASE_NOTICE]);
  });
});

describe("the limit of 50", () => {
  test("the full notice appears once, however many cells did not fit", () => {
    const { result } = setup();
    const all = crowd(MAX_DRAFT + 2);
    act(() => result.current.paint(all));
    expect(result.current.items).toHaveLength(MAX_DRAFT);
    expect(result.current.items[0]).toBe(all[0]);
    expect(result.current.items.some((d) => d.key === all[MAX_DRAFT].key)).toBe(false);
    expect(result.current.notices).toEqual([FULL_NOTICE]);
  });

  test("a toggle that does not fit says so, a second one does not stack the same notice, and a dismissed one is said again", () => {
    const { result } = setup();
    const all = crowd(MAX_DRAFT + 1);
    act(() => result.current.paint(all.slice(0, MAX_DRAFT)));
    expect(result.current.notices).toEqual([]);
    act(() => result.current.toggle(all[MAX_DRAFT]));
    expect(result.current.items).toHaveLength(MAX_DRAFT);
    expect(result.current.notices).toEqual([FULL_NOTICE]);
    act(() => result.current.toggle(all[MAX_DRAFT]));
    expect(result.current.notices).toEqual([FULL_NOTICE]);
    act(() => result.current.dismissNotice(0));
    act(() => result.current.toggle(all[MAX_DRAFT]));
    expect(result.current.notices).toEqual([FULL_NOTICE]);
  });

  test("add puts in what fits and says both things", () => {
    const { result } = setup();
    act(() => result.current.paint(crowd(MAX_DRAFT - 1)));
    act(() => result.current.add([defaultAuditRead, { ...defaultAuditRead, grantee: "app_write" }]));
    expect(result.current.items).toHaveLength(MAX_DRAFT);
    expect(result.current.notices).toEqual(["기본 권한 1개를 담았어요", FULL_NOTICE]);
  });
});

describe("one change for a role or a pair", () => {
  test("a new attributes item replaces the old one, and one that equals the role as it is takes it out", () => {
    const { result } = setup();
    act(() => result.current.toggle(item(attributes("bob", { createDb: true }))));
    act(() => result.current.toggle(item(attributes("bob", { createRole: true }))));
    expect(result.current.items.map((d) => d.change)).toEqual([attributes("bob", { createRole: true })]);
    act(() => result.current.toggle(item(attributes("bob", {}))));
    expect(result.current.items).toEqual([]);
  });

  test("the role is compared with the overview as it is now", () => {
    const { result, rerender } = setup();
    // bob gets CREATEDB in another session; the overview is read again
    const later = sampleOverview({ roles: ov.roles.map((r) => (r.name === "bob" ? { ...r, attributes: { ...r.attributes, createDb: true } } : r)) });
    act(() => result.current.toggle(item(attributes("bob", { createDb: true }))));
    expect(result.current.items).toHaveLength(1);
    act(() => result.current.clear());
    rerender({ target: pgTarget, ov: later });
    act(() => result.current.toggle(item(attributes("bob", { createDb: true }))));
    expect(result.current.items).toEqual([]);
  });

  test("a membership of the other ADMIN OPTION value replaces the pending one", () => {
    const { result } = setup();
    act(() => result.current.toggle(item(addBobToWriters)));
    act(() => result.current.toggle(item({ ...addBobToWriters, admin: true })));
    expect(result.current.items.map((d) => d.change)).toEqual([{ ...addBobToWriters, admin: true }]);
  });
});

describe("notices", () => {
  test("dismissNotice removes the notice at that index only", () => {
    const { result } = setup();
    act(() => result.current.add([defaultAuditRead]));
    act(() => result.current.add([{ ...defaultAuditRead, grantee: "app_write" }]));
    expect(result.current.notices).toHaveLength(2);
    act(() => result.current.dismissNotice(0));
    expect(result.current.notices).toEqual(["기본 권한 1개를 담았어요"]);
    act(() => result.current.dismissNotice(5)); // no such notice
    act(() => result.current.dismissNotice(-1));
    expect(result.current.notices).toHaveLength(1);
  });

  test("clearing the tray leaves the notices to the user to dismiss", () => {
    const { result } = setup();
    act(() => result.current.add([defaultAuditRead]));
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
    expect(result.current.notices).toHaveLength(1);
  });
});

describe("the tray belongs to one target", () => {
  const other: PgTarget = { ...pgTarget, id: "billing" };

  test("rerendering with another target empties the tray and shows no notices", () => {
    const { result, rerender } = setup();
    act(() => result.current.add([defaultAuditRead]));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.notices).toHaveLength(1);
    rerender({ target: other, ov });
    expect(result.current.items).toEqual([]);
    expect(result.current.notices).toEqual([]);
    expect(result.current.database).toBeNull();
  });

  test("the old tray is never seen under the new target, not even for one render", () => {
    const seen: { id: string; items: number; notices: number }[] = [];
    const { result, rerender } = renderHook(
      (p: Props) => {
        const draft = usePgDraft(p.target, p.ov);
        seen.push({ id: p.target.id, items: draft.items.length, notices: draft.notices.length });
        return draft;
      },
      { initialProps: { target: pgTarget, ov } as Props },
    );
    act(() => result.current.add([defaultAuditRead]));
    seen.length = 0;
    rerender({ target: other, ov });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.id === "billing" && r.items === 0 && r.notices === 0)).toBe(true);
  });

  test("the new target's tray works as usual, and going back does not bring the old one back", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle(item(grantAuditRead)));
    rerender({ target: other, ov });
    act(() => result.current.toggle(item(addBobToWriters)));
    expect(labels(result.current.items)).toEqual(["그룹에 넣기: bob → app_write"]);
    rerender({ target: pgTarget, ov });
    expect(result.current.items).toEqual([]);
  });

  test("a switch while the new overview is still loading also starts empty", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle(item(grantAuditRead)));
    rerender({ target: other, ov: undefined });
    expect(result.current.items).toEqual([]);
    rerender({ target: other, ov });
    expect(result.current.items).toEqual([]);
  });

  test("the same target as a new object keeps the tray: targets are told apart by what they name", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle(item(grantAuditRead)));
    rerender({ target: { ...pgTarget }, ov });
    expect(result.current.items).toHaveLength(1);
  });

  test("a new overview with the same target keeps the tray as it is", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle(item(grantAuditRead)));
    const before = result.current.items;
    rerender({ target: pgTarget, ov: sampleOverview() });
    rerender({ target: pgTarget, ov: undefined });
    expect(result.current.items).toBe(before);
  });

  test("a profile or a region makes another target too", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle(item(grantAuditRead)));
    rerender({ target: { ...pgTarget, region: "us-east-1" }, ov });
    expect(result.current.items).toEqual([]);
  });
});

describe("under StrictMode", () => {
  test("a toggle is applied once and a switch of target empties the tray once", () => {
    const { result, rerender } = renderHook((p: Props) => usePgDraft(p.target, p.ov), {
      initialProps: { target: pgTarget, ov } as Props,
      wrapper: StrictMode,
    });
    act(() => {
      result.current.toggle(item(grantAuditRead));
      result.current.toggle(item(addBobToWriters));
    });
    expect(result.current.items).toHaveLength(2);
    rerender({ target: { ...pgTarget, id: "billing" }, ov });
    expect(result.current.items).toEqual([]);
    act(() => result.current.toggle(item(grantAuditRead)));
    expect(result.current.items).toHaveLength(1);
  });

  test("a component that draws the tray sees the same items as the hook", () => {
    let latest!: ReturnType<typeof usePgDraft>;
    function Harness() {
      latest = usePgDraft(pgTarget, ov);
      return <span>{latest.items.length}</span>;
    }
    const { container } = render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    act(() => latest.toggle(item(grantAuditRead)));
    expect(container).toHaveTextContent("1");
  });
});
