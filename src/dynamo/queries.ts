import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AppError } from "../api/types";
import { dynamoApi } from "./api";
import { needsFastRefresh, OVERVIEW_REFRESH_MS, TABLE_REFRESH_MS } from "./group";
import type { DynamoOverview, DynamoTable, TopKeys } from "./types";

// DynamoDB 탭의 react-query 키. 쓰기를 마친 화면은 이 키로 무효화한다.
export const dynamoKeys = {
  all: ["dynamo"] as const,
  region: (profile: string, region: string) => ["dynamo", profile, region] as const,
  overview: (profile: string, region: string) => ["dynamo", profile, region, "overview"] as const,
  table: (profile: string, region: string, table: string) => ["dynamo", profile, region, "table", table] as const,
  topKeys: (profile: string, region: string, table: string) => ["dynamo", profile, region, "topKeys", table] as const,
};

/** 리전의 테이블 목록과 진단. active(탭이 보임)일 때만 60초마다 다시 읽는다 */
export function useDynamoOverview(profile: string, region: string, active: boolean) {
  return useQuery<DynamoOverview, AppError>({
    queryKey: dynamoKeys.overview(profile, region),
    queryFn: () => dynamoApi.overview(profile, region),
    staleTime: OVERVIEW_REFRESH_MS,
    refetchInterval: active ? OVERVIEW_REFRESH_MS : false,
    retry: false,
  });
}

/**
 * 고른 테이블이 바뀌는 중(만드는 중·백필·갱신)일 때만 10초마다 다시 읽는다. 그 밖에는 읽지 않는다(목록이 60초마다 새로 준다).
 * 읽은 테이블은 목록 캐시에 끼워 넣어 화면이 한 곳의 값만 보게 한다.
 */
export function useDynamoTablePoll(profile: string, region: string, listed: DynamoTable | null, active: boolean) {
  const qc = useQueryClient();
  const poll = active && listed !== null && needsFastRefresh(listed);
  const name = listed?.name ?? "";
  return useQuery<DynamoTable, AppError>({
    queryKey: dynamoKeys.table(profile, region, name),
    queryFn: async () => {
      const fresh = await dynamoApi.table(profile, region, name);
      qc.setQueryData<DynamoOverview>(dynamoKeys.overview(profile, region), (o) => o && { ...o, tables: o.tables.map((t) => (t.name === fresh.name ? fresh : t)) });
      return fresh;
    },
    enabled: poll,
    refetchInterval: poll ? TABLE_REFRESH_MS : false,
    staleTime: 0,
    retry: false,
  });
}

/** Contributor Insights가 켜진 테이블의 최근 1시간 상위 키. 저절로 다시 읽지 않는다(CloudWatch 요청은 돈이 든다) */
export function useDynamoTopKeys(profile: string, region: string, table: string, enabled: boolean) {
  return useQuery<TopKeys, AppError>({
    queryKey: dynamoKeys.topKeys(profile, region, table),
    queryFn: () => dynamoApi.topKeys(profile, region, table),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** ⌘R·다시 읽기: 이 리전의 모든 읽기를 무효화한다 */
export async function refreshDynamo(qc: QueryClient, profile: string, region: string): Promise<void> {
  await qc.invalidateQueries({ queryKey: dynamoKeys.region(profile, region) });
}
