/** ApplicationSet·알림 읽기 명령의 응답 모양(argocd_appset_commands.rs와 같다) */

export interface GeneratorInfo {
  kind: string;
  detail: string | null;
}

export interface TemplateInfo {
  name: string | null;
  project: string | null;
  sources: string[];
  destination: string | null;
}

export interface StepInfo {
  /** `키 연산자 값` 한 줄씩 */
  matches: string[];
  /** 한 번에 올릴 수(숫자 또는 "25%") */
  maxUpdate: string | null;
}

export interface StrategyInfo {
  kind: string;
  steps: StepInfo[];
}

export interface AppSetCondition {
  type: string;
  status: string;
  reason: string | null;
  message: string | null;
  lastTransitionTime: string | null;
}

export interface AppSetAppStatus {
  application: string;
  status: string;
  /** 1부터 세는 단계 번호 */
  step: string | null;
  message: string | null;
  lastTransitionTime: string | null;
}

export interface AppSetDetail {
  name: string;
  namespace: string;
  resourceVersion: string;
  /** 편집·저장에 쓰는 매니페스트 */
  yaml: string;
  generators: GeneratorInfo[];
  template: TemplateInfo;
  strategy: StrategyInfo | null;
  preserveResourcesOnDeletion: boolean;
  goTemplate: boolean;
  conditions: AppSetCondition[];
  applicationStatus: AppSetAppStatus[];
}

/** 이 ApplicationSet이 지금 만들어 둔 앱. yaml은 spec이다 */
export interface AppSetApp {
  name: string;
  namespace: string;
  yaml: string;
}

/** generate가 계산한 앱. yaml은 AppSetApp.yaml과 같은 모양(spec)이다 */
export interface GeneratedApp {
  name: string;
  namespace: string;
  project: string | null;
  destination: string | null;
  sources: string[];
  yaml: string;
}

export interface NotificationCatalog {
  services: string[];
  triggers: string[];
  templates: string[];
}
