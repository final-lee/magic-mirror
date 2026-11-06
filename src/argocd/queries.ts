import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../api/errors";
import { argocdApi } from "./api";
import { TOKEN_INVALID, TOKEN_MISSING } from "./text";
import type { ArgoAppRow, ArgoAppSetRow, ArgoTreeWatchEvent, ArgoWatchEvent } from "./types";

/** 서버마다 따로 쌓는다. 토큰을 바꾸거나 지우면 data 아래만 비운다(session은 따로 갱신). */
export const argoKeys = {
  /** 서버 하나에 딸린 모든 것(목록에서 서버를 뺄 때 지운다) */
  server: (url: string) => ["argocd", url] as const,
  session: (url: string) => ["argocd", url, "session"] as const,
  data: (url: string) => ["argocd", url, "data"] as const,
  apps: (url: string) => ["argocd", url, "data", "apps"] as const,
  appsets: (url: string) => ["argocd", url, "data", "appsets"] as const,
  events: (url: string) => ["argocd", url, "events"] as const,
  watch: (url: string, kind: string) => ["argocd", url, "watch", kind] as const,
  /** version은 목록에서 본 resourceVersion: 바뀌면 새 키라 다시 읽는다 */
  app: (url: string, namespace: string, name: string, version: string | null) => ["argocd", url, "data", "app", namespace, name, version] as const,
  appOf: (url: string, namespace: string, name: string) => ["argocd", url, "data", "app", namespace, name] as const,
  tree: (url: string, namespace: string, name: string, version: string | null) => ["argocd", url, "data", "tree", namespace, name, version] as const,
  treeOf: (url: string, namespace: string, name: string) => ["argocd", url, "data", "tree", namespace, name] as const,
  /** 읽기 화면(리소스 상세·diff·이력·sync window·링크)의 한 조각. version은 앱의 resourceVersion: 바뀌면 새 키라 다시 읽는다 */
  read: (url: string, namespace: string, name: string, part: string, ...rest: unknown[]) => ["argocd", url, "data", "read", namespace, name, part, ...rest] as const,
  readOf: (url: string, namespace: string, name: string) => ["argocd", url, "data", "read", namespace, name] as const,
  /** 지표 화면의 읽기 한 조각(배포 이력·사용량·컨트롤러 지표). data 아래라 토큰을 바꾸면 함께 비워진다 */
  metrics: (url: string, part: string, ...rest: unknown[]) => ["argocd", url, "data", "metrics", part, ...rest] as const,
};

/** 목록을 다시 읽는 간격 */
export const POLL_MS = 10_000;

/** 토큰이 없거나 무효라서 난 오류인가(그러면 토큰 폼으로 돌아간다) */
export const isTokenError = (e: unknown) => e !== null && e !== undefined && [TOKEN_INVALID, TOKEN_MISSING].includes(errorMessage(e));

/** 서버의 로그인 상태. 토큰이 없으면 null. enabled가 꺼져 있으면 키체인도 건드리지 않는다. */
export const useSession = (url: string, enabled: boolean) =>
  useQuery({ queryKey: argoKeys.session(url), queryFn: () => argocdApi.session(url), enabled: enabled && url !== "", retry: false, staleTime: Infinity });

type Named = { namespace: string; name: string };
export function mergeArgoWatch<T extends Named>(old: T[] | undefined, event: ArgoWatchEvent<T>): T[] | undefined {
  if (!old) return old;
  if (event.type === "delete") return old.filter((row) => row.namespace !== event.namespace || row.name !== event.name);
  if (event.type !== "upsert") return old;
  const index = old.findIndex((row) => row.namespace === event.row.namespace && row.name === event.row.name);
  if (index < 0) return [...old, event.row];
  return old.map((row, i) => i === index ? event.row : row);
}

function useStream<T extends { type: string }>(enabled: boolean, identity: string, start: (onMessage: (event: T) => void) => Promise<number>, onMessage: (event: T) => void) {
  const startRef = useRef(start);
  const messageRef = useRef(onMessage);
  startRef.current = start;
  messageRef.current = onMessage;
  const [healthy, setHealthy] = useState(false);
  useEffect(() => {
    if (!enabled) { setHealthy(false); return; }
    let gone = false;
    let id: number | null = null;
    let timer: number | undefined;
    let attempt = 0;
    const connect = () => {
      const current = ++attempt;
      let failed = false;
      const fallback = () => {
        if (gone || failed) return;
        failed = true;
        setHealthy(false);
        if (id !== null) { void argocdApi.watchStop(id); id = null; }
        timer = setTimeout(connect, 5000);
      };
      Promise.resolve().then(() => startRef.current((event) => {
        if (gone || failed || current !== attempt) return;
        if (event.type === "error" || event.type === "end") fallback();
        messageRef.current(event);
      })).then((streamId) => {
        if (gone || failed || current !== attempt) { void argocdApi.watchStop(streamId); return; }
        id = streamId;
        setHealthy(true);
      }).catch(fallback);
    };
    connect();
    return () => { gone = true; clearTimeout(timer); if (id !== null) void argocdApi.watchStop(id); };
  }, [enabled, identity]);
  return enabled && healthy;
}

/** 서버당 한 번만 탭에서 호출한다. 기록 이벤트는 events 쿼리를 무효화한다. listener는 캐시를 고치기 전에 모든 메시지를 받는다(알림 규칙 등). */
export function useAppsWatch(url: string, enabled: boolean, listener?: (event: ArgoWatchEvent<ArgoAppRow>) => void) {
  const qc = useQueryClient();
  const healthy = useStream<ArgoWatchEvent<ArgoAppRow>>(enabled, url,
    async (callback) => {
      await qc.fetchQuery({ queryKey: argoKeys.apps(url), queryFn: () => argocdApi.apps(url), staleTime: 0 });
      return argocdApi.watchApps(url, callback);
    },
    (event) => {
      listener?.(event);
      if (event.type === "event") void qc.invalidateQueries({ queryKey: argoKeys.events(url) });
      else if (event.type === "error" || event.type === "end") void qc.invalidateQueries({ queryKey: argoKeys.apps(url) });
      else qc.setQueryData<ArgoAppRow[]>(argoKeys.apps(url), (old) => mergeArgoWatch(old, event));
    });
  useEffect(() => { qc.setQueryData(argoKeys.watch(url, "apps"), healthy); return () => { qc.setQueryData(argoKeys.watch(url, "apps"), false); }; }, [qc, url, healthy]);
}

export function useApps(url: string, live: boolean) {
  const health = useQuery({ queryKey: argoKeys.watch(url, "apps"), queryFn: () => false, enabled: false });
  return useQuery({ queryKey: argoKeys.apps(url), queryFn: () => argocdApi.apps(url), refetchInterval: live && !health.data ? POLL_MS : false, retry: false });
}

export function useAppsets(url: string, live: boolean) {
  const qc = useQueryClient();
  const healthy = useStream<ArgoWatchEvent<ArgoAppSetRow>>(live, url,
    async (callback) => {
      await qc.fetchQuery({ queryKey: argoKeys.appsets(url), queryFn: () => argocdApi.appsets(url), staleTime: 0 });
      return argocdApi.watchAppsets(url, callback);
    },
    (event) => {
      if (event.type === "error" || event.type === "end") void qc.invalidateQueries({ queryKey: argoKeys.appsets(url) });
      else qc.setQueryData<ArgoAppSetRow[]>(argoKeys.appsets(url), (old) => mergeArgoWatch(old, event));
    });
  return useQuery({ queryKey: argoKeys.appsets(url), queryFn: () => argocdApi.appsets(url), refetchInterval: live && !healthy ? POLL_MS : false, retry: false });
}

export const useArgoEvents = (url: string, since: string | null) =>
  useQuery({ queryKey: [...argoKeys.events(url), since], queryFn: () => argocdApi.events(url, since), enabled: !!url });

/** Application 상세. version(목록의 resourceVersion)이 바뀌면 다시 읽는다. */
export const useArgoApp = (url: string, namespace: string, name: string, version: string | null) =>
  useQuery({ queryKey: argoKeys.app(url, namespace, name, version), queryFn: () => argocdApi.app(url, namespace, name), retry: false, staleTime: version === null ? 0 : Infinity,
    placeholderData: (previous, query) => query?.queryKey[1] === url && query.queryKey[4] === namespace && query.queryKey[5] === name ? previous : undefined });

/** 리소스 트리. 파드 상태는 Application의 resourceVersion을 올리지 않을 수 있어 주기적으로도 읽는다. */
export function useArgoTree(url: string, namespace: string, name: string, version: string | null, enabled: boolean, live: boolean) {
  const qc = useQueryClient();
  const healthy = useStream<ArgoTreeWatchEvent>(enabled && live, JSON.stringify([url, namespace, name]),
    async (callback) => {
      await qc.ensureQueryData({ queryKey: argoKeys.tree(url, namespace, name, version), queryFn: () => argocdApi.tree(url, namespace, name) });
      return argocdApi.watchTree(url, namespace, name, callback);
    },
    (event) => {
      if (event.type === "tree") qc.setQueriesData({ queryKey: argoKeys.treeOf(url, namespace, name) }, event.nodes);
      else void qc.invalidateQueries({ queryKey: argoKeys.treeOf(url, namespace, name) });
    });
  return useQuery({
    queryKey: argoKeys.tree(url, namespace, name, version),
    queryFn: () => argocdApi.tree(url, namespace, name),
    enabled,
    refetchInterval: live && !healthy ? POLL_MS : false,
    retry: false,
  });
}
