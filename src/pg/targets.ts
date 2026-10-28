import type { Resource } from "../api/types";
import type { PgTarget } from "./types";

/** 탭이 열리는 엔진: Aurora PostgreSQL 클러스터, RDS for PostgreSQL 인스턴스와 Multi-AZ DB 클러스터. */
const POSTGRES_ENGINES = ["aurora-postgresql", "postgres"];

/** 다른 엔진의 행을 더블클릭했을 때 보이는 안내 */
export const NOT_POSTGRES = "PostgreSQL 엔진만 열 수 있어요";

/** 쿼리 키와 연결 관리의 단위. 같은 식별자라도 프로필·리전·종류가 다르면 다른 대상이다. */
export const targetKey = (t: PgTarget) => `${t.profile}|${t.region}|${t.kind}|${t.id}`;

/** 탭 id. 프로필을 바꾸면 모든 대상 탭을 닫으므로 프로필은 넣지 않는다. */
export const pgTabId = (t: PgTarget) => `pg:${t.region}:${t.kind}:${t.id}`;

/**
 * RDS 목록의 행이 어느 대상의 탭을 여는지. PostgreSQL이 아니면 null.
 * - DB Clusters 행은 그 클러스터를 연다.
 * - DB Instances 행은 클러스터에 속해 있으면(values.cluster) 그 클러스터를, 아니면 그 인스턴스를 연다.
 *   Aurora 인스턴스는 클러스터 엔드포인트로 접속해야 해서 인스턴스 탭이 따로 없다.
 */
export function pgTargetOf(row: Resource, typeId: "db-clusters" | "db-instances"): Pick<PgTarget, "kind" | "id"> | null {
  if (!POSTGRES_ENGINES.includes(row.values.engine ?? "")) return null;
  if (typeId === "db-clusters") return { kind: "cluster", id: row.id };
  const cluster = row.values.cluster;
  return cluster ? { kind: "cluster", id: cluster } : { kind: "instance", id: row.id };
}
