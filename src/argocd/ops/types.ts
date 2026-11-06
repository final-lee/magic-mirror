import type { ResRef } from "../types";

/** 리소스 액션이 받는 인자. 서버가 주는 `type`은 kind, 처음 값은 default */
export interface ActionParam {
  name: string;
  value: string | null;
  kind: string | null;
  default: string | null;
}

/** 리소스에서 실행할 수 있는 액션(서버가 리소스 종류와 상태에 맞게 준다) */
export interface ResourceAction {
  name: string;
  displayName: string | null;
  disabled: boolean;
  iconClass: string | null;
  params: ActionParam[];
}

/** kubeconfig context 하나. EKS 클러스터를 가리키면 eks에 리전과 클러스터 이름이 있다 */
export interface KubeContext {
  name: string;
  cluster: string;
  server: string | null;
  /** exec 플러그인의 AWS 프로필 */
  profile: string | null;
  eks: { region: string; name: string } | null;
}

/** 앱 액션 한 줄: 같은 종류(group·kind)의 리소스들에 같은 이름의 액션이 있으면 묶인다 */
export interface AppActionGroup {
  group: string;
  kind: string;
  action: string;
  displayName: string | null;
  params: ActionParam[];
  resources: { res: ResRef; disabled: boolean }[];
  /** 지금 실행할 수 없는 리소스 수 */
  disabledCount: number;
}
