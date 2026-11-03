import { useQuery, type QueryClient } from "@tanstack/react-query";
import { reportSsoExpired } from "../api/invoke";
import type { AppError } from "../api/types";
import { k8sApi } from "./api";
import { kindKey, targetKey } from "./targets";
import type { K8sContextInfo, K8sKind, K8sMetrics, K8sObjectView, K8sOverview, K8sOverviewSection, K8sRules, K8sSession, K8sTarget, ObjectRef } from "./types";
import { METRICS_INTERVAL_MS } from "./usage";
import { watchRegistry } from "./watchRegistry";

/** 쿼리 키. 대상별 데이터는 모두 ["k8s", targetKey(target), ...] 아래에 두어 한 번에 무효화하거나 지울 수 있다. */
export const k8sKeys = {
  root: (t: K8sTarget) => ["k8s", targetKey(t)] as const,
  context: (t: K8sTarget, kubeconfig: string | null, saved: string | null) => ["k8s", targetKey(t), "context", kubeconfig, saved] as const,
  session: (t: K8sTarget, context: string | null) => ["k8s", targetKey(t), "session", context] as const,
  rules: (t: K8sTarget, context: string | null, namespace: string | null) => ["k8s", targetKey(t), "rules", context, namespace] as const,
  kinds: (t: K8sTarget, context: string | null) => ["k8s", targetKey(t), "kinds", context] as const,
  object: (t: K8sTarget, context: string | null, ref: ObjectRef, resourceVersion: string | null) =>
    ["k8s", targetKey(t), "object", context, kindKey(ref.kind), ref.namespace, ref.name, resourceVersion] as const,
  overview: (t: K8sTarget, context: string | null) => ["k8s", targetKey(t), "overview", context] as const,
  metrics: (t: K8sTarget, context: string | null, namespace: string | null) => ["k8s", targetKey(t), "metrics", context, namespace] as const,
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

/** 클러스터가 내주는 종류. 연결이 바뀌면 refreshK8s가 지운다. */
export function useK8sKinds(target: K8sTarget, context: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<K8sKind[], AppError>({
    queryKey: k8sKeys.kinds(target, context),
    queryFn: () => k8sApi.kinds(target, ssoProfile),
    enabled: enabled && context !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 객체 상세. 목록의 resourceVersion을 키에 넣어, 목록이 바뀌면 상세도 다시 읽는다.
 * 목록 밖의 객체(소유자로 옮겨 간 것)는 resourceVersion이 null이라 30초 동안만 그대로 쓴다.
 */
export function useK8sObject(target: K8sTarget, context: string | null, ref: ObjectRef | null, resourceVersion: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<K8sObjectView, AppError>({
    queryKey: ref ? k8sKeys.object(target, context, ref, resourceVersion) : ["k8s", targetKey(target), "object", "none"],
    queryFn: () => k8sApi.get(target, ref!.kind, ref!.namespace, ref!.name, ssoProfile),
    enabled: enabled && ref !== null && context !== null,
    staleTime: resourceVersion === null ? 30_000 : Infinity,
    retry: false,
  });
}

/** EKS API 쪽 개요 구역. 로그인할 프로필이 앱의 프로필이다(나머지는 kubeconfig의 exec 프로필). */
export const EKS_SECTIONS = new Set<K8sOverviewSection>(["cluster", "nodegroups", "fargate", "addons", "insights"]);

/**
 * 개요. 구역 오류(gaps)는 성공한 응답 안에 있어서 invoke가 SSO 만료를 알리지 못한다. 그래서 실제로 조회가 도는 이 함수에서,
 * 요청을 시작한 시각과 함께 거절된 명령과 같은 길(reportSsoExpired)로 프로필마다 한 번 알린다.
 * 화면이 캐시된 응답을 다시 그릴 때는 이 함수가 돌지 않으니, 로그인 뒤에 낡은 만료를 다시 알리는 일이 없다.
 */
export function useK8sOverview(target: K8sTarget, context: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<K8sOverview, AppError>({
    queryKey: k8sKeys.overview(target, context),
    queryFn: async () => {
      const startedAt = Date.now();
      const overview = await k8sApi.overview(target);
      const expired = new Set<string>();
      for (const g of overview.gaps) {
        if (g.error.kind === "ssoExpired") expired.add(EKS_SECTIONS.has(g.section) ? target.profile : ssoProfile);
      }
      for (const profile of expired) reportSsoExpired(profile, startedAt);
      return overview;
    },
    enabled: enabled && context !== null,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Pod·노드 사용량(metrics-server). `enabled`가 켜져 있는 동안(연결됐고 탭이 보이는 동안) 15초마다 다시 읽는다.
 * 서버가 없거나 권한이 없는 것은 오류가 아니라 응답의 unavailable 사유라서 재시도하지 않는다. 오류(연결 끊김 등)는 사용량 열만 없앤다.
 */
export function useK8sMetrics(target: K8sTarget, context: string | null, namespace: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<K8sMetrics, AppError>({
    queryKey: k8sKeys.metrics(target, context, namespace),
    queryFn: () => k8sApi.metrics(target, namespace, ssoProfile),
    enabled: enabled && context !== null,
    refetchInterval: METRICS_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: METRICS_INTERVAL_MS / 2,
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
