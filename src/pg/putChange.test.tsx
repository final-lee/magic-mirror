import { act, renderHook } from "@testing-library/react";
import { pgTarget, sampleOverview } from "./fixtures";
import { putChange } from "./putChange";
import type { PgChange, PgGrantTarget } from "./types";
import { usePgDraft } from "./usePgDraft";

const overview = sampleOverview();
const orders: PgGrantTarget = { kind: "relation", schema: "app", name: "orders" };
const grant = (privileges: string[], add: boolean, grantee = "alice", target: PgGrantTarget = orders): PgChange => ({ kind: "grant", database: "orders", grantee, add, items: [{ target, privileges }] });
const dflt = (privileges: string[], add: boolean): PgChange => ({ kind: "defaultPrivilege", database: "orders", creator: "app_owner", schema: "app", objectType: "tables", grantee: "app_read", privileges, add });

function run(...steps: PgChange[]) {
  const { result } = renderHook(() => usePgDraft(pgTarget, overview));
  for (const step of steps) act(() => putChange(result.current, step));
  return result.current.items.map((d) => d.change);
}

describe("putChange", () => {
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
});
