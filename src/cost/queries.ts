import { hashKey, useQuery, useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import type { AppError } from "../api/types";
import { costApi } from "./api";
import type { CostBreakdown, CostOverview, CostQuery, CostUsage } from "./types";

/** 개요는 분해 기준을 쓰지 않으므로 키에서 뺀다. 기준만 바꿔도 개요를 다시 부르지 않는다 */
export type OverviewQuery = Omit<CostQuery, "groupBy">;

/** 쿼리 키. 프로필별 데이터는 ["cost", profile, ...] 아래에 둔다. */
export const costKeys = {
  root: (profile: string) => ["cost", profile] as const,
  overview: (profile: string, q: OverviewQuery) => ["cost", profile, "overview", q] as const,
  breakdown: (profile: string, q: CostQuery) => ["cost", profile, "breakdown", q] as const,
  tagKeys: (profile: string) => ["cost", profile, "tagKeys"] as const,
  usage: (profile: string) => ["cost", profile, "usage"] as const,
};

/**
 * 다음 조회를 refresh=true(캐시 건너뛰기)로 부를 쿼리들의 해시. 새로 고침이 켜고, 조회가 한 번 쓰면서 끈다.
 * Cost Explorer는 요청마다 돈이 들어서 화면을 그냥 다시 그릴 때는 늘 백엔드 캐시(6시간)로 답하게 둔다.
 */
const forceNext = new Set<string>();

const takeForce = (queryKey: readonly unknown[]) => forceNext.delete(hashKey(queryKey));

/** 실제로 요청을 보냈으면 계수기를 다시 읽는다(cost_usage는 AWS를 부르지 않는다) */
function recount(qc: QueryClient, profile: string, requests: number) {
  if (requests > 0) void qc.invalidateQueries({ queryKey: costKeys.usage(profile) });
}

export function useCostOverview(profile: string, q: OverviewQuery) {
  const qc = useQueryClient();
  return useQuery<CostOverview, AppError>({
    queryKey: costKeys.overview(profile, q),
    queryFn: async ({ queryKey }) => {
      // 백엔드는 개요에서 groupBy를 무시하지만 CostQuery 모양으로 받는다
      const r = await costApi.overview(profile, { ...q, groupBy: { kind: "service" } }, takeForce(queryKey));
      recount(qc, profile, r.requests);
      return r;
    },
    staleTime: Infinity,
    retry: false,
  });
}

export function useCostBreakdown(profile: string, q: CostQuery, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery<CostBreakdown, AppError>({
    queryKey: costKeys.breakdown(profile, q),
    queryFn: async ({ queryKey }) => {
      const r = await costApi.breakdown(profile, q, takeForce(queryKey));
      recount(qc, profile, r.requests);
      return r;
    },
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

/** 활성 비용 할당 태그 키. 분해 기준에서 태그를 고를 때만 부른다(요청 1건) */
export function useCostTagKeys(profile: string, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery<string[], AppError>({
    queryKey: costKeys.tagKeys(profile),
    queryFn: async ({ queryKey }) => {
      const keys = await costApi.tagKeys(profile, takeForce(queryKey));
      // 이 명령은 보낸 요청 수를 돌려주지 않는다. 계수기 읽기는 공짜라 늘 다시 읽는다
      recount(qc, profile, 1);
      return keys;
    },
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

export function useCostUsage(profile: string) {
  return useQuery<CostUsage, AppError>({
    queryKey: costKeys.usage(profile),
    queryFn: () => costApi.usage(profile),
    staleTime: Infinity,
    retry: false,
  });
}

const part = (q: Query) => q.queryKey[2];

/**
 * 비용 탭의 새로고침(⌘R): 지금 화면의 Cost Explorer 조회만 캐시를 건너뛴다.
 * 1. 개요를 refresh=true로 다시 부르고 끝날 때까지 기다린다.
 * 2. 서비스별 분해는 개요와 같은 요청이라 refresh=false로 방금 쓴 캐시를 읽는다(같은 요청에 두 번 돈을 내지 않는다).
 *    다른 기준의 분해와 태그 키는 refresh=true로 부른다. 계수기는 그대로 다시 읽는다.
 * 보이지 않는 조회는 낡음 표시만 한다. 다시 보면 백엔드 캐시로 답한다.
 */
export async function refreshCost(qc: QueryClient, profile: string): Promise<void> {
  const active = qc.getQueryCache().findAll({ queryKey: costKeys.root(profile), type: "active" });
  const forced = active
    .filter((q) => part(q) === "overview" || part(q) === "tagKeys" || (part(q) === "breakdown" && (q.queryKey[3] as CostQuery).groupBy.kind !== "service"))
    .map((q) => q.queryHash);
  forced.forEach((h) => forceNext.add(h));
  try {
    await qc.invalidateQueries({ queryKey: costKeys.root(profile), predicate: (q) => part(q) === "overview" });
    await qc.invalidateQueries({ queryKey: costKeys.root(profile), predicate: (q) => part(q) !== "overview" });
  } finally {
    // 조회가 일어나지 않았다면 표시만 남기지 않는다
    forced.forEach((h) => forceNext.delete(h));
  }
}
