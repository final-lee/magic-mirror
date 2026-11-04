import { useQuery } from "@tanstack/react-query";
import type { AppError } from "../../api/types";
import { targetKey } from "../targets";
import type { K8sTarget } from "../types";
import { helmApi } from "./api";
import type { HelmRelease, HelmReleaseDetail, HelmTool } from "./types";

/** 목록과 상세를 다시 읽는 간격. 변경 직후에는 invalidate로 바로 다시 읽는다 */
export const HELM_INTERVAL_MS = 10_000;

/** 대상별 Helm 데이터는 모두 ["k8s", targetKey, "helm", ...] 아래에 둔다(연결을 지우면 같이 지워진다). */
export const helmKeys = {
  root: (t: K8sTarget) => ["k8s", targetKey(t), "helm"] as const,
  tool: ["k8s-helm-tool"] as const,
  releases: (t: K8sTarget, context: string | null, namespace: string | null) => ["k8s", targetKey(t), "helm", "releases", context, namespace] as const,
  release: (t: K8sTarget, context: string | null, namespace: string, name: string, revision: number | null) =>
    ["k8s", targetKey(t), "helm", "release", context, namespace, name, revision] as const,
};

/** helm 실행 파일. 없으면 변경 단추를 끈다(사용자가 설치하면 다시 열 때 읽는다) */
export function useHelmTool() {
  return useQuery<HelmTool, AppError>({ queryKey: helmKeys.tool, queryFn: helmApi.tool, staleTime: 60_000, retry: false });
}

/** 릴리스 목록. 보이는 동안 10초마다 다시 읽는다(탭이 가려지면 읽지 않는다). */
export function useHelmReleases(target: K8sTarget, context: string | null, namespace: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<HelmRelease[], AppError>({
    queryKey: helmKeys.releases(target, context, namespace),
    queryFn: () => helmApi.releases(target, namespace, ssoProfile),
    enabled: enabled && context !== null,
    refetchInterval: HELM_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: HELM_INTERVAL_MS / 2,
    retry: false,
  });
}

/** 릴리스 상세. revision이 null이면 최신 리비전 */
export function useHelmRelease(target: K8sTarget, context: string | null, namespace: string, name: string, revision: number | null, ssoProfile: string, enabled: boolean) {
  return useQuery<HelmReleaseDetail, AppError>({
    queryKey: helmKeys.release(target, context, namespace, name, revision),
    queryFn: () => helmApi.release(target, namespace, name, revision, ssoProfile),
    enabled: enabled && context !== null,
    refetchInterval: HELM_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: HELM_INTERVAL_MS / 2,
    retry: false,
  });
}
