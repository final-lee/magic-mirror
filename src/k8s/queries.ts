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
export function useK8sContext(target: K8sTarget, kubeconfig: string | null, saved: string | null, enabled = true) {
  return useQuery<K8sContextInfo, AppError>({
    queryKey: k8sKeys.context(target, kubeconfig, saved),
    queryFn: () => k8sApi.context(target, kubeconfig, saved),
    enabled,
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

/**
 * 다시 연결: 감시를 버리고 연결을 닫은 뒤, 세션 쿼리를 초기화한다(resetQueries). 그러면 구독 중인 화면에 알려져
 * 값이 비워져(enabled가 꺼진다) 닫는 동안 감시가 시작되지 않고, 켜져 있는 세션 쿼리는 k8s_open을 다시 불러
 * 새 dataUpdatedAt(sessionEpoch)으로 감시가 한 번 다시 구독된다. 이 새 구독만 새 연결을 쓴다: 감시는 반드시
 * 이 함수(또는 closeK8s)가 dropTarget을 먼저 부른 뒤에 다시 구독해야 한다.
 * 세션에 기대는 나머지 쿼리(권한 등)는 지워서(removeQueries) 닫힌 연결에 다시 묻지 않게 한다. 세션이 다시 열려
 * enabled가 켜지면 새로 읽는다. context 쿼리만 무효화해 kubeconfig를 다시 읽는다.
 */
export async function refreshK8s(qc: QueryClient, target: K8sTarget, ssoProfile: string): Promise<void> {
  watchRegistry.dropTarget(targetKey(target));
  try {
    await k8sApi.close(target, ssoProfile);
  } catch {
    // 이미 닫혔다
  }
  const kindOf = (q: { queryKey: readonly unknown[] }) => q.queryKey[2];
  qc.removeQueries({ queryKey: k8sKeys.root(target), predicate: (q) => kindOf(q) !== "session" && kindOf(q) !== "context" });
  await Promise.all([
    qc.resetQueries({ queryKey: [...k8sKeys.root(target), "session"] }),
    qc.invalidateQueries({ queryKey: [...k8sKeys.root(target), "context"] }),
  ]);
}
