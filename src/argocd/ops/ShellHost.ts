import { createContext } from "react";
import type { K8sTarget } from "../../k8s/types";

/** Pod 셸 하나: EKS 탭이 이 Pod의 셸 탭을 연다 */
export interface ShellRequest {
  namespace: string;
  pod: string;
  container: string | null;
}

/**
 * ArgoCD 탭이 EKS 탭으로 터미널을 넘길 때 쓰는, 앱(App)이 주는 기능.
 * profile은 앱에서 고른 AWS 프로필: context에서 프로필을 알 수 없을 때 쓴다. 없으면(테스트·다른 화면) 터미널 버튼이 없다.
 */
export interface ShellHost {
  profile: string | null;
  open: (target: K8sTarget, shell: ShellRequest) => void;
}

export const ArgoShellContext = createContext<ShellHost | null>(null);
