import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { AppError } from "../api/types";
import { iamApi } from "./api";
import type {
  AccessKeyInfo,
  AccessLevel,
  ActionGrant,
  IamOverview,
  PolicyView,
  PrincipalView,
} from "./types";

/** 쿼리 키. 프로필별 데이터는 ["iam", profile, ...] 아래에 두어 한 번에 무효화할 수 있다. */
export const iamKeys = {
  root: (profile: string | null) => ["iam", profile] as const,
  overview: (profile: string | null) => ["iam", profile, "overview"] as const,
  principal: (profile: string, arn: string) => ["iam", profile, "principal", arn] as const,
  actions: (profile: string, arn: string, prefix: string, level: AccessLevel) => ["iam", profile, "actions", arn, prefix, level] as const,
  policy: (profile: string, policyId: string) => ["iam", profile, "policy", policyId] as const,
  keys: (profile: string, userName: string) => ["iam", profile, "keys", userName] as const,
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
