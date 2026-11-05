import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../../api/invoke";
import type { K8sLogMessage } from "../../k8s/types";
import type { AppDiffRow, AppTarget, ArgoHistoryEntry, ArgoLogOptions, ArgoWave, LinkRow, ResRef, ResourceEvent, ResourceView, SyncWindows } from "../types";
import type { TextDiff } from "../change/types";

/** ArgoCD 읽기 명령: 리소스 상세·이벤트·링크, 앱 diff, 이력과 리비전 비교, sync window, 로그 */
export const readApi = {
  resource: (url: string, target: AppTarget, res: ResRef) => invoke<ResourceView>("argocd_resource", { url, target, res }),
  resourceEvents: (url: string, target: AppTarget, res: ResRef) => invoke<ResourceEvent[]>("argocd_resource_events", { url, target, res }),
  resourceLinks: (url: string, target: AppTarget, res: ResRef) => invoke<LinkRow[]>("argocd_resource_links", { url, target, res }),
  appLinks: (url: string, namespace: string, name: string) => invoke<LinkRow[]>("argocd_app_links", { url, namespace, name }),
  appDiff: (url: string, namespace: string, name: string) => invoke<AppDiffRow[]>("argocd_app_diff", { url, namespace, name }),
  history: (url: string, namespace: string, name: string) => invoke<ArgoHistoryEntry[]>("argocd_history", { url, namespace, name }),
  /** 두 리비전의 렌더 결과 비교. 소스가 여럿이면 소스 순서대로 모두 넣는다 */
  manifestsDiff: (url: string, namespace: string, name: string, fromRevisions: string[], toRevisions: string[]) =>
    invoke<TextDiff>("argocd_manifests_diff", { url, namespace, name, fromRevisions, toRevisions }),
  operationWaves: (url: string, namespace: string, name: string, revisions: string[]) => invoke<ArgoWave[]>("argocd_operation_waves", { url, namespace, name, revisions }),
  syncWindows: (url: string, namespace: string, name: string) => invoke<SyncWindows>("argocd_sync_windows", { url, namespace, name }),
  /** 앱 로그. 메시지는 EKS 로그와 같은 모양이다. 반환값은 logsStop에 넘기는 번호 */
  logs: (url: string, target: AppTarget, options: ArgoLogOptions, onMessage: (m: K8sLogMessage) => void) => {
    const onEvent = new Channel<K8sLogMessage>();
    onEvent.onmessage = onMessage;
    return invoke<number>("argocd_logs", { url, target, options, onEvent });
  },
  logsStop: (id: number) => invoke<void>("argocd_logs_stop", { id }),
};
