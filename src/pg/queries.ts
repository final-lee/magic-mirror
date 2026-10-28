import { hashKey, useQuery, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { AppError } from "../api/types";
import { pgApi } from "./api";
import { targetKey } from "./targets";
import type {
  PgCellDetail,
  PgDatabaseView,
  PgFindings,
  PgObjectRef,
  PgOverview,
  PgRoleView,
  PgSession,
  PgTarget,
  PgTargetInfo,
  PgWhoCan,
} from "./types";

/**
 * 쿼리 키. 대상별 데이터는 모두 ["pg", targetKey(target), ...] 아래에 두어 한 번에 무효화하거나 지울 수 있다.
 * 세 번째 요소가 종류다(refreshPg가 종류로 순서를 정한다).
 */
export const pgKeys = {
  root: (t: PgTarget) => ["pg", targetKey(t)] as const,
  target: (t: PgTarget) => ["pg", targetKey(t), "target"] as const,
  /** 로그인 사용자별로 따로 둔다. 사용자를 바꾸면 이전 사용자의 개요(canManage 등)가 아니라 새로 연결한 결과를 보여 준다. */
  overview: (t: PgTarget, loginUser: string | null) => ["pg", targetKey(t), "overview", loginUser] as const,
  database: (t: PgTarget, database: string | null) => ["pg", targetKey(t), "database", database] as const,
  cell: (t: PgTarget, database: string | null, role: string | null, schema: string | null) =>
    ["pg", targetKey(t), "cell", database, role, schema] as const,
  objects: (t: PgTarget, database: string | null, query: string) => ["pg", targetKey(t), "objects", database, query] as const,
  role: (t: PgTarget, role: string | null) => ["pg", targetKey(t), "role", role] as const,
  whoCan: (t: PgTarget, database: string | null, object: PgObjectRef | null, privilege: string | null) =>
    ["pg", targetKey(t), "whoCan", database, object, privilege] as const,
  sessions: (t: PgTarget) => ["pg", targetKey(t), "sessions"] as const,
  findings: (t: PgTarget) => ["pg", targetKey(t), "findings"] as const,
};

/**
 * 다음 조회를 force=true로 부를 쿼리들(쿼리 해시), QueryClient별. 새로 고침이 켜고, 그 쿼리의 조회가 한 번 쓰면서 끈다.
 * 화면을 떠나 구독자가 없는 쿼리는 무효화만 되고 다시 불리지 않는다. 그 표시는 쿼리가 다시 불릴 때까지 남겨 두어,
 * 그 화면을 다시 열 때 백엔드의 낡은 스냅숏이 아니라 새로 읽은 것을 받게 한다.
 */
const forceNext = new WeakMap<QueryClient, Set<string>>();

function markForce(qc: QueryClient, hash: string) {
  let marks = forceNext.get(qc);
  if (!marks) forceNext.set(qc, (marks = new Set()));
  marks.add(hash);
}

const takeForce = (qc: QueryClient, key: QueryKey) => forceNext.get(qc)?.delete(hashKey(key)) ?? false;

export function usePgTarget(target: PgTarget) {
  return useQuery<PgTargetInfo, AppError>({
    queryKey: pgKeys.target(target),
    queryFn: () => pgApi.target(target),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 연결하고 클러스터 스냅숏을 읽는다(pg_open). 로그인 사용자가 정해지면(null이 아니면) 시작하고, 사용자를 바꾸면 새로 연결한다.
 * 이 쿼리는 백엔드의 연결 상태와 짝이라서 구독자가 없어지면 바로 버린다. 남겨 두면 같은 사용자로 다시 열 때(탭을 닫았다 열거나
 * 다른 사용자로 갔다 올 때) 연결 없이 낡은 값을 보여 준다.
 * - 탭 전체(PgTab)가 계속 구독해야 한다. 화면마다 바뀌는 자식에서만 부르면 화면을 옮길 때마다 다시 연결한다.
 * - 사용자를 바꾸면 이 쿼리만 새로 연결한다. 이전 사용자로 읽은 나머지(데이터베이스, 역할 …)는 refreshPg로 다시 읽는다.
 */
export function usePgOverview(target: PgTarget, loginUser: string | null) {
  return useQuery<PgOverview, AppError>({
    queryKey: pgKeys.overview(target, loginUser),
    queryFn: () => pgApi.open(target, loginUser!),
    enabled: !!loginUser,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

/** 데이터베이스 하나의 스냅숏. 처음 읽을 때는 백엔드 캐시를 쓰고, 새로 고침 뒤에는 다시 읽는다(force). */
export function usePgDatabase(target: PgTarget, database: string | null) {
  return useQuery<PgDatabaseView, AppError>({
    queryKey: pgKeys.database(target, database),
    queryFn: ({ client, queryKey }) => pgApi.database(target, database!, takeForce(client, queryKey)),
    enabled: !!database,
    staleTime: Infinity,
    retry: false,
  });
}

export function usePgCell(target: PgTarget, database: string | null, role: string | null, schema: string | null) {
  return useQuery<PgCellDetail, AppError>({
    queryKey: pgKeys.cell(target, database, role, schema),
    queryFn: () => pgApi.cell(target, database!, role!, schema!),
    enabled: !!database && !!role && !!schema,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 객체 검색(부분 일치, 최대 100개). 같은 데이터베이스에서 입력을 바꾸는 동안에는 이전 목록을 그대로 보여 주어 목록이 깜빡이지 않게 한다.
 * 데이터베이스를 바꾸면 이전 데이터베이스의 목록은 보여 주지 않는다.
 */
export function usePgObjects(target: PgTarget, database: string | null, query: string) {
  return useQuery<PgObjectRef[], AppError>({
    queryKey: pgKeys.objects(target, database, query),
    queryFn: () => pgApi.objects(target, database!, query),
    enabled: !!database,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[3] === database ? previous : undefined),
    staleTime: Infinity,
    retry: false,
  });
}

export function usePgRole(target: PgTarget, role: string | null) {
  return useQuery<PgRoleView, AppError>({
    queryKey: pgKeys.role(target, role),
    queryFn: () => pgApi.role(target, role!),
    enabled: !!role,
    staleTime: Infinity,
    retry: false,
  });
}

/** 객체와 권한을 모두 고른 뒤에만 조회한다. 결과는 조건별로 캐시에 남는다. */
export function usePgWhoCan(target: PgTarget, database: string | null, object: PgObjectRef | null, privilege: string | null) {
  return useQuery<PgWhoCan, AppError>({
    queryKey: pgKeys.whoCan(target, database, object, privilege),
    queryFn: () => pgApi.whoCan(target, database!, object!, privilege!),
    enabled: !!database && !!object && !!privilege,
    staleTime: Infinity,
    retry: false,
  });
}

/** 세션은 계속 바뀌고 백엔드도 캐시하지 않는다. 화면을 열 때마다 다시 읽고, 읽는 동안에는 이전 값을 보여 준다. */
export function usePgSessions(target: PgTarget) {
  return useQuery<PgSession[], AppError>({
    queryKey: pgKeys.sessions(target),
    queryFn: () => pgApi.sessions(target),
    staleTime: 0,
    retry: false,
  });
}

/** 연결할 수 있는 모든 데이터베이스를 읽는 점검. 무거워서 enabled가 켜진 뒤에만 시작한다. */
export function usePgFindings(target: PgTarget, enabled: boolean) {
  return useQuery<PgFindings, AppError>({
    queryKey: pgKeys.findings(target),
    queryFn: ({ client, queryKey }) => pgApi.findings(target, takeForce(client, queryKey)),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

const kindOf = (q: Pick<Query, "queryKey">) => String(q.queryKey[2]);
/** 대상 정보와 클러스터 스냅숏(pg_open이 새로 읽고, 데이터베이스 스냅숏 캐시를 비운다) */
const BASE = new Set(["target", "overview"]);
/** 클러스터 스냅숏 위에서 만드는 스냅숏 */
const SNAPSHOTS = new Set(["database", "findings"]);

/**
 * 새로 고침(다시 읽기). 이 대상의 모든 쿼리를 무효화하되, 백엔드 스냅숏을 새로 만든 뒤에 그것을 읽는 쿼리가 돌도록 순서를 지킨다.
 * 1) 대상 정보와 개요(pg_open)  2) 데이터베이스 스냅숏과 점검(force=true로 다시 읽는다)  3) 나머지(역할, 칸, 검색, 세션 …)
 * 개요를 다시 연결하지 못했으면 뒤는 시도하지 않는다. 연결 제한 시간(10초)을 단계마다 기다리게 되기 때문이다.
 * 켜진 쿼리만 바로 다시 불리고, 나머지는 무효화만 되어 다시 열릴 때 읽는다.
 */
export async function refreshPg(qc: QueryClient, target: PgTarget): Promise<void> {
  const root = pgKeys.root(target);
  for (const q of qc.getQueryCache().findAll({ queryKey: root })) {
    if (SNAPSHOTS.has(kindOf(q))) markForce(qc, q.queryHash);
  }
  await qc.invalidateQueries({ queryKey: root, predicate: (q) => BASE.has(kindOf(q)) });
  const overviewFailed = qc.getQueryCache().findAll({
    queryKey: root,
    type: "active",
    predicate: (q) => kindOf(q) === "overview" && q.state.status === "error",
  });
  if (overviewFailed.length > 0) return;
  await qc.invalidateQueries({ queryKey: root, predicate: (q) => SNAPSHOTS.has(kindOf(q)) });
  await qc.invalidateQueries({ queryKey: root, predicate: (q) => !BASE.has(kindOf(q)) && !SNAPSHOTS.has(kindOf(q)) });
}

/**
 * 탭을 닫을 때: 이 대상의 연결과 백엔드 캐시를 닫고, 화면이 읽어 둔 쿼리도 지운다.
 * 남겨 두면 같은 대상을 다시 열 때 연결 없이 낡은 값을 보여 주고, 그 값에 맞는 명령은 "먼저 연결해 주세요"로 실패한다.
 * 닫기가 실패해도 화면은 이미 닫혔으므로 기록만 남긴다. 백엔드는 10분 유휴 연결을 스스로 닫는다.
 */
export async function closePg(qc: QueryClient, target: PgTarget): Promise<void> {
  qc.removeQueries({ queryKey: pgKeys.root(target) });
  try {
    await pgApi.close(target);
  } catch (e) {
    console.error("PostgreSQL 연결을 닫지 못했어요", e);
  }
}
