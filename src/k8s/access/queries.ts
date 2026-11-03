import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { reportSsoExpired } from "../../api/invoke";
import type { AppError } from "../../api/types";
import { targetKey } from "../targets";
import type { K8sTarget } from "../types";
import { accessApi } from "./api";
import { EKS_SECTIONS } from "./text";
import type { AccessGap, AccessQuery, AccessView, Cell, CellDetail, MatrixPage, MatrixQuery, Subject, WhoCanView, WorkloadView } from "./types";

/** 쿼리 키. ["k8s", 대상, "access", …]: 연결이 바뀌면 refreshK8s가 대상 아래를 한꺼번에 지운다. */
export const accessKeys = {
  root: (t: K8sTarget, context: string | null) => ["k8s", targetKey(t), "access", context] as const,
  view: (t: K8sTarget, context: string | null) => [...accessKeys.root(t, context), "view"] as const,
  matrix: (t: K8sTarget, context: string | null, q: MatrixQuery) => [...accessKeys.root(t, context), "matrix", q] as const,
  cell: (t: K8sTarget, context: string | null, s: Subject, cell: Cell, ns: string | null) => [...accessKeys.root(t, context), "cell", s, cell, ns] as const,
  whoCan: (t: K8sTarget, context: string | null, q: AccessQuery) => [...accessKeys.root(t, context), "who", q] as const,
  workload: (t: K8sTarget, context: string | null) => [...accessKeys.root(t, context), "workload"] as const,
};

/**
 * 구역 오류(gaps)는 성공한 응답 안에 있어서 invoke가 SSO 만료를 알리지 못한다. 실제로 조회가 도는 여기서, 요청을 시작한 시각과 함께
 * 거절된 명령과 같은 길(reportSsoExpired)로 프로필마다 한 번 알린다(개요와 같다).
 */
function reportExpired(gaps: AccessGap[], target: K8sTarget, ssoProfile: string, startedAt: number) {
  const expired = new Set<string>();
  for (const g of gaps) {
    if (g.error.kind === "ssoExpired") expired.add(EKS_SECTIONS.has(g.section) ? target.profile : ssoProfile);
  }
  for (const profile of expired) reportSsoExpired(profile, startedAt);
}

/** 신원 연결과 권한 계산 요약. 읽는 데 몇 초 걸리니 연결이 같은 동안은 다시 읽지 않는다(다시 읽기 단추가 force로 읽는다). */
export function useAccess(target: K8sTarget, context: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<AccessView, AppError>({
    queryKey: accessKeys.view(target, context),
    queryFn: async () => {
      const startedAt = Date.now();
      const view = await accessApi.access(target, false);
      reportExpired(view.gaps, target, ssoProfile, startedAt);
      return view;
    },
    enabled: enabled && context !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/** 권한 표 한 쪽. 필터나 쪽이 바뀌는 동안 이전 쪽을 그대로 보인다. */
export function useAccessMatrix(target: K8sTarget, context: string | null, ssoProfile: string, query: MatrixQuery, enabled: boolean) {
  return useQuery<MatrixPage, AppError>({
    queryKey: accessKeys.matrix(target, context, query),
    queryFn: () => accessApi.matrix(target, query, ssoProfile),
    enabled: enabled && context !== null,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    retry: false,
  });
}

export function useAccessCell(target: K8sTarget, context: string | null, ssoProfile: string, selected: { subject: Subject; cell: Cell; namespace: string | null } | null) {
  return useQuery<CellDetail, AppError>({
    queryKey: selected ? accessKeys.cell(target, context, selected.subject, selected.cell, selected.namespace) : [...accessKeys.root(target, context), "cell", "none"],
    queryFn: () => accessApi.cell(target, selected!.subject, selected!.cell, selected!.namespace, ssoProfile),
    enabled: selected !== null && context !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/** 누가 할 수 있나. 찾기를 누른 요청(query)이 있을 때만 읽는다. */
export function useWhoCan(target: K8sTarget, context: string | null, ssoProfile: string, query: AccessQuery | null) {
  return useQuery<WhoCanView, AppError>({
    queryKey: query ? accessKeys.whoCan(target, context, query) : [...accessKeys.root(target, context), "who", "none"],
    queryFn: () => accessApi.whoCan(target, query!, ssoProfile),
    enabled: query !== null && context !== null,
    staleTime: Infinity,
    retry: false,
  });
}

export function useWorkloadIdentity(target: K8sTarget, context: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<WorkloadView, AppError>({
    queryKey: accessKeys.workload(target, context),
    queryFn: async () => {
      const startedAt = Date.now();
      const view = await accessApi.workloadIdentity(target);
      reportExpired(view.gaps, target, ssoProfile, startedAt);
      return view;
    },
    enabled: enabled && context !== null,
    staleTime: 60_000,
    retry: false,
  });
}
