import { invoke } from "../../api/invoke";
import type { AppTarget, ResRef } from "../types";
import type { KubeContext, ResourceAction } from "./types";

/** ArgoCD 운영 읽기 명령: 리소스 액션 목록, 터미널을 넘길 kubeconfig context 목록 */
export const opsApi = {
  resourceActions: (url: string, target: AppTarget, res: ResRef) => invoke<ResourceAction[]>("argocd_resource_actions", { url, target, res }),
  kubeContexts: () => invoke<KubeContext[]>("argocd_kube_contexts"),
};
