import { useQuery } from "@tanstack/react-query";
import type { AppError } from "../api/types";
import { k8sApi } from "./api";
import type { K8sForward } from "./types";

/** 열린 port-forward 목록의 쿼리 키(모든 탭이 같이 쓴다) */
export const FORWARDS_KEY = ["k8s-forwards"] as const;

/** 열린 port-forward 전체. 붙은 Pod와 최근 오류가 바뀔 수 있어 몇 초마다 다시 읽는다. */
export function useK8sForwards(enabled: boolean) {
  return useQuery<K8sForward[], AppError>({
    queryKey: FORWARDS_KEY,
    queryFn: () => k8sApi.forwardList(),
    enabled,
    refetchInterval: 3_000,
    retry: false,
  });
}
