import { invoke } from "../../api/invoke";
import type { ArgoTreeNode, ResourceEvent } from "../types";
import type { TextDiff } from "../change/types";
import type { AppSetApp, AppSetDetail, GeneratedApp, NotificationCatalog } from "./types";

/** ApplicationSet·알림 읽기 명령. 저장·삭제 같은 쓰기는 change/ 흐름(argocd_apply)을 쓴다 */
export const manageApi = {
  appSet: (url: string, namespace: string, name: string) => invoke<AppSetDetail>("argocd_appset", { url, namespace, name }),
  appSetEvents: (url: string, namespace: string, name: string) => invoke<ResourceEvent[]>("argocd_appset_events", { url, namespace, name }),
  appSetTree: (url: string, namespace: string, name: string) => invoke<ArgoTreeNode[]>("argocd_appset_tree", { url, namespace, name }),
  appSetApps: (url: string, namespace: string, name: string) => invoke<AppSetApp[]>("argocd_appset_apps", { url, namespace, name }),
  /** 편집한 YAML이 만들 앱을 서버가 계산한다(저장하지 않는다) */
  generate: (url: string, yaml: string) => invoke<GeneratedApp[]>("argocd_appset_generate", { url, yaml }),
  yamlDiff: (oldText: string, newText: string) => invoke<TextDiff>("argocd_yaml_diff", { old: oldText, new: newText }),
  notificationCatalog: (url: string) => invoke<NotificationCatalog>("argocd_notification_catalog", { url }),
};
