import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { AppError } from "../api/types";
import { sqsApi } from "./api";
import type { SqsFlow, SqsOverview, SqsQueue, SqsRegionFlow } from "./types";

// SQS 탭의 react-query 키. 쓰기를 마친 화면은 이 키로 무효화한다.
export const sqsKeys = {
  all: ["sqs"] as const,
  region: (profile: string, region: string) => ["sqs", profile, region] as const,
  overview: (profile: string, region: string) => ["sqs", profile, region, "overview"] as const,
  queue: (profile: string, region: string, url: string) => ["sqs", profile, region, "queue", url] as const,
  flow: (profile: string, region: string, url: string, withIam: boolean) => ["sqs", profile, region, "flow", url, withIam] as const,
  regionFlow: (profile: string, region: string) => ["sqs", profile, region, "regionFlow"] as const,
  peekable: (profile: string, region: string, url: string) => ["sqs", profile, region, "peekable", url] as const,
  moveTasks: (profile: string, region: string, url: string) => ["sqs", profile, region, "moveTasks", url] as const,
  changes: (profile: string, region: string) => ["sqs", profile, region, "changes"] as const,
};

/** 목록을 다시 읽는 간격(탭이 보일 때만) */
export const OVERVIEW_REFRESH_MS = 30_000;
/** 고른 큐를 다시 읽는 간격(탭이 보일 때만) */
export const QUEUE_REFRESH_MS = 5_000;

/** 다음 overview 조회를 force=true로 부를 (프로필, 리전). 새로 고침이 켜고, 조회가 한 번 쓰면서 끈다 */
const forceNext = new Set<string>();
const regionId = (profile: string, region: string) => `${profile}|${region}`;

/** 리전의 큐 목록과 진단. active(탭이 보임)일 때만 30초마다 다시 읽는다 */
export function useSqsOverview(profile: string, region: string, active: boolean) {
  return useQuery<SqsOverview, AppError>({
    queryKey: sqsKeys.overview(profile, region),
    queryFn: () => sqsApi.overview(profile, region, forceNext.delete(regionId(profile, region))),
    staleTime: OVERVIEW_REFRESH_MS,
    refetchInterval: active ? OVERVIEW_REFRESH_MS : false,
    retry: false,
  });
}

/** 고른 큐 하나. active일 때만 5초마다 다시 읽는다 */
export function useSqsQueue(profile: string, region: string, url: string | null, active: boolean) {
  return useQuery<SqsQueue, AppError>({
    queryKey: sqsKeys.queue(profile, region, url ?? ""),
    queryFn: () => sqsApi.queue(profile, region, url!),
    enabled: url !== null,
    staleTime: 0,
    refetchInterval: active ? QUEUE_REFRESH_MS : false,
    retry: false,
  });
}

/** 큐의 흐름. withIam을 켜면 켜기 전 결과를 보여 주면서 다시 읽는다 */
export function useSqsFlow(profile: string, region: string, url: string, withIam: boolean, enabled: boolean) {
  return useQuery<SqsFlow, AppError>({
    queryKey: sqsKeys.flow(profile, region, url, withIam),
    queryFn: () => sqsApi.flow(profile, region, url, withIam),
    enabled,
    staleTime: 60_000,
    placeholderData: (previous) => previous,
    retry: false,
  });
}

/** 리전 전체 흐름 지도 */
export function useSqsRegionFlow(profile: string, region: string, enabled: boolean) {
  return useQuery<SqsRegionFlow, AppError>({
    queryKey: sqsKeys.regionFlow(profile, region),
    queryFn: () => sqsApi.regionFlow(profile, region),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** ⌘R·다시 읽기: 이 리전의 모든 읽기를 무효화하고 목록은 CloudWatch 활동까지 새로 읽는다(force) */
export async function refreshSqs(qc: QueryClient, profile: string, region: string): Promise<void> {
  const id = regionId(profile, region);
  forceNext.add(id);
  try {
    await qc.invalidateQueries({ queryKey: sqsKeys.overview(profile, region) });
  } finally {
    // 구독하는 화면이 없어 조회가 일어나지 않았다면 표시만 남기지 않는다
    forceNext.delete(id);
  }
  await qc.invalidateQueries({ queryKey: sqsKeys.region(profile, region), predicate: (q) => q.queryKey[3] !== "overview" });
}
