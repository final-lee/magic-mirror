import type { Resource } from "../api/types";
import { makeResource } from "../test/utils";
import { NOT_POSTGRES, pgTabId, pgTargetOf, targetKey } from "./targets";

const row = (id: string, values: Record<string, string>): Resource => makeResource(id, { name: id, ...values });

describe("pgTargetOf on DB Clusters rows", () => {
  test.each(["aurora-postgresql", "postgres"])("a %s cluster opens as itself", (engine) => {
    expect(pgTargetOf(row("orders-aurora", { engine }), "db-clusters")).toEqual({ kind: "cluster", id: "orders-aurora" });
  });

  test.each(["aurora-mysql", "mysql", "mariadb", "docdb", "neptune"])("a %s cluster does not open", (engine) => {
    expect(pgTargetOf(row("legacy", { engine }), "db-clusters")).toBeNull();
  });

  test("a row without an engine value does not open", () => {
    expect(pgTargetOf(row("odd", {}), "db-clusters")).toBeNull();
    expect(pgTargetOf(row("odd", { engine: "" }), "db-clusters")).toBeNull();
  });

  test("a cluster value on a cluster row is not a parent: the row itself is the target", () => {
    expect(pgTargetOf(row("orders-aurora", { engine: "aurora-postgresql", cluster: "other" }), "db-clusters")).toEqual({
      kind: "cluster",
      id: "orders-aurora",
    });
  });
});

describe("pgTargetOf on DB Instances rows", () => {
  test.each(["aurora-postgresql", "postgres"])("a %s instance inside a cluster opens that cluster", (engine) => {
    expect(pgTargetOf(row("orders-aurora-1", { engine, cluster: "orders-aurora" }), "db-instances")).toEqual({
      kind: "cluster",
      id: "orders-aurora",
    });
  });

  test("a postgres instance without a cluster opens as an instance", () => {
    expect(pgTargetOf(row("billing-db", { engine: "postgres", cluster: "" }), "db-instances")).toEqual({ kind: "instance", id: "billing-db" });
  });

  test("a missing cluster value means the same as an empty one", () => {
    expect(pgTargetOf(row("billing-db", { engine: "postgres" }), "db-instances")).toEqual({ kind: "instance", id: "billing-db" });
  });

  test.each(["mysql", "aurora-mysql", "mariadb", "oracle-ee", "sqlserver-se"])("a %s instance does not open, in a cluster or not", (engine) => {
    expect(pgTargetOf(row("legacy-1", { engine }), "db-instances")).toBeNull();
    expect(pgTargetOf(row("legacy-1", { engine, cluster: "legacy" }), "db-instances")).toBeNull();
  });

  test("a row without an engine value does not open", () => {
    expect(pgTargetOf(row("odd", { cluster: "orders-aurora" }), "db-instances")).toBeNull();
  });
});

describe("target identity", () => {
  const target = { profile: "prod", region: "ap-northeast-2", kind: "cluster" as const, id: "orders-aurora" };

  test("targetKey joins profile, region, kind and id", () => {
    expect(targetKey(target)).toBe("prod|ap-northeast-2|cluster|orders-aurora");
  });

  test("a cluster and an instance with the same identifier are different targets", () => {
    expect(targetKey({ ...target, kind: "instance" })).not.toBe(targetKey(target));
    expect(pgTabId({ ...target, kind: "instance" })).not.toBe(pgTabId(target));
  });

  test("the tab id is pg:region:kind:id, so the same identifier in two regions gets two tabs", () => {
    expect(pgTabId(target)).toBe("pg:ap-northeast-2:cluster:orders-aurora");
    expect(pgTabId({ ...target, region: "us-east-1" })).toBe("pg:us-east-1:cluster:orders-aurora");
  });

  test("the notice for other engines is the exact copy", () => {
    expect(NOT_POSTGRES).toBe("PostgreSQL 엔진만 열 수 있어요");
  });
});
