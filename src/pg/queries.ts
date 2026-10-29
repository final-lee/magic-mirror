import { hashKey, partialMatchKey, queryOptions, useQuery, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { AppError } from "../api/types";
import { pgApi } from "./api";
import { targetKey } from "./targets";
import type {
  PgCellDetail,
  PgChangeLogEntry,
  PgDatabaseView,
  PgDropPlan,
  PgFindings,
  PgObjectRef,
  PgOverview,
  PgPresetKind,
  PgPresetSuggestion,
  PgRoleView,
  PgSession,
  PgTarget,
  PgTargetInfo,
  PgWhoCan,
} from "./types";

/** 한 대상·한 데이터베이스의 객체 검색들이 공유하는 키 앞부분(검색어만 다르다) */
const objectSearch = (t: PgTarget, database: string | null) => ["pg", targetKey(t), "objects", database] as const;

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
  objectSearch,
  objects: (t: PgTarget, database: string | null, query: string) => [...objectSearch(t, database), query] as const,
  role: (t: PgTarget, role: string | null) => ["pg", targetKey(t), "role", role] as const,
  whoCan: (t: PgTarget, database: string | null, object: PgObjectRef | null, privilege: string | null) =>
    ["pg", targetKey(t), "whoCan", database, object, privilege] as const,
  sessions: (t: PgTarget) => ["pg", targetKey(t), "sessions"] as const,
  findings: (t: PgTarget) => ["pg", targetKey(t), "findings"] as const,
  preset: (t: PgTarget, database: string | null, preset: PgPresetKind | null, schemas: string[]) => ["pg", targetKey(t), "preset", database, preset, schemas] as const,
  dropPlan: (t: PgTarget, role: string | null, reassignTo: string | null) => ["pg", targetKey(t), "dropPlan", role, reassignTo] as const,
  /**
   * 변경 기록은 대상마다 있는 것이 아니라 앱이 쓰는 파일 하나다(IAM의 iamKeys.changeLog와 같다). 그래서 대상의 키 밖에 둔다:
   * 다시 읽기(refreshPg)와 탭 닫기(closePg)는 대상의 쿼리만 건드리고, 이 목록은 적용이 끝날 때마다 refreshPgAfterChange가 무효화한다.
   */
  changeLog: ["pg", "changeLog"] as const,
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

const databaseOptions = (target: PgTarget, database: string | null) =>
  queryOptions<PgDatabaseView, AppError>({
    queryKey: pgKeys.database(target, database),
    queryFn: ({ client, queryKey }) => pgApi.database(target, database!, takeForce(client, queryKey)),
    staleTime: Infinity,
    retry: false,
  });

/** 데이터베이스 하나의 스냅숏. 처음 읽을 때는 백엔드 캐시를 쓰고, 새로 고침 뒤에는 다시 읽는다(force). */
export function usePgDatabase(target: PgTarget, database: string | null) {
  return useQuery({ ...databaseOptions(target, database), enabled: !!database });
}

/**
 * 같은 쿼리를 읽지 않고 보기만 한다: 다른 화면(권한 표, 기본 권한, 역할 상세)이 읽어 둔 사본이 있으면 data에 있고, 없으면 data가 없다.
 * 사본이 바뀌면 다시 그려진다. 읽지 않으니 새로 고침이 이 구독 때문에 다시 읽는 일도 없다.
 * 데이터베이스 스냅숏 전체가 필요 없는 화면(누가 할 수 있나)이 "일부만 읽었어요"를 알리는 데 쓴다. 읽게 하면 객체 검색이 같은 때 읽는 스냅숏을 한 번 더 읽는다.
 */
export function usePgDatabaseIfRead(target: PgTarget, database: string | null) {
  return useQuery({ ...databaseOptions(target, database), enabled: false });
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
 * 객체 검색(부분 일치, 최대 100개). 같은 대상의 같은 데이터베이스에서 입력을 바꾸는 동안에는 이전 목록을 그대로 보여 주어 목록이 깜빡이지 않게 한다.
 * 대상이나 데이터베이스를 바꾸면 이전 목록은 보여 주지 않는다.
 */
export function usePgObjects(target: PgTarget, database: string | null, query: string) {
  return useQuery<PgObjectRef[], AppError>({
    queryKey: pgKeys.objects(target, database, query),
    queryFn: () => pgApi.objects(target, database!, query),
    enabled: !!database,
    placeholderData: (previous, previousQuery) =>
      previousQuery && partialMatchKey(previousQuery.queryKey, pgKeys.objectSearch(target, database)) ? previous : undefined,
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

/** 변경 기록(최신순). 화면을 열 때마다 다시 읽는다: 방금 한 변경이나 다른 창이 남긴 기록이 바로 보여야 해서 캐시를 믿지 않는다. */
export function usePgChangeLog() {
  return useQuery<PgChangeLogEntry[], AppError>({
    queryKey: pgKeys.changeLog,
    queryFn: () => pgApi.changeLog(),
    staleTime: 0,
    retry: false,
  });
}

/**
 * 역할 만들기의 프리셋 제안(같은 권한을 가진 그룹, 제안할 이름, 기본 권한을 줄 역할). 데이터베이스·프리셋·스키마를 모두 골랐을 때만 조회한다.
 * 같은 선택은 캐시를 쓴다. 적용이 끝나면 다른 쿼리와 함께 무효화되어 다시 열 때 새로 읽는다.
 */
export function usePgPreset(target: PgTarget, database: string | null, preset: PgPresetKind | null, schemas: string[]) {
  return useQuery<PgPresetSuggestion, AppError>({
    queryKey: pgKeys.preset(target, database, preset, schemas),
    queryFn: () => pgApi.preset(target, database!, preset!, schemas),
    enabled: !!database && !!preset && preset !== "admin" && schemas.length > 0,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 역할 삭제 계획. 고른 넘겨받을 역할마다 새로 받고, 이전 계획을 남겨 두지 않는다(gcTime 0): 계획은 그 순간의 클러스터로 만든 것이다.
 */
export function usePgDropPlan(target: PgTarget, role: string | null, reassignTo: string | null) {
  return useQuery<PgDropPlan, AppError>({
    queryKey: pgKeys.dropPlan(target, role, reassignTo),
    queryFn: () => pgApi.dropPlan(target, role!, reassignTo!),
    enabled: !!role && !!reassignTo,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

const kindOf = (q: Pick<Query, "queryKey">) => String(q.queryKey[2]);
/** 대상 정보와 클러스터 스냅숏(pg_open이 새로 읽고, 데이터베이스 스냅숏 캐시를 비운다) */
const BASE = new Set(["target", "overview"]);
/** 클러스터 스냅숏 위에서 만드는 스냅숏 */
const SNAPSHOTS = new Set(["database", "findings"]);

/**
 * 이 대상의 스냅숏 쿼리(데이터베이스, 점검)가 다음에 조회할 때 force=true를 쓰도록 표시한다.
 * 한 번도 읽은 적 없는 쿼리(data가 없다)는 표시하지 않는다. 새로 읽을 사본이 없고, 첫 읽기는 force가 아니다.
 * 점검 화면을 열기 전에도 점검 쿼리는 만들어져 있고, 처음 읽다 실패한 쿼리도 그렇다. 읽은 적이 있으면 마지막 읽기가 실패했어도 표시한다.
 */
function markSnapshots(qc: QueryClient, target: PgTarget) {
  for (const q of qc.getQueryCache().findAll({ queryKey: pgKeys.root(target) })) {
    if (SNAPSHOTS.has(kindOf(q)) && q.state.data !== undefined) markForce(qc, q.queryHash);
  }
}

/** 개요 다음 단계: 스냅숏을 다시 읽고, 그 위에서 읽는 나머지(역할, 칸, 검색, 세션 …)를 다시 읽는다. */
async function rereadAfterOverview(qc: QueryClient, target: PgTarget) {
  const root = pgKeys.root(target);
  await qc.invalidateQueries({ queryKey: root, predicate: (q) => SNAPSHOTS.has(kindOf(q)) });
  await qc.invalidateQueries({ queryKey: root, predicate: (q) => !BASE.has(kindOf(q)) && !SNAPSHOTS.has(kindOf(q)) });
}

/**
 * 새로 고침(다시 읽기). 이 대상의 모든 쿼리를 무효화하되, 백엔드 스냅숏을 새로 만든 뒤에 그것을 읽는 쿼리가 돌도록 순서를 지킨다.
 * 1) 대상 정보와 개요(pg_open)  2) 데이터베이스 스냅숏과 점검(force=true로 다시 읽는다)  3) 나머지(역할, 칸, 검색, 세션 …)
 * 개요를 다시 연결하지 못했으면 뒤는 시도하지 않는다. 연결 제한 시간(10초)을 단계마다 기다리게 되기 때문이다.
 * 켜진 쿼리만 바로 다시 불리고, 나머지는 무효화만 되어 다시 열릴 때 읽는다.
 * 개요를 다시 연결하지 못했으면 false다(화면은 아직 낡았다).
 */
async function refreshAll(qc: QueryClient, target: PgTarget): Promise<boolean> {
  markSnapshots(qc, target);
  await qc.invalidateQueries({ queryKey: pgKeys.root(target), predicate: (q) => BASE.has(kindOf(q)) });
  const overviewFailed = qc.getQueryCache().findAll({
    queryKey: pgKeys.root(target),
    type: "active",
    predicate: (q) => kindOf(q) === "overview" && q.state.status === "error",
  });
  if (overviewFailed.length > 0) return false;
  await rereadAfterOverview(qc, target);
  return true;
}

/** 새로 고침. 쿼리의 오류는 각 화면이 보인다 */
export async function refreshPg(qc: QueryClient, target: PgTarget): Promise<void> {
  await refreshAll(qc, target);
}

/** refreshPg와 같되, 개요를 다시 연결하지 못했으면 false를 돌려준다(화면이 아직 낡았다). 다시 읽기 버튼이 쓴다 */
export const rereadPg = refreshAll;

/**
 * refreshPg에서 연결(1단계)만 뺀 것. 로그인 사용자를 바꿔 새로 연결한 직후에 부른다.
 * 새 사용자의 pg_open이 개요를 이미 새로 읽었으니 다시 연결하지 않고, 이전 사용자의 연결로 읽어 둔 나머지만 다시 읽는다.
 */
export async function refreshPgData(qc: QueryClient, target: PgTarget): Promise<void> {
  markSnapshots(qc, target);
  await rereadAfterOverview(qc, target);
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

/** 적용은 됐는데 개요를 다시 읽지 못했을 때 안내에 더하는 말. 사용자가 [다시 읽기]로 직접 읽게 한다 */
export const REFRESH_FAILED_TEXT = "적용은 됐지만 목록을 다시 읽지 못했어요. [다시 읽기]를 눌러 주세요";

/**
 * 백엔드가 클러스터를 새로 읽어 만든 개요(pg_overview)를 개요 쿼리의 값으로 바꾼다. pg_open과 달리 다시 연결하지 않는다.
 * - 이미 읽어 둔 개요만 바꾼다. 그 로그인 사용자의 개요 쿼리가 없으면 만들지 않는다: 이 쿼리는 연결과 짝이라 남은 값이 낡은 값이 되기 쉽다(usePgOverview).
 *   그래도 부르기는 한다. 백엔드가 읽은 클러스터 스냅숏을 이어지는 읽기(데이터베이스, 역할 …)가 쓰기 때문이다.
 * - 읽지 못하면 false를 돌려준다. 개요 쿼리를 건드리지 않는다(낡은 값이 남고, 쿼리 오류로 바뀌지도 않는다): 안 되는 연결을 자동으로 다시
 *   두드리지 않고, 호출한 쪽이 사용자에게 알려 [다시 읽기]로 읽게 한다.
 */
async function replaceOverview(qc: QueryClient, target: PgTarget): Promise<boolean> {
  try {
    const overview = await pgApi.overview(target);
    const key = pgKeys.overview(target, overview.loginUser);
    if (qc.getQueryData(key) !== undefined) qc.setQueryData(key, overview);
    return true;
  } catch {
    return false;
  }
}

/**
 * 변경을 적용한 뒤 화면을 다시 읽는다. 적용이 성공했을 때도, 실패했을 때도 부른다: 실패한 시도도 변경 기록에 남고,
 * 백엔드가 계획을 다시 비교하느라 클러스터와 실행한 데이터베이스를 새로 읽었으며, COMMIT 중에 연결이 끊겼다면 적용됐을 수도 있다.
 * refreshPg(다시 읽기)와 달리 다시 연결하지 않고, IAM처럼 기다리지도 않는다. PostgreSQL은 커밋하면 바로 보인다.
 * 1) 변경 기록은 곧바로 무효화한다.
 * 2) 개요: pg_overview로 바꾼다. 백엔드가 클러스터를 새로 읽어 스냅숏에 담으므로, 이 단계가 뒤의 읽기보다 먼저다.
 * 3) 실행한 데이터베이스의 보기: force로 다시 읽는다. 백엔드가 적용 뒤에 읽은 것이 실패했어도 낡은 값을 보이지 않게 한다.
 *    읽은 적 없는 데이터베이스는 표시하지 않는다(refreshPg와 같다): 새로 읽을 사본이 없고, 첫 읽기는 force가 아니다.
 * 4) 그 위에서 만드는 나머지(다른 데이터베이스의 보기, 점검, 역할, 칸, 검색, 누가 할 수 있나, 세션)는 3)이 끝난 뒤에 무효화한다.
 *    구성원과 속성의 변경은 모든 데이터베이스의 실효 권한을 바꾸기 때문에 실행한 데이터베이스만 고르지 않는다.
 *    켜진 쿼리는 바로 다시 불리고, 나머지는 무효화만 되어 다시 열릴 때 읽는다.
 * 어떤 단계가 실패해도 거부하지 않는다. 쿼리의 오류는 그 쿼리의 화면이 보인다. 다만 개요를 다시 읽지 못했으면 false를 돌려준다:
 * 개요를 보는 화면(역할 목록 …)은 오류 없이 낡은 값 그대로라서 알릴 곳이 따로 필요하다(REFRESH_FAILED_TEXT). 나머지 단계는 그래도 한다.
 * onOverview는 개요를 읽자마자(나머지 단계 전에) 그 결과로 불린다. 돌려주는 값은 모든 단계가 끝난 뒤의 같은 결과다.
 */
export async function refreshPgAfterChange(
  qc: QueryClient,
  target: PgTarget,
  database: string,
  onOverview?: (read: boolean) => void,
): Promise<boolean> {
  const log = qc.invalidateQueries({ queryKey: pgKeys.changeLog });
  const overviewRead = await replaceOverview(qc, target);
  // 개요의 결과는 나머지를 기다리지 않고 바로 알린다: 죽은 연결에서는 나머지 읽기마다 제한 시간을 기다리게 된다
  onOverview?.(overviewRead);

  const executed = pgKeys.database(target, database);
  const query = qc.getQueryCache().find({ queryKey: executed, exact: true });
  if (query && query.state.data !== undefined) markForce(qc, query.queryHash);
  await qc.invalidateQueries({ queryKey: executed, exact: true });

  const executedHash = hashKey(executed);
  await qc.invalidateQueries({ queryKey: pgKeys.root(target), predicate: (q) => !BASE.has(kindOf(q)) && q.queryHash !== executedHash });
  await log;
  return overviewRead;
}
