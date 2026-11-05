import { invoke } from "../../api/invoke";
import type { AppUsage, ControllerScrape, DeployRecord, PodRef } from "./types";

/** ArgoCD 지표 화면 명령 */
export const metricsApi = {
  deployHistory: (url: string) => invoke<DeployRecord[]>("argocd_deploy_history", { url }),
  controllerMetrics: (context: string, namespace: string) => invoke<ControllerScrape>("argocd_controller_metrics", { context, namespace }),
  appUsage: (context: string, pods: PodRef[]) => invoke<AppUsage>("argocd_app_usage", { context, pods }),
};
