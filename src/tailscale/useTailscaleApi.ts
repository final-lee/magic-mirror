import { useQuery } from "@tanstack/react-query";
import { useSettings } from "../api/queries";
import { tailscaleApi } from "./api";

/** 설정의 테일넷에 키체인 자격 증명이 있는지 묻는 쿼리의 키. 연결·지우기 뒤에 이 키를 무효화한다. */
export const apiStatusKey = ["tailscale", "api-status"] as const;

/** 설정의 테일넷과 그 키체인 자격 증명 상태(종류 포함). 연결 탭이 쓴다. */
export function useApiStatus() {
  const { settings } = useSettings();
  const tailnet = settings?.tailscaleTailnet || null;
  const query = useQuery({
    queryKey: [...apiStatusKey, tailnet],
    queryFn: () => tailscaleApi.apiStatus(tailnet),
    enabled: tailnet !== null,
    staleTime: Infinity,
    retry: false,
  });
  return {
    tailnet,
    kind: query.data?.kind ?? null,
    isLoading: settings === undefined || (tailnet !== null && query.isLoading),
    error: query.error,
  };
}

/**
 * 연결 탭에서 등록한 Tailscale API 상태. 기기·경로·정책·키·로그 보기가 API를 부르기 전에 확인한다.
 * - `tailnet`: 설정에 등록한 테일넷(없으면 null). API 명령에는 이 이름을 넘긴다.
 * - `connected`: 그 테일넷의 자격 증명이 키체인에 있다.
 * - `isLoading`: 설정이나 키체인 확인이 아직 끝나지 않았다.
 */
export function useTailscaleApi(): { tailnet: string | null; connected: boolean; isLoading: boolean } {
  const { tailnet, kind, isLoading } = useApiStatus();
  return { tailnet, connected: tailnet !== null && kind !== null, isLoading };
}
