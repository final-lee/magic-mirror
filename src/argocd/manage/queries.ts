import { useQuery } from "@tanstack/react-query";
import { POLL_MS, argoKeys } from "../queries";
import { manageApi } from "./api";

/** 읽기 조각의 키는 argoKeys.read 아래라, 쓰기가 끝나면 data 전체 무효화로 함께 다시 읽힌다 */
const part = (url: string, namespace: string, name: string, kind: string) => argoKeys.read(url, namespace, name, kind);

/** ApplicationSet 상세. 목록 스트림이 상세를 올리지 않아 보이는 동안 주기적으로 다시 읽는다 */
export const useAppSet = (url: string, namespace: string, name: string, live: boolean) =>
  useQuery({ queryKey: part(url, namespace, name, "appset"), queryFn: () => manageApi.appSet(url, namespace, name), refetchInterval: live ? POLL_MS : false, retry: false });

export const useAppSetEvents = (url: string, namespace: string, name: string, enabled: boolean) =>
  useQuery({ queryKey: part(url, namespace, name, "appset-events"), queryFn: () => manageApi.appSetEvents(url, namespace, name), enabled, retry: false });

export const useAppSetTree = (url: string, namespace: string, name: string, enabled: boolean) =>
  useQuery({ queryKey: part(url, namespace, name, "appset-tree"), queryFn: () => manageApi.appSetTree(url, namespace, name), enabled, retry: false });

/** 미리 보기 비교에 쓰는, 지금 만들어 둔 앱의 spec */
export const useAppSetApps = (url: string, namespace: string, name: string, enabled: boolean) =>
  useQuery({ queryKey: part(url, namespace, name, "appset-apps"), queryFn: () => manageApi.appSetApps(url, namespace, name), enabled, retry: false });

/** 서버에 알림이 설정돼 있지 않으면 실패한다. 화면은 직접 입력으로 내려간다 */
export const useNotificationCatalog = (url: string) =>
  useQuery({ queryKey: [...argoKeys.server(url), "notifications"], queryFn: () => manageApi.notificationCatalog(url), staleTime: 60_000, retry: false });
