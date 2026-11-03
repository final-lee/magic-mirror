import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { AppError, IndexedList, ListResult, ServiceInfo, Settings } from "./types";

export const GLOBAL = "global";

/** 리소스 목록 캐시가 오래됐다고 보는 기본 시간(분) */
export const DEFAULT_RESOURCE_TTL_MINUTES = 15;

/** 설정의 TTL(분)을 ms로. 비어 있으면 기본값, 0이면 무제한 */
export function resourceTtlMs(minutes: number | null | undefined): number {
  const m = minutes ?? DEFAULT_RESOURCE_TTL_MINUTES;
  return m === 0 ? Infinity : m * 60_000;
}

export function resourcesKey(profile: string, region: string, service: ServiceInfo, typeId: string) {
  return ["resources", profile, service.global ? GLOBAL : region, service.id, typeId] as const;
}

export const resourceIndexKey = (profile: string) => ["resource-index", profile] as const;

export function useServices() {
  return useQuery({ queryKey: ["services"], queryFn: api.listServices, staleTime: Infinity });
}

export function useProfiles() {
  return useQuery({ queryKey: ["profiles"], queryFn: api.listProfiles, staleTime: Infinity });
}

export function useAccount(profile: string | null) {
  return useQuery({
    queryKey: ["account", profile],
    queryFn: () => api.getAccount(profile!),
    enabled: !!profile,
    staleTime: Infinity,
    retry: false,
  });
}

/** 설정의 리소스 캐시 TTL(ms). 설정은 앱이 읽어 두므로 여기서는 읽지 않고 캐시만 본다(읽기 전에는 기본값) */
export function useResourceTtlMs(): number {
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api.getSettings(), enabled: false, select: (s: Settings) => s.resourceCacheTtlMinutes });
  return resourceTtlMs(q.data);
}

/**
 * fetch=false면 호출하지 않고 캐시된 값만 돌려준다(즐겨찾기 개수 표시용).
 * 한 번 읽은 목록은 앱이 켜져 있는 동안 버리지 않는다(⌘K가 찾는 대상이다). TTL이 지나면 그 목록을 다시 볼 때 뒤에서 다시 읽는다.
 */
export function useResources(profile: string | null, region: string, service: ServiceInfo, typeId: string, fetch = true) {
  const staleTime = useResourceTtlMs();
  return useQuery<ListResult, AppError>({
    queryKey: resourcesKey(profile ?? "", region, service, typeId),
    queryFn: () => api.listResources(profile!, region, service.id, typeId),
    enabled: fetch && !!profile,
    staleTime,
    gcTime: Infinity,
    retry: false,
  });
}

/** 이 프로필로 읽어 둔 모든 리소스 목록의 검색용 사본(리전·종류 전부, 7일 안). 백엔드가 목록을 읽을 때마다 갱신하고 디스크에 남긴다. */
export function useResourceIndex(profile: string | null) {
  return useQuery<IndexedList[], AppError>({
    queryKey: resourceIndexKey(profile ?? ""),
    queryFn: () => api.resourceIndex(profile!),
    enabled: !!profile,
    staleTime: 0,
    retry: false,
  });
}

/** 하드 리셋: 모든 프로필·리전의 리소스 목록 캐시(메모리와 디스크)를 버리고, 지금 보이는 목록은 처음부터 다시 읽는다 */
export async function hardResetResourceCache(qc: QueryClient): Promise<void> {
  await api.clearResourceIndex();
  qc.removeQueries({ queryKey: ["resource-index"] });
  await qc.resetQueries({ queryKey: ["resources"] });
}

export function useS3Objects(profile: string, region: string, bucket: string, prefix: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["s3", profile, bucket, prefix],
    queryFn: ({ pageParam }) => api.listS3Objects(profile, region, bucket, prefix, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextToken,
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

export function useSettings() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["settings"], queryFn: api.getSettings, staleTime: Infinity });
  const update = (patch: Partial<Settings>) => {
    const current = qc.getQueryData<Settings>(["settings"]);
    if (!current) return;
    const next = { ...current, ...patch };
    qc.setQueryData(["settings"], next);
    api.saveSettings(next).catch((err) => {
      console.error("설정을 저장하지 못했어요", err);
      void qc.invalidateQueries({ queryKey: ["settings"] });
    });
  };
  return { settings: query.data, update, isError: query.isError, error: query.error, refetch: query.refetch };
}
