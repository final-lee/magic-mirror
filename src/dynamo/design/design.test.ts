import { describe, expect, it } from "vitest";
import { gsi, table } from "../fixtures";
import type { Item } from "../items/types";
import { analyze, type DesignReport } from "./design";

const diagnostic = (report: DesignReport, id: string) => report.diagnostics.find(item => item.id === id);

describe("design analysis", () => {
  it("treats an unprefixed partition-only table as one entity", () => {
    const report = analyze(table("stg"), [{ id: { S: "abc" }, revision: { N: "2" } }, { id: { S: "def" } }]);
    expect(report.entities).toHaveLength(1);
    expect(report.entities[0].name).toContain("접두사 없음");
    expect(diagnostic(report, "versionAttr")?.count).toBe(1);
  });

  it("infers prefixes, type labels, and date, UUID, ULID and numeric key shapes", () => {
    const db = table("sample", { keys: { pk: { name: "PK", type: "S" }, sk: { name: "SK", type: "S" } } });
    const items: Item[] = [
      { PK: { S: "USER#123" }, SK: { S: "PROFILE#2026-11-06" } },
      { PK: { S: "ORDER#550e8400-e29b-41d4-a716-446655440000" }, SK: { S: "ORDER#123" } },
      { PK: { S: "SESSION#01ARZ3NDEKTSV4RRFFQ69G5FAV" }, SK: { S: "SESSION#x" } },
      { PK: { S: "ORG#x" }, SK: { S: "ORG#x" }, type: { S: "Company" } },
    ];
    const entities = analyze(db, items).entities;
    expect(entities.map(entity => entity.name)).toEqual(["USER / PROFILE", "ORDER / ORDER", "SESSION / SESSION", "Company"]);
    expect(entities[0].pkShape).toBe("USER#<number>");
    expect(entities[0].skShape).toBe("PROFILE#<date>");
    expect(entities[1].pkShape).toBe("ORDER#<uuid>");
    expect(entities[2].pkShape).toBe("SESSION#<ulid>");
  });

  it("measures sparse and overloaded indexes by complete index keys", () => {
    const db = table("sample", { keys: { pk: { name: "PK", type: "S" }, sk: null }, indexes: [gsi("g", { pk: { name: "gpk", type: "S" }, sk: { name: "gsk", type: "S" } })] });
    const items: Item[] = [
      { PK: { S: "USER#1" }, gpk: { S: "a" }, gsk: { S: "x" } },
      { PK: { S: "ORDER#1" }, gpk: { S: "a" }, gsk: { S: "y" } },
      { PK: { S: "SESSION#1" }, gpk: { S: "a" } },
      { PK: { S: "ORG#1" } },
    ];
    const patterns = analyze(db, items).patterns.filter(pattern => pattern.name === "g");
    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toMatchObject({ count: 2, sparse: true, overloaded: true, entities: ["USER", "ORDER"] });
  });

  it("diagnoses TTL boundaries, mixed types, and numeric version attributes", () => {
    const db = table("sample", { ttl: { status: "ENABLED", attribute: "ttl" } });
    const items: Item[] = [
      { id: { S: "a" }, ttl: { N: "100000000001" }, score: { N: "1" }, version: { N: "1" } },
      { id: { S: "b" }, ttl: { N: "100000000000" }, score: { S: "1" } },
      { id: { S: "c" }, ttl: { S: "bad" } },
      { id: { S: "d" }, ttl: { N: "99" } },
      { id: { S: "e" } },
    ];
    const report = analyze(db, items, 100000);
    expect(diagnostic(report, "ttlMillis")?.count).toBe(1);
    expect(diagnostic(report, "ttlMissing")?.count).toBe(1);
    expect(diagnostic(report, "ttlNotNumber")?.count).toBe(1);
    expect(diagnostic(report, "ttlExpiredPresent")?.count).toBe(1);
    expect(diagnostic(report, "mixedType")?.level).toBe("warn");
    expect(diagnostic(report, "versionAttr")?.count).toBe(1);
  });

  it("uses inclusive large-item and hot-key thresholds", () => {
    const db = table("sample");
    const sized = (size: number): Item => ({ id: { S: "x" }, body: { S: "x".repeat(size - 7) } });
    expect(diagnostic(analyze(db, [sized(100 * 1024 - 1)]), "largeItem")).toBeUndefined();
    expect(diagnostic(analyze(db, [sized(100 * 1024)]), "largeItem")?.level).toBe("warn");
    expect(diagnostic(analyze(db, [sized(350 * 1024)]), "largeItem")?.level).toBe("fail");
    const items = ["a", "a", "b", "c", "d", "e", "f", "g", "h", "i"].map(id => ({ id: { S: id } }));
    expect(diagnostic(analyze(db, items), "hotKey")?.count).toBe(1);
    expect(diagnostic(analyze(db, [...items, { id: { S: "j" } }]), "hotKey")).toBeUndefined();
  });
});
