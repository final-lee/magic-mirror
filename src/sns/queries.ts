import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import type { AppError } from "../api/types";
import { snsApi } from "./api";
import type { SnsTopicRef } from "./targets";
import type { SnsAccountOverview, SnsChangeRecord, SnsDiagnosisReport, SnsMessaging, SnsPublicAccessReport, SnsPublishers, SnsTopic, SnsTopicPolicy } from "./types";

/**
 * 쿼리 키. 모두 ["sns", 종류, profile, region, ...] 모양이다.
 * 주제 스냅샷은 주제마다 하나, 역링크(엔드포인트 → 주제)는 엔드포인트 ARN마다 하나.
 */
export const snsKeys = {
  topic: (profile: string, region: string, arn: string) => ["sns", "topic", profile, region, arn] as const,
  diagnosis: (profile: string, region: string, arn: string) => ["sns", "diagnosis", profile, region, arn] as const,
  publishers: (profile: string, region: string, arn: string) => ["sns", "publishers", profile, region, arn] as const,
  subscribed: (profile: string, region: string, endpointArn: string) => ["sns", "subscribed", profile, region, endpointArn] as const,
  /** 이 프로필의 모든 역링크 */
  subscribedAll: (profile: string) => ["sns", "subscribed", profile] as const,
  policy: (profile: string, region: string, arn: string) => ["sns", "policy", profile, region, arn] as const,
  account: (profile: string, region: string) => ["sns", "account", profile, region] as const,
  messaging: (profile: string, region: string) => ["sns", "messaging", profile, region] as const,
  /** 변경 기록은 프로필마다 한 파일이다(주제·리전을 가리지 않는다) */
  changes: (profile: string) => ["sns", "changes", profile] as const,
};

/** 주제 스냅샷. 다른 워크스페이스처럼 저절로 다시 읽지 않고 [다시 읽기]·⌘R이 새로 읽는다. 항목별 읽기 실패는 데이터의 errors에 있다. */
export function useSnsTopic(ref: Pick<SnsTopicRef, "profile" | "region" | "topicArn">) {
  return useQuery<SnsTopic, AppError>({
    queryKey: snsKeys.topic(ref.profile, ref.region, ref.topicArn),
    queryFn: () => snsApi.topic(ref.profile, ref.region, ref.topicArn),
    staleTime: Infinity,
    retry: false,
  });
}

export function useSnsDiagnosis(ref: Pick<SnsTopicRef, "profile" | "region" | "topicArn">) {
  return useQuery<SnsDiagnosisReport, AppError>({
    queryKey: snsKeys.diagnosis(ref.profile, ref.region, ref.topicArn),
    queryFn: () => snsApi.diagnose(ref.profile, ref.region, ref.topicArn),
    staleTime: Infinity,
    retry: false,
  });
}

export function useSnsPublishers(ref: Pick<SnsTopicRef, "profile" | "region" | "topicArn">, deep: boolean) {
  return useQuery<SnsPublishers, AppError>({
    queryKey: [...snsKeys.publishers(ref.profile, ref.region, ref.topicArn), deep],
    queryFn: () => snsApi.publishers(ref.profile, ref.region, ref.topicArn, deep),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 이 엔드포인트(SQS 큐·Lambda 함수 ARN)를 구독한 주제 ARN들. 리소스 상세를 열 때 읽는다. arn이 null이면 읽지 않는다.
 * 계정의 구독 목록을 읽는 일이라 1분 동안은 다시 묻지 않는다.
 */
export function useSnsSubscribedTopics(profile: string, region: string, endpointArn: string | null) {
  return useQuery<string[], AppError>({
    queryKey: snsKeys.subscribed(profile, region, endpointArn ?? ""),
    queryFn: () => snsApi.subscribedTopics(profile, region, endpointArn!),
    enabled: endpointArn !== null,
    staleTime: 60_000,
    retry: false,
  });
}

/** ⌘R·[다시 읽기]: 이 주제의 스냅샷을 다시 읽는다. 읽는 동안에는 이전 값이 화면에 남는다 */
export async function refreshSns(qc: QueryClient, ref: Pick<SnsTopicRef, "profile" | "region" | "topicArn">): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: snsKeys.topic(ref.profile, ref.region, ref.topicArn) }),
    qc.invalidateQueries({ queryKey: snsKeys.diagnosis(ref.profile, ref.region, ref.topicArn) }),
    qc.invalidateQueries({ queryKey: snsKeys.policy(ref.profile, ref.region, ref.topicArn) }),
    qc.invalidateQueries({ queryKey: snsKeys.publishers(ref.profile, ref.region, ref.topicArn) }),
  ]);
}

/** 탭을 닫거나 프로필을 바꿀 때: 이 주제의 스냅샷을 버린다 */
export function forgetSns(qc: QueryClient, ref: Pick<SnsTopicRef, "profile" | "region" | "topicArn">): void {
  qc.removeQueries({ queryKey: snsKeys.topic(ref.profile, ref.region, ref.topicArn) });
  qc.removeQueries({ queryKey: snsKeys.diagnosis(ref.profile, ref.region, ref.topicArn) });
  qc.removeQueries({ queryKey: snsKeys.policy(ref.profile, ref.region, ref.topicArn) });
  qc.removeQueries({ queryKey: snsKeys.publishers(ref.profile, ref.region, ref.topicArn) });
}

/** 주제 정책·점검. 저절로 다시 읽지 않는다. 유료 공개 접근 검사는 여기서 부르지 않는다(버튼이 따로 부른다) */
export function useSnsTopicPolicy(ref: Pick<SnsTopicRef, "profile" | "region" | "topicArn">) {
  return useQuery<SnsTopicPolicy, AppError>({
    queryKey: snsKeys.policy(ref.profile, ref.region, ref.topicArn),
    queryFn: () => snsApi.topicPolicy(ref.profile, ref.region, ref.topicArn),
    staleTime: Infinity,
    retry: false,
  });
}

/** 유료 공개 접근 검사(호출당 $0.002). 호출은 `mutate`를 부르는 버튼뿐이다 */
export function useSnsPublicAccessCheck(ref: Pick<SnsTopicRef, "profile" | "region" | "topicArn">) {
  return useMutation<SnsPublicAccessReport, AppError>({ mutationFn: () => snsApi.checkPublicAccess(ref.profile, ref.region, ref.topicArn) });
}

/** 계정 개요. 지표 읽기에 돈이 들어서(GetMetricData) 저절로 다시 읽지 않고 [다시 읽기]·⌘R이 새로 읽는다 */
export function useSnsAccountOverview(profile: string, region: string) {
  return useQuery<SnsAccountOverview, AppError>({
    queryKey: snsKeys.account(profile, region),
    queryFn: () => snsApi.accountOverview(profile, region),
    staleTime: Infinity,
    retry: false,
  });
}

/** SMS·모바일 푸시 읽기. 계정 개요와 따로 읽어서 한쪽이 실패해도 다른 쪽은 그린다 */
export function useSnsMessaging(profile: string, region: string) {
  return useQuery<SnsMessaging, AppError>({
    queryKey: snsKeys.messaging(profile, region),
    queryFn: () => snsApi.messaging(profile, region),
    staleTime: Infinity,
    retry: false,
  });
}

/** 계정 탭의 ⌘R·[다시 읽기] */
export async function refreshSnsAccount(qc: QueryClient, profile: string, region: string): Promise<void> {
  await Promise.all([qc.invalidateQueries({ queryKey: snsKeys.account(profile, region) }), qc.invalidateQueries({ queryKey: snsKeys.messaging(profile, region) })]);
}

/** 계정 탭을 닫거나 프로필을 바꿀 때: 읽어 둔 개요를 버린다 */
export function forgetSnsAccount(qc: QueryClient, profile: string, region: string): void {
  qc.removeQueries({ queryKey: snsKeys.account(profile, region) });
  qc.removeQueries({ queryKey: snsKeys.messaging(profile, region) });
}

/** 이 프로필의 변경 기록(최신순). 주제 탭의 변경 기록 화면이 자기 주제 것만 걸러서 보여 준다 */
export function useSnsChanges(profile: string) {
  return useQuery<SnsChangeRecord[], AppError>({
    queryKey: snsKeys.changes(profile),
    queryFn: () => snsApi.changes(profile),
    staleTime: Infinity,
    retry: false,
  });
}

/** 변경을 적용한 뒤: 이 주제의 스냅샷·진단·정책과 변경 기록을 다시 읽게 한다(적용이 중간에 실패해도 일부는 바뀌었을 수 있어서 부른다) */
export async function invalidateAfterChange(qc: QueryClient, ref: Pick<SnsTopicRef, "profile" | "region" | "topicArn">): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: snsKeys.topic(ref.profile, ref.region, ref.topicArn) }),
    qc.invalidateQueries({ queryKey: snsKeys.diagnosis(ref.profile, ref.region, ref.topicArn) }),
    qc.invalidateQueries({ queryKey: snsKeys.policy(ref.profile, ref.region, ref.topicArn) }),
    qc.invalidateQueries({ queryKey: snsKeys.changes(ref.profile) }),
  ]);
}
