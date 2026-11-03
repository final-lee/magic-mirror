import { useQuery } from "@tanstack/react-query";
import { reportSsoExpired } from "../../api/invoke";
import type { AppError } from "../../api/types";
import { targetKey } from "../targets";
import type { K8sTarget } from "../types";
import { networkApi } from "./api";
import type { Network, NetworkSection } from "./types";

export const networkKey = (t: K8sTarget, context: string | null) => ["k8s", targetKey(t), "network", context] as const;

/** AWS를 읽는 부분. 로그인할 프로필이 앱의 프로필이다(나머지는 kubeconfig의 exec 프로필). */
export const AWS_SECTIONS = new Set<NetworkSection>(["cluster", "instances", "subnets", "loadBalancers", "listeners", "targetGroups", "targetHealth"]);

/**
 * 네트워크 화면. 부분 실패(gaps)는 성공한 응답 안에 있어서 invoke가 SSO 만료를 알리지 못한다. 그래서 개요와 같이
 * 실제로 조회가 도는 이 함수에서 프로필마다 한 번 알린다(로드 밸런서 상세의 gaps도 본다).
 */
export function useK8sNetwork(target: K8sTarget, context: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<Network, AppError>({
    queryKey: networkKey(target, context),
    queryFn: async () => {
      const startedAt = Date.now();
      const network = await networkApi.network(target);
      const gaps = [...network.gaps, ...(network.loadBalancers ?? []).flatMap((r) => r.loadBalancer?.gaps ?? [])];
      const expired = new Set<string>();
      for (const g of gaps) {
        if (g.error.kind === "ssoExpired") expired.add(AWS_SECTIONS.has(g.section) ? target.profile : ssoProfile);
      }
      for (const profile of expired) reportSsoExpired(profile, startedAt);
      return network;
    },
    enabled: enabled && context !== null,
    staleTime: 60_000,
    retry: false,
  });
}
