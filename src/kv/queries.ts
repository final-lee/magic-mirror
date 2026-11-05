import { useInfiniteQuery, useQuery, type Query, type QueryClient } from "@tanstack/react-query";
import type { AppError } from "../api/types";
import { kvApi } from "./api";
import { keyId } from "./route";
import { targetKey } from "./targets";
import type {
  KvBullJob,
  KvBullJobsPage,
  KvBullQueueView,
  KvBullQueuesPage,
  KvBullState,
  KvClient,
  KvKeyName,
  KvKeyView,
  KvLogin,
  KvOverview,
  KvScanPage,
  KvSlowEntry,
  KvTarget,
  KvTargetInfo,
  KvType,
} from "./types";

/** 한 번에 보여 주는 키 수. 백엔드가 노드마다 SCAN COUNT 500씩 읽어 이만큼 모아 돌려준다 */
export const KEY_PAGE = 1000;

/**
 * 연결 시도. 로그인을 보낼 때마다 attempt가 올라가서 같은 로그인으로 다시 보내도 새로 연결한다(kv_open).
 * password는 쿼리 키에 넣지 않는다.
 */
export interface KvConnect {
  login: KvLogin;
  attempt: number;
}

/**
 * 쿼리 키. 대상별 데이터는 모두 ["kv", targetKey(target), ...] 아래에 두어 한 번에 무효화하거나 지울 수 있다.
 * 세 번째 요소가 종류다(refreshKv가 종류로 순서를 정한다).
 */
export const kvKeys = {
  root: (t: KvTarget) => ["kv", targetKey(t)] as const,
  target: (t: KvTarget) => ["kv", targetKey(t), "target"] as const,
  overview: (t: KvTarget, c: KvConnect) => ["kv", targetKey(t), "overview", c.login.mode, c.login.user, c.login.database, c.attempt] as const,
  scan: (t: KvTarget, pattern: string, typeFilter: KvType | null) => ["kv", targetKey(t), "scan", pattern, typeFilter] as const,
  key: (t: KvTarget, name: KvKeyName) => ["kv", targetKey(t), "key", keyId(name)] as const,
  slowlog: (t: KvTarget) => ["kv", targetKey(t), "slowlog"] as const,
  clients: (t: KvTarget) => ["kv", targetKey(t), "clients"] as const,
  // 🐂 Bull. 세 번째 요소는 모두 "bull"이다(refreshKv가 개요 다음에 다시 읽는다).
  bullQueues: (t: KvTarget, prefix: string) => ["kv", targetKey(t), "bull", "queues", prefix] as const,
  bullQueue: (t: KvTarget, prefix: string, name: string) => ["kv", targetKey(t), "bull", "queue", prefix, name] as const,
  bullJobs: (t: KvTarget, prefix: string, name: string, state: KvBullState) => ["kv", targetKey(t), "bull", "jobs", prefix, name, state] as const,
  bullJob: (t: KvTarget, prefix: string, name: string, id: string) => ["kv", targetKey(t), "bull", "job", prefix, name, id] as const,
};

/** 큐 목록·큐 상세를 자동으로 다시 읽는 간격 */
export const BULL_REFRESH_MS = 5000;
/** 큐를 찾으며 이만큼보다 많은 키를 훑었으면 5초마다 다시 훑지 않는다(자동 새로 고침이 서버를 계속 훑게 되므로) */
export const BULL_AUTO_SCAN_LIMIT = 100_000;
/** 작업 표 한 쪽의 작업 수 */
export const BULL_JOBS_PAGE = 50;

export function useKvTarget(target: KvTarget) {
  return useQuery<KvTargetInfo, AppError>({
    queryKey: kvKeys.target(target),
    queryFn: () => kvApi.target(target),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 연결하고 개요를 읽는다(kv_open). 연결 시도가 정해지면(null이 아니면) 시작한다.
 * 이 쿼리는 백엔드의 연결 상태와 짝이라서 구독자가 없어지면 바로 버린다(pg의 usePgOverview와 같다). 탭 전체(KvTab)가 계속 구독한다.
 * 한 번 연결한 뒤의 다시 읽기는 kv_overview다: 연결이 유휴로 닫혔으면 백엔드가 마지막 로그인으로 다시 붙고, 비밀번호가 필요한데 없으면 loginRequired를 돌려준다.
 */
export function useKvOverview(target: KvTarget, connect: KvConnect | null) {
  return useQuery<KvOverview, AppError>({
    queryKey: connect ? kvKeys.overview(target, connect) : ["kv", targetKey(target), "overview", null],
    queryFn: ({ client, queryKey }) => (client.getQueryState(queryKey)?.data !== undefined ? kvApi.overview(target) : kvApi.open(target, connect!.login)),
    enabled: !!connect,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

/**
 * 키 목록. 패턴·타입 칩이 바뀌면 다른 쿼리다. 화면을 옮겨 다녀도 읽은 키가 남고, 다시 읽기(refreshKv)가 처음부터 다시 읽는다.
 * 커서는 백엔드가 만든 불투명 글이다. 끝까지 읽었으면(cursor null) 더 읽을 쪽이 없다.
 */
export function useKvScan(target: KvTarget, pattern: string, typeFilter: KvType | null, enabled: boolean) {
  return useInfiniteQuery<KvScanPage, AppError, { pages: KvScanPage[] }, readonly unknown[], string | null>({
    queryKey: kvKeys.scan(target, pattern, typeFilter),
    queryFn: ({ pageParam }) => kvApi.scan(target, pattern, typeFilter, pageParam, KEY_PAGE),
    initialPageParam: null,
    getNextPageParam: (last) => last.cursor ?? undefined,
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

/** 키 하나의 값. 컬렉션은 쪽마다 이어서 읽는다(next 커서). name이 null이면 읽지 않는다. */
export function useKvKey(target: KvTarget, name: KvKeyName | null) {
  return useInfiniteQuery<KvKeyView, AppError, { pages: KvKeyView[] }, readonly unknown[], string | null>({
    queryKey: name ? kvKeys.key(target, name) : ["kv", targetKey(target), "key", null],
    queryFn: ({ pageParam }) => kvApi.key(target, name!, pageParam),
    initialPageParam: null,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: !!name,
    staleTime: Infinity,
    retry: false,
  });
}

/** Slow log·클라이언트는 계속 바뀐다. 화면을 열 때마다 다시 읽고, 읽는 동안에는 이전 값을 보여 준다. */
export function useKvSlowlog(target: KvTarget, enabled: boolean) {
  return useQuery<KvSlowEntry[], AppError>({
    queryKey: kvKeys.slowlog(target),
    queryFn: () => kvApi.slowlog(target),
    enabled,
    staleTime: 0,
    retry: false,
  });
}

export function useKvClients(target: KvTarget, enabled: boolean) {
  return useQuery<KvClient[], AppError>({
    queryKey: kvKeys.clients(target),
    queryFn: () => kvApi.clients(target),
    enabled,
    staleTime: 0,
    retry: false,
  });
}

/**
 * 🐂 큐 찾기(kv_bull_queues). 이어서 찾으면(cursor) 쪽이 늘어난다. auto가 켜져 있고 끝까지 찾았고 너무 많은 키를 훑지 않았을 때만 5초마다 다시 읽는다.
 */
export function useKvBullQueues(target: KvTarget, prefix: string, auto: boolean) {
  return useInfiniteQuery<KvBullQueuesPage, AppError, { pages: KvBullQueuesPage[] }, readonly unknown[], string | null>({
    queryKey: kvKeys.bullQueues(target, prefix),
    queryFn: ({ pageParam }) => kvApi.bullQueues(target, prefix, pageParam),
    initialPageParam: null,
    getNextPageParam: (last) => last.cursor ?? undefined,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages;
      if (!auto || query.state.status === "error" || !pages) return false;
      return pages[pages.length - 1].cursor === null && pages[0].scanned <= BULL_AUTO_SCAN_LIMIT ? BULL_REFRESH_MS : false;
    },
    staleTime: 0,
    retry: false,
  });
}

/** 🐂 큐 하나의 상세. auto가 켜져 있으면 5초마다 다시 읽는다(읽는 동안에는 이전 값을 보여 준다). */
export function useKvBullQueue(target: KvTarget, prefix: string, name: string, auto: boolean) {
  return useQuery<KvBullQueueView, AppError>({
    queryKey: kvKeys.bullQueue(target, prefix, name),
    queryFn: () => kvApi.bullQueue(target, prefix, name),
    refetchInterval: (query) => (auto && query.state.status !== "error" ? BULL_REFRESH_MS : false),
    staleTime: 0,
    retry: false,
  });
}

/** 🐂 한 상태의 작업 표. 50개씩 이어 읽는다(start = 지금까지 읽은 수). state가 null이면 읽지 않는다. */
export function useKvBullJobs(target: KvTarget, prefix: string, name: string, state: KvBullState | null) {
  return useInfiniteQuery<KvBullJobsPage, AppError, { pages: KvBullJobsPage[] }, readonly unknown[], number>({
    queryKey: state ? kvKeys.bullJobs(target, prefix, name, state) : ["kv", targetKey(target), "bull", "jobs", null],
    queryFn: ({ pageParam }) => kvApi.bullJobs(target, prefix, name, state!, pageParam, BULL_JOBS_PAGE),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.jobs.length, 0);
      return last.jobs.length > 0 && loaded < last.total ? loaded : undefined;
    },
    enabled: !!state,
    staleTime: 0,
    retry: false,
  });
}

/** 🐂 작업 하나의 상세(데이터·로그·스택·흐름). id가 null이면 읽지 않는다. */
export function useKvBullJob(target: KvTarget, prefix: string, name: string, id: string | null) {
  return useQuery<KvBullJob, AppError>({
    queryKey: id ? kvKeys.bullJob(target, prefix, name, id) : ["kv", targetKey(target), "bull", "job", null],
    queryFn: () => kvApi.bullJob(target, prefix, name, id!),
    enabled: !!id,
    staleTime: Infinity,
    retry: false,
  });
}

const kindOf = (q: Pick<Query, "queryKey">) => String(q.queryKey[2]);
/** 대상 정보와 연결(kv_open·kv_overview). 나머지는 이 연결 위에서 읽는다 */
const BASE: Record<string, true | undefined> = { target: true, overview: true };
/** 이어 읽는 쿼리(키 목록, 키 값): 쪽마다 다시 부르면 느리니 처음 쪽부터 다시 읽게 초기화한다 */
const PAGED: Record<string, true | undefined> = { scan: true, key: true };

/**
 * 새로 고침(다시 읽기). 이 대상의 모든 쿼리를 다시 읽되 연결을 먼저 읽는다.
 * 1) 대상 정보와 개요(kv_overview)  2) 나머지(키 목록·키 값은 처음부터, Slow log·클라이언트는 다시)
 * 켜진 쿼리만 바로 다시 불리고 나머지는 무효화만 되어 다시 열릴 때 읽는다.
 * 개요를 다시 읽지 못했으면 뒤는 시도하지 않고 false를 돌려준다(연결 제한 시간 10초를 단계마다 기다리게 되기 때문이다). 쿼리의 오류는 각 화면이 보인다.
 */
export async function rereadKv(qc: QueryClient, target: KvTarget): Promise<boolean> {
  const root = kvKeys.root(target);
  await qc.invalidateQueries({ queryKey: root, predicate: (q) => !!BASE[kindOf(q)] });
  const failed = qc.getQueryCache().findAll({ queryKey: root, type: "active", predicate: (q) => kindOf(q) === "overview" && q.state.status === "error" });
  if (failed.length > 0) return false;
  await qc.resetQueries({ queryKey: root, predicate: (q) => !!PAGED[kindOf(q)] });
  await qc.invalidateQueries({ queryKey: root, predicate: (q) => !BASE[kindOf(q)] && !PAGED[kindOf(q)] });
  return true;
}

/** ⌘R. 쿼리의 오류는 각 화면이 보인다 */
export async function refreshKv(qc: QueryClient, target: KvTarget): Promise<void> {
  await rereadKv(qc, target);
}

/** 연결이 바뀌었을 때(다른 사용자·다른 DB) 이전 연결로 읽은 키 목록·값·서버 상태를 버린다. 대상 정보와 개요는 그대로다. */
export function forgetKvData(qc: QueryClient, target: KvTarget): void {
  qc.removeQueries({ queryKey: kvKeys.root(target), predicate: (q) => !BASE[kindOf(q)] });
}

/**
 * 탭을 닫을 때: 이 대상의 연결을 닫고, 화면이 읽어 둔 쿼리(키와 값 포함)도 지운다.
 * 닫기가 실패해도 화면은 이미 닫혔으므로 기록만 남긴다. 백엔드는 10분 유휴 연결을 스스로 닫는다.
 */
export async function closeKv(qc: QueryClient, target: KvTarget): Promise<void> {
  qc.removeQueries({ queryKey: kvKeys.root(target) });
  try {
    await kvApi.close(target);
  } catch (e) {
    console.error("키 저장소 연결을 닫지 못했어요", e);
  }
}
