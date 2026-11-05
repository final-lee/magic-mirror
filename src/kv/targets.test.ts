import { makeResource } from "../test/utils";
import { kvTabId, kvTargetOf, NOT_KV, targetKey } from "./targets";

const row = (id: string, engine: string, extra: Record<string, string> = {}) => makeResource(id, { name: id, engine, ...extra });

describe("kvTargetOf", () => {
  test("a Valkey or Redis OSS replication group opens itself", () => {
    expect(kvTargetOf(row("sessions", "valkey"), "replication-groups")).toEqual({ kind: "replicationGroup", id: "sessions" });
    expect(kvTargetOf(row("rate-limit", "redis"), "replication-groups")).toEqual({ kind: "replicationGroup", id: "rate-limit" });
  });

  test("a serverless cache opens itself", () => {
    expect(kvTargetOf(row("feature-flags", "valkey"), "serverless-caches")).toEqual({ kind: "serverlessCache", id: "feature-flags" });
    expect(kvTargetOf(row("legacy", "redis"), "serverless-caches")).toEqual({ kind: "serverlessCache", id: "legacy" });
  });

  test("a member of a replication group opens the group, not the node", () => {
    expect(kvTargetOf(row("sessions-001", "valkey", { group: "sessions" }), "cache-clusters")).toEqual({ kind: "replicationGroup", id: "sessions" });
  });

  test("a single-node Redis cluster without a group opens the cluster", () => {
    expect(kvTargetOf(row("solo", "redis", { group: "" }), "cache-clusters")).toEqual({ kind: "cacheCluster", id: "solo" });
    expect(kvTargetOf(row("solo", "redis"), "cache-clusters")).toEqual({ kind: "cacheCluster", id: "solo" });
  });

  test("Memcached opens nothing, in every list", () => {
    expect(kvTargetOf(row("catalog-mc", "memcached"), "cache-clusters")).toBeNull();
    expect(kvTargetOf(row("catalog-mc", "memcached", { group: "x" }), "cache-clusters")).toBeNull();
    expect(kvTargetOf(row("mc", "memcached"), "replication-groups")).toBeNull();
    expect(kvTargetOf(row("mc", "memcached"), "serverless-caches")).toBeNull();
  });

  test("a row without an engine opens nothing", () => {
    expect(kvTargetOf(makeResource("x", {}), "replication-groups")).toBeNull();
  });

  test("the notice for Memcached names the engines that do open", () => {
    expect(NOT_KV).toBe("Valkey·Redis OSS 캐시만 열 수 있어요");
  });
});

describe("ids", () => {
  const t = { profile: "prod", region: "ap-northeast-2", kind: "replicationGroup" as const, id: "sessions" };

  test("the tab id has the region, kind and id but not the profile (a profile change closes every tab)", () => {
    expect(kvTabId(t)).toBe("kv:ap-northeast-2:replicationGroup:sessions");
    expect(kvTabId({ ...t, profile: "dev" })).toBe(kvTabId(t));
  });

  test("the query key tells targets apart by profile, region and kind too", () => {
    expect(targetKey(t)).toBe("prod|ap-northeast-2|replicationGroup|sessions");
    expect(targetKey({ ...t, kind: "cacheCluster" })).not.toBe(targetKey(t));
    expect(targetKey({ ...t, region: "us-east-1" })).not.toBe(targetKey(t));
  });
});
