import { useQuery } from "@tanstack/react-query";
import { useSettings } from "../../api/queries";
import { resKey } from "../detail/queries";
import { argoKeys } from "../queries";
import { normalizeUrl } from "../servers";
import type { AppTarget, ResRef } from "../types";
import { opsApi } from "./api";

/** 리소스 액션 목록. 앱이 바뀌면(version) 다시 읽는다: 서버가 상태에 따라 켜고 끄는 액션이 있다. */
export const useResourceActions = (url: string, target: AppTarget, res: ResRef, version: string | null) =>
  useQuery({ queryKey: argoKeys.read(url, target.namespace, target.name, "actions", resKey(res), version), queryFn: () => opsApi.resourceActions(url, target, res), retry: false });

/**
 * 앱의 워크로드 액션(앱 상세의 액션 바). 앱이 바뀌면(version) 다시 읽는다: 서버가 상태에 따라 켜고 끄는 액션이 있다.
 * 읽는 동안 이전 값을 그대로 보여 줘서 버튼이 깜빡이지 않는다.
 */
export const useAppActions = (url: string, target: AppTarget, version: string | null) =>
  useQuery({
    queryKey: argoKeys.read(url, target.namespace, target.name, "appActions", version),
    queryFn: () => opsApi.appActions(url, target),
    retry: false,
    placeholderData: (previous) => previous,
  });

/** kubeconfig context 전체. 파일이 바뀌어도 앱을 다시 열기 전까지는 같은 목록을 쓴다. */
export const useKubeContexts = (enabled = true) => useQuery({ queryKey: ["argocd", "kubeContexts"], queryFn: opsApi.kubeContexts, enabled, retry: false, staleTime: 60_000 });

/** 이 ArgoCD 서버의 in-cluster 대상에 붙을 kubeconfig context(설정). 바꾸면 설정에 저장한다. */
export function useServerKubeContext(url: string) {
  const { settings, update } = useSettings();
  const server = settings?.argocdServers?.find((s) => normalizeUrl(s.url) === normalizeUrl(url));
  const set = (kubeContext: string | null) => {
    if (!settings?.argocdServers) return;
    update({ argocdServers: settings.argocdServers.map((s) => (s === server ? withKubeContext(s, kubeContext) : s)) });
  };
  return { kubeContext: server?.kubeContext ?? null, set, canSet: server !== undefined };
}

/** 서버 항목의 kubeContext를 바꾼 사본(비우면 칸을 뺀다) */
export const withKubeContext = <T extends { kubeContext?: string }>(server: T, kubeContext: string | null): T => {
  const next = { ...server };
  if (kubeContext) next.kubeContext = kubeContext;
  else delete next.kubeContext;
  return next;
};
