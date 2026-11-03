import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { argowfApi } from "./api";
import { CATALOG_POLL_MS } from "./queries";
import type { ArgoWfConn, ManifestKind, WfListQuery } from "./types";

export const useArchivedPages = (conn: ArgoWfConn, query: WfListQuery, live: boolean) =>
  useInfiniteQuery({
    queryKey: ["argowf", conn.url, "data", "archive-pages", query],
    queryFn: ({ pageParam }) => argowfApi.archived(conn, { ...query, continueToken: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.continueToken ?? undefined,
    refetchInterval: live ? CATALOG_POLL_MS : false,
    retry: false,
  });

export const useEventBindings = (conn: ArgoWfConn, namespace: string | null, live: boolean) =>
  useQuery({
    queryKey: ["argowf", conn.url, "data", "bindings", namespace],
    queryFn: () => argowfApi.eventBindings(conn, namespace),
    refetchInterval: live ? CATALOG_POLL_MS : false,
    retry: false,
  });
export const useEventSources = (conn: ArgoWfConn, namespace: string | null, live: boolean, enabled = true) =>
  useQuery({
    queryKey: ["argowf", conn.url, "data", "sources", namespace],
    queryFn: () => argowfApi.eventSources(conn, namespace),
    enabled,
    refetchInterval: live ? CATALOG_POLL_MS : false,
    retry: false,
  });
export const useSensors = (conn: ArgoWfConn, namespace: string | null, live: boolean, enabled = true) =>
  useQuery({
    queryKey: ["argowf", conn.url, "data", "sensors", namespace],
    queryFn: () => argowfApi.sensors(conn, namespace),
    enabled,
    refetchInterval: live ? CATALOG_POLL_MS : false,
    retry: false,
  });
export const usePlugins = (conn: ArgoWfConn, namespace: string | null, live: boolean) =>
  useQuery({
    queryKey: ["argowf", conn.url, "data", "plugins", namespace],
    queryFn: () => argowfApi.plugins(conn, namespace),
    enabled: !!conn.context,
    refetchInterval: live ? CATALOG_POLL_MS : false,
    retry: false,
  });
export const useUserInfo = (conn: ArgoWfConn) =>
  useQuery({ queryKey: ["argowf", conn.url, "data", "userinfo"], queryFn: () => argowfApi.userInfo(conn), retry: false });
export const useManifest = (conn: ArgoWfConn, kind: ManifestKind, namespace: string | null, name: string) =>
  useQuery({
    queryKey: ["argowf", conn.url, "data", "manifest", kind, namespace, name],
    queryFn: () => argowfApi.manifest(conn, kind, namespace, name),
    retry: false,
  });
