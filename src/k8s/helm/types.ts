import type { K8sKindRef } from "../types";

// 백엔드 계약(camelCase)과 같은 모양이다(src-tauri/src/k8s/helm/). 필드는 더하기만 한다.

/** helm 실행 파일을 쓸 수 있는지. 못 쓰면 reason에 이유(변경 단추를 끈다) */
export interface HelmTool {
  available: boolean;
  path: string | null;
  version: string | null;
  reason: string | null;
}

export type HelmDriver = "secret" | "configMap";

/** 목록의 한 줄: 릴리스의 가장 높은 리비전 */
export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  /** 실패했거나 끝나지 않은 작업이 걸려 있다 */
  problem: boolean;
  /** 이름-버전 */
  chart: string;
  chartName: string;
  chartVersion: string;
  appVersion: string;
  updated: string | null;
  description: string;
  /** 저장돼 있는 리비전 수 */
  revisions: number;
  driver: HelmDriver;
  unreadable: boolean;
}

/** 리비전 하나의 요약(이력 표) */
export interface HelmRevision {
  revision: number;
  status: string;
  updated: string | null;
  chart: string;
  chartName: string;
  chartVersion: string;
  appVersion: string;
  description: string;
  unreadable: boolean;
}

export interface HelmDependency {
  name: string;
  version: string;
  repository: string;
}

export interface HelmChartInfo {
  name: string;
  version: string;
  appVersion: string;
  description: string;
  home: string;
  kubeVersion: string;
  deprecated: boolean;
  dependencies: HelmDependency[];
}

export interface HelmHook {
  name: string;
  kind: string;
  events: string[];
}

/** manifest가 만드는 리소스 한 줄. namespace가 없으면 릴리스의 네임스페이스(네임스페이스 종류일 때) */
export interface HelmResource {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string | null;
}

export interface HelmReleaseDetail {
  name: string;
  namespace: string;
  /** 지금 보는 리비전 */
  revision: number;
  /** 저장된 가장 높은 리비전. 변경은 이 리비전에 한다 */
  latest: number;
  status: string;
  problem: boolean;
  description: string;
  firstDeployed: string | null;
  lastDeployed: string | null;
  notes: string;
  chart: HelmChartInfo;
  /** 사용자가 준 values(편집기 시작 글). 없으면 빈 글 */
  userValues: string;
  /** 차트 기본값 위에 사용자 값을 얹은 값 */
  computedValues: string;
  /** Secret 값은 가린 manifest */
  manifest: string;
  resources: HelmResource[];
  hooks: HelmHook[];
  history: HelmRevision[];
  driver: HelmDriver;
}

/**
 * 차트를 가리키는 법. reference는 로컬 경로(절대 경로 또는 ~/), oci://…, 저장소 안의 차트 이름 중 하나.
 * repo는 저장소 주소(차트 이름과 함께).
 */
export interface HelmChartSource {
  reference: string;
  repo: string | null;
  version: string | null;
}

/** 변경 틀(K8sChange)에 더하는 Helm 변경. 대상(kind·namespace·name)은 릴리스다. */
export type HelmChangeVariant =
  /** chart가 null이면 저장된 릴리스에서 차트를 되살려 쓴다. values는 사용자 values 전체(YAML) */
  | { type: "helmUpgrade"; values: string; chart: HelmChartSource | null }
  | { type: "helmRollback"; revision: number }
  | { type: "helmUninstall"; keepHistory: boolean }
  | { type: "helmInstall"; chart: HelmChartSource; values: string; createNamespace: boolean };

/** 변경 틀에서 릴리스를 가리키는 종류(백엔드 helm::release_kind) */
export const HELM_RELEASE_KIND: K8sKindRef = { group: "helm.sh", version: "v1", kind: "Release", plural: "releases", namespaced: true };
