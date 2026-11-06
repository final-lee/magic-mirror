import { useQuery } from "@tanstack/react-query";
import { POLL_MS, argoKeys } from "../queries";
import type { AppTarget, ResRef } from "../types";
import { readApi } from "./api";

/** 리소스를 가리키는 키(group/kind/namespace/name) */
export const resKey = (r: Pick<ResRef, "group" | "kind" | "namespace" | "name">) => `${r.group}/${r.kind}/${r.namespace ?? ""}/${r.name}`;

/** 리소스 상세(live·desired·diff·컨테이너). 앱이 바뀌면(version) 다시 읽는다. */
export const useResourceView = (url: string, target: AppTarget, res: ResRef, version: string | null) =>
  useQuery({ queryKey: argoKeys.read(url, target.namespace, target.name, "resource", resKey(res), version), queryFn: () => readApi.resource(url, target, res), retry: false });

/** 리소스 이벤트. 보는 동안(live)만 주기적으로 다시 읽는다. */
export const useResourceEvents = (url: string, target: AppTarget, res: ResRef, enabled: boolean, live: boolean) =>
  useQuery({
    queryKey: argoKeys.read(url, target.namespace, target.name, "events", resKey(res), res.uid ?? null),
    queryFn: () => readApi.resourceEvents(url, target, res),
    enabled,
    refetchInterval: live ? POLL_MS : false,
    retry: false,
  });

export const useResourceLinks = (url: string, target: AppTarget, res: ResRef, enabled: boolean) =>
  useQuery({ queryKey: argoKeys.read(url, target.namespace, target.name, "resourceLinks", resKey(res)), queryFn: () => readApi.resourceLinks(url, target, res), enabled, retry: false, staleTime: Infinity });

export const useAppLinks = (url: string, namespace: string, name: string) =>
  useQuery({ queryKey: argoKeys.read(url, namespace, name, "links"), queryFn: () => readApi.appLinks(url, namespace, name), retry: false, staleTime: Infinity });

/** 앱 전체 diff. 앱이 바뀌면(version) 다시 읽는다. */
export const useAppDiff = (url: string, namespace: string, name: string, version: string | null, enabled: boolean) =>
  useQuery({ queryKey: argoKeys.read(url, namespace, name, "diff", version), queryFn: () => readApi.appDiff(url, namespace, name), enabled, retry: false });

/** 배포 이력과 리비전 메타데이터. 새 배포가 있으면(version) 다시 읽는다. */
export const useAppHistory = (url: string, namespace: string, name: string, version: string | null, enabled: boolean) =>
  useQuery({ queryKey: argoKeys.read(url, namespace, name, "history", version), queryFn: () => readApi.history(url, namespace, name), enabled, retry: false });

/** 두 리비전의 렌더 결과 비교. 리비전 내용은 바뀌지 않아 한 번만 읽는다. */
export const useManifestsDiff = (url: string, namespace: string, name: string, from: string[] | null, to: string[] | null) =>
  useQuery({
    queryKey: argoKeys.read(url, namespace, name, "manifestsDiff", from, to),
    queryFn: () => readApi.manifestsDiff(url, namespace, name, from ?? [], to ?? []),
    enabled: from !== null && to !== null,
    retry: false,
    staleTime: Infinity,
  });

/** 작업이 쓴 리비전의 리소스별 sync wave와 hook 종류 */
export const useOperationWaves = (url: string, namespace: string, name: string, revisions: string[], enabled: boolean) =>
  useQuery({ queryKey: argoKeys.read(url, namespace, name, "waves", revisions), queryFn: () => readApi.operationWaves(url, namespace, name, revisions), enabled, retry: false, staleTime: Infinity });

/** sync window. 시간에 따라 바뀌므로 보는 동안(live) 1분마다 다시 읽는다. */
export const useSyncWindows = (url: string, namespace: string, name: string, version: string | null, live: boolean) =>
  useQuery({
    queryKey: argoKeys.read(url, namespace, name, "windows", version),
    queryFn: () => readApi.syncWindows(url, namespace, name),
    refetchInterval: live ? 60_000 : false,
    retry: false,
  });
