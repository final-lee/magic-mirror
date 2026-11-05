import { nodeInfo, sampleOverview, serverlessOverview } from "./fixtures";
import { keyspaceTotals, summarize } from "./stats";

test("totals count the primary nodes only", () => {
  const s = summarize(sampleOverview());
  expect(s.opsPerSec).toBe(4210);
  expect(s.connectedClients).toBe(86);
  expect(s.usedMemory).toBe(412 * 1024 * 1024);
  expect(s.maxMemory).toBe(1024 * 1024 * 1024);
  expect(s.hitRatio).toBeCloseTo(0.93);
  expect(s.expires).toBe(1_198_000);
});

test("the replication lag is the worst of the replicas, and uptime the newest node", () => {
  const s = summarize(sampleOverview());
  expect(s.replicationLagSeconds).toBe(1);
  expect(s.uptimeSeconds).toBe(12 * 86_400 + 3 * 3600);
});

test("sharded clusters add the shards", () => {
  const nodes = [
    { id: "a", address: "a:6379", role: "primary" as const, shard: "0001", slots: "0-5460" },
    { id: "b", address: "b:6379", role: "primary" as const, shard: "0002", slots: "5461-10922" },
    { id: "c", address: "c:6379", role: "replica" as const, shard: "0002", slots: null },
  ];
  const ov = sampleOverview({ mode: "cluster", nodes, info: [nodeInfo("a:6379"), nodeInfo("b:6379"), nodeInfo("c:6379", { role: "slave" })], dbsize: 2_480_000 });
  const s = summarize(ov);
  expect(s.opsPerSec).toBe(8420);
  expect(s.maxMemory).toBe(2 * 1024 * 1024 * 1024);
  expect(keyspaceTotals(ov)).toEqual([{ db: 0, keys: 2_480_000, expires: 2_396_000 }]);
});

test("no max memory on one primary means no total, and no hits means no ratio", () => {
  const ov = serverlessOverview({ info: [nodeInfo("feature-flags-x1y2z3.serverless.apn2.cache.amazonaws.com:6379", { maxMemory: null, hits: 0, misses: 0 })] });
  const s = summarize(ov);
  expect(s.maxMemory).toBeNull();
  expect(s.hitRatio).toBeNull();
});
