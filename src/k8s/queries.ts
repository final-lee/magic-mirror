import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { AppError } from "../api/types";
import { k8sApi } from "./api";
import { targetKey } from "./targets";
import type { K8sContextInfo, K8sRules, K8sSession, K8sTarget } from "./types";
import { watchRegistry } from "./watchRegistry";

/** 쿼리 키. 대상별 데이터는 모두 ["k8s", targetKey(target), ...] 아래에 두어 한 번에 무효화하거나 지울 수 있다. */
export const k8sKeys = {
  root: (t: K8sTarget) => ["k8s", targetKey(t)] as const,
  context: (t: K8sTarget, kubeconfig: string | null, saved: string | null) => ["k8s", targetKey(t), "context", kubeconfig, saved] as const,
  session: (t: K8sTarget, context: string | null) => ["k8s", targetKey(t), "session", context] as const,
  rules: (t: K8sTarget, context: string | null, namespace: string | null) => ["k8s", targetKey(t), "rules", context, namespace] as const,
};

/** kubeconfig와 DescribeCluster를 읽는다. 인증 명령은 실행하지 않는다. */
export function useK8sContext(target: K8sTarget, kubeconfig: string | null, saved: string | null) {
  return useQuery<K8sContextInfo, AppError>({
    queryKey: k8sKeys.context(target, kubeconfig, saved),
    queryFn: () => k8sApi.context(target, kubeconfig, saved),
    staleTime: Infinity,
    retry: false,
  });
}

/** 연결. 백엔드의 연결 상태와 짝이라 캐시에 남기지 않는다(usePgOverview와 같다). */
export function useK8sSession(target: K8sTarget, kubeconfig: string | null, context: string | null, ssoProfile: string) {
  return useQuery<K8sSession, AppError>({
    queryKey: k8sKeys.session(target, context),
    queryFn: () => k8sApi.open(target, kubeconfig, context!, ssoProfile),
    enabled: context !== null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

/** 네임스페이스에서 내 권한 목록. 연결된 뒤에만 읽는다(enabled). */
export function useK8sRules(target: K8sTarget, context: string | null, namespace: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<K8sRules, AppError>({
    queryKey: k8sKeys.rules(target, context, namespace),
    queryFn: () => k8sApi.rules(target, namespace!, ssoProfile),
    enabled: enabled && namespace !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** 탭을 닫을 때: 감시를 버리고 연결을 닫고 이 대상의 쿼리를 지운다. 닫기 오류는 무시한다. */
export async function closeK8s(qc: QueryClient, target: K8sTarget, ssoProfile: string): Promise<void> {
  watchRegistry.dropTarget(targetKey(target));
  try {
    await k8sApi.close(target, ssoProfile);
  } catch {
    // 이미 닫혔거나 연결된 적이 없다
  }
  qc.removeQueries({ queryKey: k8sKeys.root(target) });
}

/** 다시 연결: 감시를 버리고 연결을 닫은 뒤 쿼리를 무효화해 context를 다시 읽고 세션을 다시 연다. */
export async function refreshK8s(qc: QueryClient, target: K8sTarget, ssoProfile: string): Promise<void> {
  watchRegistry.dropTarget(targetKey(target));
  try {
    await k8sApi.close(target, ssoProfile);
  } catch {
    // 이미 닫혔다
  }
  await qc.invalidateQueries({ queryKey: k8sKeys.root(target) });
}
