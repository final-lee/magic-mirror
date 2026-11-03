import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { argowfApi } from "./api";
import { ARGOWF_FORBIDDEN, ARGOWF_TOKEN_INVALID, ARGOWF_TOKEN_MISSING } from "./text";
import type { ArgoWfConn, ArgoWfInfo, ArgoWfServerRef, TemplateKind, WfDetail, WfListQuery, WfPage, WfRow, WfTarget } from "./types";
import { applyWatchEvent, flattenPages } from "./wfQuery";

/** 서버마다 따로 쌓는다. 인증을 바꾸거나 지우면 data 아래만 비운다(session은 따로 갱신). */
export const argowfKeys = {
  /** 서버 하나에 딸린 모든 것(목록에서 서버를 뺄 때 지운다) */
  server: (url: string) => ["argowf", url] as const,
  session: (server: ArgoWfServerRef) => ["argowf", server.url, "session", server.context] as const,
  data: (url: string) => ["argowf", url, "data"] as const,
  info: (url: string) => ["argowf", url, "data", "info"] as const,
  /** 목록 조건마다 따로 쌓는다. 앞부분(workflows(url))으로 모든 조건의 목록을 한꺼번에 다시 읽게 할 수 있다 */
  workflows: (url: string) => ["argowf", url, "data", "workflows"] as const,
  workflowPages: (url: string, query: WfListQuery) => ["argowf", url, "data", "workflows", { ...query, continueToken: null }] as const,
  crons: (url: string, namespace: string | null) => ["argowf", url, "data", "crons", namespace] as const,
  templates: (url: string, namespace: string | null) => ["argowf", url, "data", "templates", namespace] as const,
  workflow: (url: string, target: WfTarget) => ["argowf", url, "data", "workflow", target] as const,
  cron: (url: string, namespace: string, name: string) => ["argowf", url, "data", "cron", namespace, name] as const,
  template: (url: string, kind: TemplateKind, namespace: string | null, name: string) => ["argowf", url, "data", "template", kind, namespace, name] as const,
  events: (url: string, namespace: string, name: string) => ["argowf", url, "data", "events", namespace, name] as const,
  roleArn: (url: string, namespace: string, serviceAccount: string) => ["argowf", url, "data", "role", namespace, serviceAccount] as const,
};

/** Workflow 목록을 다시 읽는 간격 */
export const WORKFLOWS_POLL_MS = 5_000;
/** Cron·템플릿·보관함 목록을 다시 읽는 간격 */
export const CATALOG_POLL_MS = 30_000;
/** 실행 중인 Workflow 상세를 다시 읽는 간격(감시가 끊겼을 때) */
export const DETAIL_POLL_MS = 3_000;
/** 감시가 끊긴 뒤 다시 붙기까지 기다리는 시간. 그동안은 폴링으로 읽는다 */
export const WATCH_RETRY_MS = 10_000;

/** 서버가 정한 네임스페이스도 없고 모든 네임스페이스를 읽을 권한도 없어서 난 오류인가(그러면 네임스페이스를 고르게 한다) */
export const isForbidden = (e: unknown) => e !== null && e !== undefined && errorMessage(e) === ARGOWF_FORBIDDEN;

/** 서버가 알려 주는 것이 없을 때(info를 못 읽는 옛 서버) */
export const NO_INFO: ArgoWfInfo = { managedNamespace: null, links: [], columns: [] };

/** 토큰이 없거나 무효라서 난 오류인가(그러면 토큰 폼으로 돌아간다) */
export const isTokenError = (e: unknown) => e !== null && e !== undefined && [ARGOWF_TOKEN_INVALID, ARGOWF_TOKEN_MISSING].includes(errorMessage(e));

/** 서버의 로그인 상태. 토큰 방식인데 저장된 토큰이 없으면 null. enabled가 꺼져 있으면 키체인·exec도 건드리지 않는다.
 * ssoProfile은 context의 exec 프로필(contexts()에서 안다): SSO가 만료됐으면 invoke가 그 프로필로 자동 로그인을 띄운다. */
export const useArgoWfSession = (server: ArgoWfServerRef, ssoProfile: string | null, enabled: boolean) =>
  useQuery({
    queryKey: argowfKeys.session(server),
    queryFn: () => argowfApi.session(server, ssoProfile),
    enabled: enabled && server.url !== "",
    retry: false,
    staleTime: Infinity,
  });

/** 서버 UI 설정(managedNamespace, links, columns). 못 읽으면 호출한 쪽이 NO_INFO로 대신한다 */
export const useArgoWfInfo = (conn: ArgoWfConn, enabled: boolean) =>
  useQuery({ queryKey: argowfKeys.info(conn.url), queryFn: () => argowfApi.info(conn), enabled, retry: false, staleTime: 5 * 60_000 });

/**
 * Workflow 목록 페이지들. 첫 페이지를 읽은 뒤 watch가 켜져 있으면 감시(SSE)로 바뀐 것만 받아 캐시에 반영한다.
 * 감시가 오류·끝으로 끊기면 폴링(5초)으로 돌아가고 10초 뒤 다시 붙는다. live가 꺼지면(탭이 가려지면) 감시도 폴링도 멈춘다.
 * watch가 꺼져 있으면 pollMs마다 다시 읽는다.
 */
export function useWorkflowPages(conn: ArgoWfConn, query: WfListQuery, live: boolean, options: { watch: boolean; pollMs?: number }) {
  const qc = useQueryClient();
  const key = argowfKeys.workflowPages(conn.url, query);
  const [polling, setPolling] = useState(false);
  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => argowfApi.workflows(conn, { ...query, continueToken: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.continueToken ?? undefined,
    refetchInterval: !live ? false : options.watch ? (polling ? WORKFLOWS_POLL_MS : false) : (options.pollMs ?? WORKFLOWS_POLL_MS),
    retry: false,
  });
  const loaded = q.data !== undefined;
  const version = useRef<string | null>(null);
  version.current = q.data?.pages[0]?.resourceVersion ?? null;
  const watchedBefore = useRef(false);
  const queryKeyText = JSON.stringify(key);
  useEffect(() => {
    if (!options.watch || !live || !loaded || polling) return;
    let gone = false;
    let id: number | null = null;
    // 탭이 다시 보일 때 가려져 있는 동안 놓친 것은 한 번 다시 읽어 채운다
    if (watchedBefore.current) void qc.invalidateQueries({ queryKey: key });
    watchedBefore.current = true;
    const fallback = () => {
      if (!gone) setPolling(true);
    };
    Promise.resolve()
      .then(() =>
        argowfApi.watch(conn, query.namespace, query.labelSelector, version.current, (m) => {
          if (gone) return;
          if (m.type === "upsert")
            qc.setQueryData(key, (old: InfiniteData<WfPage> | undefined) => (old ? applyWatchEvent(old, m, query) : old));
          else if (m.type === "delete") void qc.invalidateQueries({ queryKey: argowfKeys.workflows(conn.url) });
          else fallback();
        }),
      )
      .then((n) => {
        if (gone) void argowfApi.watchStop(n);
        else id = n;
      })
      .catch(fallback);
    return () => {
      gone = true;
      if (id !== null) void argowfApi.watchStop(id);
    };
    // query·key는 queryKeyText로 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.url, conn.context, conn.ssoProfile, queryKeyText, options.watch, live, loaded, polling, qc]);
  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(() => setPolling(false), WATCH_RETRY_MS);
    return () => clearTimeout(timer);
  }, [polling]);
  const rows: WfRow[] = flattenPages(q.data);
  return {
    rows,
    error: q.error,
    isError: q.isError,
    isPending: q.isPending,
    hasMore: !!q.hasNextPage,
    isFetchingMore: q.isFetchingNextPage,
    fetchMore: () => void q.fetchNextPage(),
    refetch: () => void q.refetch(),
    /** 감시가 끊겨 폴링으로 읽는 중 */
    polling,
  };
}

export const useCrons = (conn: ArgoWfConn, namespace: string | null, live: boolean) =>
  useQuery({
    queryKey: argowfKeys.crons(conn.url, namespace),
    queryFn: () => argowfApi.crons(conn, namespace),
    refetchInterval: live ? CATALOG_POLL_MS : false,
    retry: false,
  });

export const useTemplates = (conn: ArgoWfConn, namespace: string | null, live: boolean) =>
  useQuery({
    queryKey: argowfKeys.templates(conn.url, namespace),
    queryFn: () => argowfApi.templates(conn, namespace),
    refetchInterval: live ? CATALOG_POLL_MS : false,
    retry: false,
  });

const isActive = (d: WfDetail | undefined) => ["Running", "Pending", ""].includes(d?.row.phase ?? "");

/**
 * Workflow 상세. 보관 Workflow는 한 번만 읽는다. 살아 있는 것은 실행 중·대기·정지 중일 때 감시(`watchWorkflow`)로 받고,
 * 감시가 끊기면 3초 폴링으로 돌아갔다가 10초 뒤 다시 붙는다. 끝난 Workflow는 감시하지 않는다. deleted는 감시 중에 지워졌다는 뜻.
 */
export function useWorkflow(conn: ArgoWfConn, target: WfTarget, live: boolean) {
  const qc = useQueryClient();
  const key = argowfKeys.workflow(conn.url, target);
  const [polling, setPolling] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const isLive = target.kind === "live";
  const q = useQuery({
    queryKey: key,
    queryFn: () => (target.kind === "live" ? argowfApi.workflow(conn, target.namespace, target.name) : argowfApi.archivedWorkflow(conn, target.uid)),
    refetchInterval: (query) => (live && isLive && !deleted && polling && isActive(query.state.data) ? DETAIL_POLL_MS : false),
    retry: false,
  });
  const watching = live && isLive && isActive(q.data) && q.data !== undefined && !polling && !deleted;
  useEffect(() => {
    if (!watching || target.kind !== "live") return;
    let gone = false;
    let id: number | null = null;
    const fallback = () => {
      if (!gone) setPolling(true);
    };
    q.refetch()
      .then(({ data, isError }) => {
        if (gone) return;
        if (isError || !data) {
          fallback();
          return;
        }
        if (!isActive(data)) return;
        return argowfApi.watchWorkflow(conn, target.namespace, target.name, data.row.resourceVersion, (m) => {
          if (gone) return;
          if (m.type === "detail") qc.setQueryData(key, m.detail);
          else if (m.type === "deleted") {
            gone = true;
            if (id !== null) {
              void argowfApi.watchStop(id);
              id = null;
            }
            setDeleted(true);
          } else fallback();
        });
      })
      .then((n) => {
        if (n === undefined) return;
        if (gone) void argowfApi.watchStop(n);
        else id = n;
      })
      .catch(fallback);
    return () => {
      gone = true;
      if (id !== null) void argowfApi.watchStop(id);
    };
    // key·target은 url과 대상으로 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.url, conn.context, conn.ssoProfile, JSON.stringify(target), watching, qc]);
  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(() => setPolling(false), WATCH_RETRY_MS);
    return () => clearTimeout(timer);
  }, [polling]);
  return { ...q, deleted };
}

export const useCron = (conn: ArgoWfConn, namespace: string, name: string, live: boolean) =>
  useQuery({
    queryKey: argowfKeys.cron(conn.url, namespace, name),
    queryFn: () => argowfApi.cron(conn, namespace, name),
    refetchInterval: live ? CATALOG_POLL_MS : false,
    retry: false,
  });

export const useTemplate = (conn: ArgoWfConn, kind: TemplateKind, namespace: string | null, name: string) =>
  useQuery({ queryKey: argowfKeys.template(conn.url, kind, namespace, name), queryFn: () => argowfApi.template(conn, kind, namespace, name), retry: false });
