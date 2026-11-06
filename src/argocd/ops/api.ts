import { invoke } from "../../api/invoke";
import type { AppTarget, ResRef } from "../types";
import type { AppActionGroup, KubeContext, ResourceAction } from "./types";

/** ArgoCD 운영 읽기 명령: 리소스 액션 목록, 터미널을 넘길 kubeconfig context 목록 */
export const opsApi = {
  resourceActions: (url: string, target: AppTarget, res: ResRef) => invoke<ResourceAction[]>("argocd_resource_actions", { url, target, res }),
  /** 앱이 관리하는 리소스에서 할 수 있는 액션을 종류·이름별로 묶은 것 */
  appActions: (url: string, target: AppTarget) => invoke<AppActionGroup[]>("argocd_app_actions", { url, target }),
  kubeContexts: () => invoke<KubeContext[]>("argocd_kube_contexts"),
};
