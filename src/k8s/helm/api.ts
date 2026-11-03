import { invoke } from "../../api/invoke";
import type { K8sTarget } from "../types";
import type { HelmChartSource, HelmRelease, HelmReleaseDetail, HelmTool } from "./types";

// 변경(업그레이드·롤백·삭제·설치)은 변경 틀의 k8s_preview·k8s_apply를 그대로 쓴다. 여기는 읽기 명령만 둔다.
// 클러스터를 읽는 명령은 최상위 profile에 exec 플러그인의 프로필을 넣는다(SSO 만료를 그 프로필로 알린다).
export const helmApi = {
  /** helm 실행 파일을 쓸 수 있는지(클러스터와 무관) */
  tool: () => invoke<HelmTool>("k8s_helm_tool", {}),
  /** 릴리스 목록: 릴리스마다 가장 높은 리비전 한 줄. namespace가 null이면 모든 네임스페이스 */
  releases: (target: K8sTarget, namespace: string | null, ssoProfile: string) =>
    invoke<HelmRelease[]>("k8s_helm_releases", { target, namespace, profile: ssoProfile }),
  /** 릴리스 상세와 이력. revision이 null이면 가장 높은 리비전 */
  release: (target: K8sTarget, namespace: string, name: string, revision: number | null, ssoProfile: string) =>
    invoke<HelmReleaseDetail>("k8s_helm_release", { target, namespace, name, revision, profile: ssoProfile }),
  /** 차트의 기본 values(helm show values). 클러스터에 닿지 않는다 */
  showValues: (chart: HelmChartSource) => invoke<string>("k8s_helm_show_values", { chart }),
};
