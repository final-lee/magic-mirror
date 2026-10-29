import { act, renderHook } from "@testing-library/react";
import { pgTarget, sampleOverview } from "./fixtures";
import { brushItem, brushOf } from "./brush";
import { FULL_NOTICE, OTHER_DATABASE_NOTICE, OVERLAP_NOTICE } from "./draft";
import type { PgChange, PgGrantTarget } from "./types";
import { usePgDraft } from "./usePgDraft";

const overview = sampleOverview();
const orders: PgGrantTarget = { kind: "relation", schema: "app", name: "orders" };
const grant = (privileges: string[], add: boolean, grantee = "alice", target: PgGrantTarget = orders): PgChange => ({ kind: "grant", database: "orders", grantee, add, items: [{ target, privileges }] });
const dflt = (privileges: string[], add: boolean): PgChange => ({ kind: "defaultPrivilege", database: "orders", creator: "app_owner", schema: "app", objectType: "tables", grantee: "app_read", privileges, add });

function open() {
  return renderHook(() => usePgDraft(pgTarget, overview)).result;
}
function run(...steps: PgChange[]) {
  const result = open();
  for (const step of steps) act(() => result.current.put(step));
  return result.current.items.map((d) => d.change);
}
const brush = (id: Parameters<typeof brushOf>[0], role = "alice") => brushItem(brushOf(id), "orders", role, "app", true);

describe("draft.put", () => {
  test("a grant that overlaps a queued revoke takes the overlap out of the revoke", () => {
    expect(run(grant(["SELECT", "INSERT"], false), grant(["SELECT", "TRIGGER"], true))).toEqual([grant(["INSERT"], false), grant(["SELECT", "TRIGGER"], true)]);
  });

  test("a revoke that covers everything a queued grant has drops the grant", () => {
    expect(run(grant(["SELECT"], true), grant(["SELECT", "INSERT"], false))).toEqual([grant(["SELECT", "INSERT"], false)]);
  });

  test("a revoke of part of a queued grant leaves the rest of the grant", () => {
    expect(run(grant(["SELECT", "INSERT", "DELETE"], true), grant(["INSERT"], false))).toEqual([grant(["SELECT", "DELETE"], true), grant(["INSERT"], false)]);
  });

  test("another target, another grantee or another database is left alone", () => {
    const elsewhere: PgGrantTarget = { kind: "relation", schema: "app", name: "customers" };
    expect(run(grant(["SELECT"], false), grant(["SELECT"], true, "alice", elsewhere), grant(["SELECT"], true, "bob"))).toHaveLength(3);
  });

  test("the same change twice stays one", () => {
    expect(run(grant(["SELECT"], false), grant(["SELECT"], false))).toEqual([grant(["SELECT"], false)]);
  });

  test("default privileges: a subset add trims the queued revoke of the whole line, and the whole-line revoke drops a queued subset", () => {
    const all = ["SELECT", "INSERT", "UPDATE"];
    expect(run(dflt(all, false), dflt(["SELECT"], true))).toEqual([dflt(["INSERT", "UPDATE"], false), dflt(["SELECT"], true)]);
    expect(run(dflt(["SELECT"], true), dflt(all, false))).toEqual([dflt(all, false)]);
  });

  describe("overlap after expansion", () => {
    test("a brush on a whole schema, then a one-table change for a privilege it covers: refused, with the notice, tray unchanged", () => {
      const result = open();
      act(() => result.current.paint([brush("read")]));
      const before = result.current.items;
      act(() => result.current.put(grant(["SELECT"], false)));
      expect(result.current.items).toBe(before);
      expect(result.current.notices).toEqual([OVERLAP_NOTICE]);
      expect(OVERLAP_NOTICE).toBe("같은 대상의 변경이 이미 담겨 있어요. 먼저 그 변경을 거둬 주세요");
    });

    test("the same for a grant of a covered privilege together with an uncovered one", () => {
      const result = open();
      act(() => result.current.paint([brush("read")]));
      act(() => result.current.put(grant(["SELECT", "TRIGGER"], true)));
      expect(result.current.items).toHaveLength(1);
      expect(result.current.notices).toEqual([OVERLAP_NOTICE]);
    });

    test("a one-table change first, then a brush that covers it: refused", () => {
      const result = open();
      act(() => result.current.put(grant(["SELECT"], true)));
      act(() => result.current.paint([brush("read")]));
      expect(result.current.items.map((d) => d.change)).toEqual([grant(["SELECT"], true)]);
      expect(result.current.notices).toEqual([OVERLAP_NOTICE]);
    });

    test("the toggle path of a cell is refused the same way", () => {
      const result = open();
      act(() => result.current.put(grant(["SELECT"], false)));
      act(() => result.current.toggle(brush("read")));
      expect(result.current.items).toHaveLength(1);
      expect(result.current.notices).toEqual([OVERLAP_NOTICE]);
    });

    test("privileges the brush does not cover, another schema, another grantee and sequences do not overlap", () => {
      const result = open();
      act(() => result.current.paint([brush("read")]));
      act(() => result.current.put(grant(["TRIGGER"], true)));
      act(() => result.current.put(grant(["SELECT"], true, "alice", { kind: "relation", schema: "audit", name: "events" })));
      act(() => result.current.put(grant(["SELECT"], true, "bob")));
      act(() => result.current.put(grant(["SELECT"], true, "alice", { kind: "sequence", schema: "app", name: "orders_id_seq" })));
      expect(result.current.items).toHaveLength(5);
      expect(result.current.notices).toEqual([]);
    });
  });

  describe("a full or foreign tray", () => {
    const fill = (result: ReturnType<typeof open>, count: number, extra: PgChange[] = []) =>
      act(() => result.current.add([...extra, ...Array.from({ length: count }, (_, i) => ({ kind: "membership" as const, group: `g${i}`, member: "x", add: true, admin: false }))]));

    test("with 50 items, a change that would trim a queued one changes nothing at all", () => {
      const result = open();
      fill(result, 49, [grant(["SELECT", "INSERT"], false)]);
      expect(result.current.items).toHaveLength(50);
      const before = result.current.items;
      act(() => result.current.put(grant(["SELECT"], true)));
      expect(result.current.items).toBe(before);
      expect(result.current.notices).toContain(FULL_NOTICE);
    });

    test("when the trim empties a queued change there is room for the new one at 50", () => {
      const result = open();
      fill(result, 49, [grant(["SELECT"], false)]);
      act(() => result.current.put(grant(["SELECT"], true)));
      expect(result.current.items).toHaveLength(50);
      expect(result.current.items.map((d) => d.change)).toContainEqual(grant(["SELECT"], true));
      expect(result.current.items.map((d) => d.change)).not.toContainEqual(grant(["SELECT"], false));
    });

    test("another database: nothing is trimmed", () => {
      const result = open();
      act(() => result.current.put(grant(["SELECT", "INSERT"], false)));
      const before = result.current.items;
      act(() => result.current.put({ kind: "grant", database: "analytics", grantee: "alice", add: true, items: [{ target: orders, privileges: ["SELECT"] }] }));
      expect(result.current.items).toBe(before);
      expect(result.current.notices).toEqual([OTHER_DATABASE_NOTICE]);
    });

    test("a refused overlap with another queued change in the tray does not trim a same-shape neighbour", () => {
      const result = open();
      act(() => result.current.paint([brush("read")]));
      act(() => result.current.put(grant(["INSERT", "TRIGGER"], false)));
      const before = result.current.items;
      act(() => result.current.put(grant(["SELECT", "TRIGGER"], true)));
      expect(result.current.items).toBe(before);
    });
  });

  test("a brush on writes does not collide with a read revoke of one table", () => {
    const result = open();
    act(() => result.current.paint([brush("write")]));
    act(() => result.current.put(grant(["SELECT"], false)));
    expect(result.current.items).toHaveLength(2);
  });
});
