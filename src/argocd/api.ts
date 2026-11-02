import { invoke } from "../api/invoke";
import type { ArgoApp, ArgoAppRow, ArgoAppSetRow, ArgoSyncOptions, ArgoTreeNode, ArgocdSession } from "./types";

/** ArgoCD 서버 명령. AWS 프로필과 상관없어 profile 인자가 없다. 토큰은 set_token의 인자로만 나간다. */
export const argocdApi = {
  setToken: (url: string, token: string) => invoke<ArgocdSession>("argocd_set_token", { url, token }),
  forgetToken: (url: string) => invoke<void>("argocd_forget_token", { url }),
  session: (url: string) => invoke<ArgocdSession | null>("argocd_session", { url }),
  apps: (url: string) => invoke<ArgoAppRow[]>("argocd_apps", { url }),
  appsets: (url: string) => invoke<ArgoAppSetRow[]>("argocd_appsets", { url }),
  app: (url: string, namespace: string, name: string) => invoke<ArgoApp>("argocd_app", { url, namespace, name }),
  tree: (url: string, namespace: string, name: string) => invoke<ArgoTreeNode[]>("argocd_tree", { url, namespace, name }),
  refresh: (url: string, namespace: string, name: string, hard: boolean) => invoke<void>("argocd_refresh", { url, namespace, name, hard }),
  sync: (url: string, namespace: string, name: string, options: ArgoSyncOptions) => invoke<void>("argocd_sync", { url, namespace, name, options }),
};
