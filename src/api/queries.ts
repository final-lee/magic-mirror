import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { AppError, ListResult, ServiceInfo, Settings } from "./types";

export const GLOBAL = "global";

export function resourcesKey(profile: string, region: string, service: ServiceInfo, typeId: string) {
  return ["resources", profile, service.global ? GLOBAL : region, service.id, typeId] as const;
}

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

/** fetch=false면 호출하지 않고 캐시된 값만 돌려준다(즐겨찾기 개수 표시용). */
export function useResources(profile: string | null, region: string, service: ServiceInfo, typeId: string, fetch = true) {
  return useQuery<ListResult, AppError>({
    queryKey: resourcesKey(profile ?? "", region, service, typeId),
    queryFn: () => api.listResources(profile!, region, service.id, typeId),
    enabled: fetch && !!profile,
    staleTime: Infinity,
    retry: false,
  });
}

export function useS3Objects(profile: string, region: string, bucket: string, prefix: string) {
  return useInfiniteQuery({
    queryKey: ["s3", profile, bucket, prefix],
    queryFn: ({ pageParam }) => api.listS3Objects(profile, region, bucket, prefix, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextToken,
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
