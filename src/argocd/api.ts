import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../api/invoke";
import type { ArgoApp, ArgoAppRow, ArgoAppSetRow, ArgoEvent, ArgoTreeNode, ArgoTreeWatchEvent, ArgoWatchEvent, ArgocdSession } from "./types";

function stream<T>(command: string, args: Record<string, unknown>, callback: (event: T) => void) {
  const onEvent = new Channel<T>();
  onEvent.onmessage = callback;
  return invoke<number>(command, { ...args, onEvent });
}

/** ArgoCD 서버 명령. AWS 프로필과 상관없어 profile 인자가 없다. 토큰은 set_token의 인자로만 나간다. */
export const argocdApi = {
  setToken: (url: string, token: string) => invoke<ArgocdSession>("argocd_set_token", { url, token }),
  forgetToken: (url: string) => invoke<void>("argocd_forget_token", { url }),
  session: (url: string) => invoke<ArgocdSession | null>("argocd_session", { url }),
  apps: (url: string) => invoke<ArgoAppRow[]>("argocd_apps", { url }),
  appsets: (url: string) => invoke<ArgoAppSetRow[]>("argocd_appsets", { url }),
  app: (url: string, namespace: string, name: string) => invoke<ArgoApp>("argocd_app", { url, namespace, name }),
  tree: (url: string, namespace: string, name: string) => invoke<ArgoTreeNode[]>("argocd_tree", { url, namespace, name }),
  watchApps: (url: string, callback: (event: ArgoWatchEvent<ArgoAppRow>) => void) => stream("argocd_watch_apps", { url }, callback),
  watchAppsets: (url: string, callback: (event: ArgoWatchEvent<ArgoAppSetRow>) => void) => stream("argocd_watch_appsets", { url }, callback),
  watchTree: (url: string, namespace: string, name: string, callback: (event: ArgoTreeWatchEvent) => void) => stream("argocd_watch_tree", { url, namespace, name }, callback),
  watchStop: (id: number) => invoke<void>("argocd_watch_stop", { id }),
  events: (url: string, since: string | null) => invoke<ArgoEvent[]>("argocd_events", { url, since }),
};
