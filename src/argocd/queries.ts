import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "../api/errors";
import { argocdApi } from "./api";
import { TOKEN_INVALID, TOKEN_MISSING } from "./text";

/** 서버마다 따로 쌓는다. 토큰을 바꾸거나 지우면 data 아래만 비운다(session은 따로 갱신). */
export const argoKeys = {
  session: (url: string) => ["argocd", url, "session"] as const,
  data: (url: string) => ["argocd", url, "data"] as const,
  apps: (url: string) => ["argocd", url, "data", "apps"] as const,
  appsets: (url: string) => ["argocd", url, "data", "appsets"] as const,
  /** version은 목록에서 본 resourceVersion: 바뀌면 새 키라 다시 읽는다 */
  app: (url: string, namespace: string, name: string, version: string | null) => ["argocd", url, "data", "app", namespace, name, version] as const,
  appOf: (url: string, namespace: string, name: string) => ["argocd", url, "data", "app", namespace, name] as const,
  tree: (url: string, namespace: string, name: string, version: string | null) => ["argocd", url, "data", "tree", namespace, name, version] as const,
  treeOf: (url: string, namespace: string, name: string) => ["argocd", url, "data", "tree", namespace, name] as const,
};

/** 목록을 다시 읽는 간격 */
export const POLL_MS = 10_000;

/** 토큰이 없거나 무효라서 난 오류인가(그러면 토큰 폼으로 돌아간다) */
export const isTokenError = (e: unknown) => e !== null && e !== undefined && [TOKEN_INVALID, TOKEN_MISSING].includes(errorMessage(e));

/** 서버의 로그인 상태. 토큰이 없으면 null. enabled가 꺼져 있으면 키체인도 건드리지 않는다. */
export const useSession = (url: string, enabled: boolean) =>
  useQuery({ queryKey: argoKeys.session(url), queryFn: () => argocdApi.session(url), enabled: enabled && url !== "", retry: false, staleTime: Infinity });

/** live가 꺼지면(탭이 가려지면) 주기적으로 다시 읽지 않는다 */
export const useApps = (url: string, live: boolean) =>
  useQuery({ queryKey: argoKeys.apps(url), queryFn: () => argocdApi.apps(url), refetchInterval: live ? POLL_MS : false, retry: false });

export const useAppsets = (url: string, live: boolean) =>
  useQuery({ queryKey: argoKeys.appsets(url), queryFn: () => argocdApi.appsets(url), refetchInterval: live ? POLL_MS : false, retry: false });

/** Application 상세. version(목록의 resourceVersion)이 바뀌면 다시 읽는다. */
export const useArgoApp = (url: string, namespace: string, name: string, version: string | null) =>
  useQuery({ queryKey: argoKeys.app(url, namespace, name, version), queryFn: () => argocdApi.app(url, namespace, name), retry: false, staleTime: version === null ? 0 : Infinity });

/** 리소스 트리. 파드 상태는 Application의 resourceVersion을 올리지 않을 수 있어 주기적으로도 읽는다. */
export const useArgoTree = (url: string, namespace: string, name: string, version: string | null, enabled: boolean, live: boolean) =>
  useQuery({
    queryKey: argoKeys.tree(url, namespace, name, version),
    queryFn: () => argocdApi.tree(url, namespace, name),
    enabled,
    refetchInterval: live ? POLL_MS : false,
    retry: false,
  });
