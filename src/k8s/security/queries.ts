import { useQuery } from "@tanstack/react-query";
import { reportSsoExpired } from "../../api/invoke";
import type { AppError } from "../../api/types";
import { targetKey } from "../targets";
import type { K8sTarget } from "../types";
import { securityApi } from "./api";
import type { SecurityReport, SecuritySection } from "./types";

export const securityKey = (t: K8sTarget, context: string | null) => ["k8s", targetKey(t), "security", context] as const;

/** AWS를 읽는 부분. 로그인할 프로필이 앱의 프로필이다(나머지는 kubeconfig의 exec 프로필). */
export const AWS_SECTIONS = new Set<SecuritySection>(["cluster", "versions", "accessEntries", "nodegroups", "launchTemplates", "instances"]);

/**
 * 보안 점검. 부분 실패(gaps)는 성공한 응답 안에 있어서 invoke가 SSO 만료를 알리지 못한다. 그래서 실제로 조회가 도는 이 함수에서
 * 프로필마다 한 번 알린다(AWS 부분은 앱의 프로필, 쿠버네티스 부분은 kubeconfig의 exec 프로필).
 */
export function useSecurityFindings(target: K8sTarget, context: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<SecurityReport, AppError>({
    queryKey: securityKey(target, context),
    queryFn: async () => {
      const startedAt = Date.now();
      const report = await securityApi.findings(target);
      const expired = new Set<string>();
      for (const g of report.gaps) {
        if (g.error.kind === "ssoExpired") expired.add(AWS_SECTIONS.has(g.section) ? target.profile : ssoProfile);
      }
      for (const profile of expired) reportSsoExpired(profile, startedAt);
      return report;
    },
    enabled: enabled && context !== null,
    staleTime: 60_000,
    retry: false,
  });
}
