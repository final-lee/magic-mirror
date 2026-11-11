import { useQuery } from "@tanstack/react-query";
import type { AppError } from "../../api/types";
import { streamApi } from "./api";
import type { Connections } from "./types";

const CONNECTIONS_STALE_MS = 60_000;

export const connectionsKey = (profile: string, region: string, table: string) => ["dynamo", profile, region, "connections", table] as const;

/** 테이블의 연결(소비자·Kinesis·복제본). 개요 탭의 진단 보강과 스트림 탭이 같은 키를 쓴다 */
export function useConnections(profile: string, region: string, table: string, enabled: boolean) {
  return useQuery<Connections, AppError>({
    queryKey: connectionsKey(profile, region, table),
    queryFn: () => streamApi.connections(profile, region, table),
    enabled,
    staleTime: CONNECTIONS_STALE_MS,
    retry: false,
  });
}
