import type { Resource } from "../api/types";
import type { KvTarget } from "./types";

/** 탭이 열리는 엔진: Valkey와 Redis OSS. Memcached는 키 목록을 볼 방법이 없다. */
const KV_ENGINES = ["valkey", "redis"];

/** Memcached 행을 더블클릭했을 때 보이는 안내 */
export const NOT_KV = "Valkey·Redis OSS 캐시만 열 수 있어요";

/** 쿼리 키와 연결 관리의 단위. 같은 식별자라도 프로필·리전·종류가 다르면 다른 대상이다. */
export const targetKey = (t: KvTarget) => `${t.profile}|${t.region}|${t.kind}|${t.id}`;

/** 탭 id. 프로필을 바꾸면 모든 대상 탭을 닫으므로 프로필은 넣지 않는다. */
export const kvTabId = (t: KvTarget) => `kv:${t.region}:${t.kind}:${t.id}`;

/**
 * ElastiCache 목록의 행이 어느 대상의 탭을 여는지. Valkey·Redis OSS가 아니면 null.
 * - Replication Groups·Serverless Caches 행은 그 자신을 연다.
 * - Cache Clusters 행은 복제 그룹에 속해 있으면(values.group) 그 그룹을, 아니면 그 단일 노드 클러스터를 연다.
 */
export function kvTargetOf(row: Resource, typeId: "replication-groups" | "serverless-caches" | "cache-clusters"): Pick<KvTarget, "kind" | "id"> | null {
  if (!KV_ENGINES.includes(row.values.engine ?? "")) return null;
  if (typeId === "replication-groups") return { kind: "replicationGroup", id: row.id };
  if (typeId === "serverless-caches") return { kind: "serverlessCache", id: row.id };
  const group = row.values.group;
  return group ? { kind: "replicationGroup", id: group } : { kind: "cacheCluster", id: row.id };
}
