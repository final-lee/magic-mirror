import { useQueryClient } from "@tanstack/react-query";
import { ErrorState } from "../components/ErrorState";
import { refreshK8s } from "./queries";
import type { K8sTarget } from "./types";

interface Props {
  error: unknown;
  target: K8sTarget;
  /** SSO가 만료됐을 때 로그인할 프로필: exec 플러그인이 쓰는 프로필 */
  ssoProfile: string;
  compact?: boolean;
}

/** 실패한 k8s 쿼리를 보이는 상자. 다시 시도와 로그인 뒤 모두 연결을 닫고 다시 읽는다(refreshK8s). */
export function K8sError({ error, target, ssoProfile, compact }: Props) {
  const qc = useQueryClient();
  const retry = () => void refreshK8s(qc, target, ssoProfile);
  return <ErrorState error={error} profile={ssoProfile} compact={compact} onRetry={retry} onLoggedIn={retry} />;
}
