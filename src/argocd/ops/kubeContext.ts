import type { K8sTarget } from "../../k8s/types";
import type { ArgoDestination } from "../types";
import type { KubeContext } from "./types";
import { CTX_IN_CLUSTER_NEEDS_CONTEXT, CTX_NOT_EKS, ctxNoProfile, ctxNone, ctxSavedMissing } from "./text";

/** 앱의 대상 클러스터를 가리키는 kubeconfig context를 찾은 결과 */
export type ContextMatch =
  | { status: "found"; context: KubeContext; by: "server" | "name" | "saved" }
  /** 같은 정도로 맞는 context가 여럿이라 고르게 해야 한다 */
  | { status: "ambiguous"; candidates: KubeContext[] }
  /** 못 찾았다. inCluster면 서버 설정에 context를 정하면 된다 */
  | { status: "none"; reason: string; inCluster: boolean };

const norm = (s: string) => s.trim().replace(/\/+$/, "").toLowerCase();

/**
 * 대상 클러스터 ↔ kube context: 서버 주소가 같으면 그것, 아니면 이름(context·cluster·EKS 클러스터 이름)이 같은 것.
 * in-cluster(`https://kubernetes.default.svc`)는 주소만으로 클러스터를 알 수 없어서 서버 설정에 저장한 context를 쓴다.
 */
export function matchContext(dest: Pick<ArgoDestination, "server" | "name" | "inCluster">, contexts: KubeContext[], saved: string | null): ContextMatch {
  if (dest.inCluster) {
    if (!saved) return { status: "none", reason: CTX_IN_CLUSTER_NEEDS_CONTEXT, inCluster: true };
    const found = contexts.find((c) => c.name === saved);
    return found ? { status: "found", context: found, by: "saved" } : { status: "none", reason: ctxSavedMissing(saved), inCluster: true };
  }
  const named = (c: KubeContext) => dest.name !== null && dest.name !== "" && [c.name, c.cluster, c.eks?.name].includes(dest.name);
  const server = dest.server ? norm(dest.server) : null;
  const byServer = server === null ? [] : contexts.filter((c) => c.server !== null && norm(c.server) === server);
  // 같은 서버를 가리키는 context가 여럿이면 이름까지 맞는 것으로 좁힌다
  const narrowed = byServer.length > 1 && byServer.some(named) ? byServer.filter(named) : byServer;
  if (narrowed.length === 1) return { status: "found", context: narrowed[0], by: "server" };
  if (narrowed.length > 1) return { status: "ambiguous", candidates: narrowed };
  const byName = contexts.filter(named);
  if (byName.length === 1) return { status: "found", context: byName[0], by: "name" };
  if (byName.length > 1) return { status: "ambiguous", candidates: byName };
  return { status: "none", reason: ctxNone(dest.server ?? dest.name ?? ""), inCluster: false };
}

/** EKS 탭을 열 대상. EKS 클러스터가 아니거나 프로필을 알 수 없으면 이유 */
export type ShellTarget = { status: "ready"; target: K8sTarget } | { status: "blocked"; reason: string };

/** context가 가리키는 EKS 클러스터. 프로필은 context의 exec 프로필, 없으면 fallbackProfile(앱에서 고른 프로필) */
export function eksTarget(context: KubeContext, fallbackProfile: string | null): ShellTarget {
  if (!context.eks) return { status: "blocked", reason: CTX_NOT_EKS(context.name) };
  const profile = context.profile ?? fallbackProfile;
  if (!profile) return { status: "blocked", reason: ctxNoProfile(context.name) };
  return { status: "ready", target: { profile, region: context.eks.region, cluster: context.eks.name } };
}
