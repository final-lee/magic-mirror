import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { argocdApi } from "../api";
import { rowKey } from "../argoGroup";
import { matchContext, type ContextMatch } from "../ops/kubeContext";
import { useKubeContexts, useServerKubeContext } from "../ops/queries";
import { argoKeys } from "../queries";
import type { ArgoAppRow, ArgoTreeNode } from "../types";
import { destinationOf } from "./appUsage";
import { metricsApi } from "./api";
import { appendPoint, pointOf, type ControllerPoint } from "./controller";
import type { PodRef } from "./types";

/** 컨트롤러 지표를 읽는 간격 */
export const CONTROLLER_POLL_MS = 30_000;
/** 사용량을 다시 읽는 간격(EKS 탭과 같다) */
export const USAGE_POLL_MS = 15_000;
/** 지표 history를 화면이 닫혀 있는 동안에도 들고 있는 시간 */
const HISTORY_KEEP_MS = 60 * 60_000;

/** 서버가 보관한 배포 이력. 한 번 읽으면 1분은 그대로 쓴다 */
export const useDeployHistory = (url: string, enabled: boolean) =>
  useQuery({ queryKey: argoKeys.metrics(url, "history"), queryFn: () => metricsApi.deployHistory(url), enabled, staleTime: 60_000, retry: false });

export interface ControllerData {
  point: ControllerPoint;
  history: ControllerPoint[];
}

/** 컨트롤러 지표. 읽을 때마다 앞 읽기의 기록에 이어 붙인다(메모리에만 둔다). live일 때만 30초마다 읽는다 */
export function useControllerMetrics(url: string, context: string | null, namespace: string, live: boolean) {
  const qc = useQueryClient();
  const key = argoKeys.metrics(url, "controller", context ?? "", namespace);
  return useQuery({
    queryKey: key,
    enabled: live && !!context,
    refetchInterval: live ? CONTROLLER_POLL_MS : false,
    staleTime: CONTROLLER_POLL_MS - 5_000,
    gcTime: HISTORY_KEEP_MS,
    retry: false,
    queryFn: async (): Promise<ControllerData> => {
      const point = pointOf(await metricsApi.controllerMetrics(context as string, namespace));
      return { point, history: appendPoint(qc.getQueryData<ControllerData>(key)?.history ?? [], point) };
    },
  });
}

/** 앱 Pod들의 지금 사용량·요청·제한. 대상 context의 metrics-server를 읽는다 */
export function useAppUsage(url: string, context: string | null, pods: PodRef[], live: boolean) {
  const podsKey = pods.map((p) => `${p.namespace}/${p.name}`).sort().join(",");
  return useQuery({
    queryKey: argoKeys.metrics(url, "usage", context ?? "", podsKey),
    queryFn: () => metricsApi.appUsage(context as string, pods),
    enabled: !!context && pods.length > 0,
    refetchInterval: live ? USAGE_POLL_MS : false,
    retry: false,
  });
}

/** 앱의 리소스 트리(이미 읽은 것과 같은 캐시 키를 쓴다). 파드 상태가 바뀌므로 live면 다시 읽는다 */
export const useAppTree = (url: string, row: ArgoAppRow | null, live: boolean) =>
  useQuery({
    queryKey: argoKeys.tree(url, row?.namespace ?? "", row?.name ?? "", row?.resourceVersion ?? null),
    queryFn: () => argocdApi.tree(url, (row as ArgoAppRow).namespace, (row as ArgoAppRow).name),
    enabled: row !== null,
    refetchInterval: live ? USAGE_POLL_MS : false,
    retry: false,
  });

/** 앱의 대상 클러스터에 붙을 kube context를 찾는 함수. in-cluster는 서버 설정의 context를 쓴다 */
export function useContextFor(url: string) {
  const contexts = useKubeContexts();
  const { kubeContext } = useServerKubeContext(url);
  const resolve = useCallback((row: ArgoAppRow): ContextMatch | null => (contexts.data ? matchContext(destinationOf(row), contexts.data, kubeContext) : null), [contexts.data, kubeContext]);
  return { resolve, contexts: contexts.data ?? [], loading: contexts.isPending, error: contexts.error };
}

/** `limit`개씩 동시에 처리한다. stopped()가 참이 되면 새 일을 시작하지 않는다 */
export async function runPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>, stopped: () => boolean): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!stopped() && next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const TREE_PARALLEL = 4;

/** 아직 트리를 읽지 않은 앱의 리소스 트리를 읽어 캐시에 채운다(이미지·사용량 지표가 쓴다). 실패한 앱은 건너뛴다 */
export function useTreeLoader(url: string, rows: ArgoAppRow[], cached: Set<string>) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);
  const start = useCallback(async () => {
    const todo = rows.filter((r) => !cached.has(rowKey(r.namespace, r.name)));
    stop.current = false;
    let done = 0;
    setProgress({ done, total: todo.length });
    await runPool(todo, TREE_PARALLEL, async (row) => {
      await fetchTree(qc, url, row).catch(() => undefined);
      setProgress({ done: ++done, total: todo.length });
    }, () => stop.current);
    setProgress(null);
  }, [qc, url, rows, cached]);
  return { start, stop: () => { stop.current = true; }, progress };
}

function fetchTree(qc: QueryClient, url: string, row: ArgoAppRow): Promise<ArgoTreeNode[]> {
  return qc.fetchQuery({ queryKey: argoKeys.tree(url, row.namespace, row.name, row.resourceVersion), queryFn: () => argocdApi.tree(url, row.namespace, row.name), staleTime: Infinity });
}
