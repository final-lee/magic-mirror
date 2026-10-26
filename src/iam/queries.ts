import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { AppError } from "../api/types";
import { iamApi } from "./api";
import type { WhoCanSearch } from "./route";
import type {
  AccessKeyInfo,
  AccessLevel,
  ActionGrant,
  Findings,
  IamOverview,
  LastAccessed,
  PolicyView,
  PrincipalView,
  SimulateResult,
  WhoCanResult,
} from "./types";

/** 쿼리 키. 프로필별 데이터는 ["iam", profile, ...] 아래에 두어 한 번에 무효화할 수 있다. */
export const iamKeys = {
  root: (profile: string | null) => ["iam", profile] as const,
  overview: (profile: string | null) => ["iam", profile, "overview"] as const,
  principal: (profile: string, arn: string) => ["iam", profile, "principal", arn] as const,
  actions: (profile: string, arn: string, prefix: string, level: AccessLevel) => ["iam", profile, "actions", arn, prefix, level] as const,
  policy: (profile: string, policyId: string) => ["iam", profile, "policy", policyId] as const,
  keys: (profile: string, userName: string) => ["iam", profile, "keys", userName] as const,
  findings: (profile: string) => ["iam", profile, "findings"] as const,
  whoCan: (profile: string, action: string, resource: string) => ["iam", profile, "whoCan", action, resource] as const,
  simulate: (profile: string, action: string, resource: string, arns: string[]) => ["iam", profile, "simulate", action, resource, arns] as const,
  lastAccessed: (profile: string, arn: string) => ["iam", profile, "lastAccessed", arn] as const,
  catalog: ["iam", "catalog"] as const,
};

/** 다음 overview 조회를 force=true로 부를 프로필들. 새로 고침이 켜고, 조회가 한 번 쓰면서 끈다. */
const forceNext = new Set<string>();

export function useIamOverview(profile: string | null) {
  return useQuery<IamOverview, AppError>({
    queryKey: iamKeys.overview(profile),
    queryFn: () => iamApi.overview(profile!, forceNext.delete(profile!)),
    enabled: !!profile,
    staleTime: Infinity,
    retry: false,
  });
}

export function usePrincipal(profile: string, arn: string) {
  return useQuery<PrincipalView, AppError>({
    queryKey: iamKeys.principal(profile, arn),
    queryFn: () => iamApi.principal(profile, arn),
    staleTime: Infinity,
    retry: false,
  });
}

export function usePrincipalActions(profile: string, arn: string, prefix: string, level: AccessLevel) {
  return useQuery<ActionGrant[], AppError>({
    queryKey: iamKeys.actions(profile, arn, prefix, level),
    queryFn: () => iamApi.principalActions(profile, arn, prefix, level),
    staleTime: Infinity,
    retry: false,
  });
}

export function usePolicy(profile: string, policyId: string) {
  return useQuery<PolicyView, AppError>({
    queryKey: iamKeys.policy(profile, policyId),
    queryFn: () => iamApi.policy(profile, policyId),
    staleTime: Infinity,
    retry: false,
  });
}

export function useAccessKeys(profile: string, userName: string, enabled = true) {
  return useQuery<AccessKeyInfo[], AppError>({
    queryKey: iamKeys.keys(profile, userName),
    queryFn: () => iamApi.accessKeys(profile, userName),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

export function useFindings(profile: string) {
  return useQuery<Findings, AppError>({
    queryKey: iamKeys.findings(profile),
    queryFn: () => iamApi.findings(profile),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 찾은 조건(search)이 있을 때만 조회한다. 결과는 조건별로 캐시에 남아서,
 * 상세를 보고 돌아와도 같은 검색을 다시 부르지 않고 바로 보여준다.
 */
export function useWhoCan(profile: string, search: WhoCanSearch | null) {
  return useQuery<WhoCanResult, AppError>({
    queryKey: iamKeys.whoCan(profile, search?.action ?? "", search?.resource ?? ""),
    queryFn: () => iamApi.whoCan(profile, search!.action, search!.resource || null),
    enabled: !!search,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * AWS 정책 시뮬레이터 확인. AWS API를 주체마다 부르므로 사용자가 누를 때만(refetch) 돌린다.
 * 받은 결과는 캐시에 남고, ⌘R로 다시 부르지 않는다(비활성 조회는 무효화돼도 자동으로 다시 받지 않는다).
 */
export function useSimulation(profile: string, arns: string[], action: string, resource: string | null) {
  return useQuery<SimulateResult[], AppError>({
    queryKey: iamKeys.simulate(profile, action, resource ?? "", arns),
    queryFn: () => iamApi.simulate(profile, arns, action, resource),
    enabled: false,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 서비스별 마지막 사용 시각(권한 줄이기). AWS 쪽 작업이 10~30초 걸리므로 사용자가 누를 때만(refetch) 돌리고,
 * 받은 결과는 캐시에 남긴다. ⌘R도 이 작업을 자동으로 다시 시작하지 않는다.
 */
export function useLastAccessed(profile: string, arn: string) {
  return useQuery<LastAccessed, AppError>({
    queryKey: iamKeys.lastAccessed(profile, arn),
    queryFn: () => iamApi.lastAccessed(profile, arn),
    enabled: false,
    staleTime: Infinity,
    retry: false,
  });
}

/** 작업 이름 카탈로그(자동 완성용). 앱에 들어 있는 정적 데이터라 다시 부를 필요가 없다. */
export function useIamCatalog() {
  return useQuery<string[], AppError>({
    queryKey: iamKeys.catalog,
    queryFn: iamApi.actions,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * ⌘R: 백엔드 스냅숏을 새로 만들도록 overview를 force=true로 다시 부르고,
 * 그 스냅숏을 읽는 나머지 IAM 쿼리는 overview가 끝난 뒤에 다시 부른다(먼저 부르면 낡은 스냅숏을 읽을 수 있다).
 */
export async function refreshIam(qc: QueryClient, profile: string): Promise<void> {
  forceNext.add(profile);
  try {
    await qc.invalidateQueries({ queryKey: iamKeys.overview(profile) });
  } finally {
    // 구독하는 화면이 없어 조회가 일어나지 않았다면 표시만 남기지 않는다.
    forceNext.delete(profile);
  }
  await qc.invalidateQueries({ queryKey: iamKeys.root(profile), predicate: (q) => q.queryKey[2] !== "overview" });
}
