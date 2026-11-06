/** 서버가 보관한 배포 이력 한 건(성공한 sync만). `argocd_deploy_history` */
export interface DeployRecord {
  namespace: string;
  app: string;
  id: number;
  revision: string | null;
  startedAt: string | null;
  deployedAt: string | null;
}

/** Pod의 요청·제한. CPU는 밀리코어, 메모리는 바이트. 설정하지 않았으면 null */
export interface Bounds {
  cpuRequest: number | null;
  cpuLimit: number | null;
  memoryRequest: number | null;
  memoryLimit: number | null;
}

/** metrics-server를 읽지 못하는 까닭 */
export type UsageUnavailable = "notInstalled" | "forbidden" | "notReady";

/** Pod 하나의 지금 사용량과 요청·제한. 사용량은 metrics-server가 아직 모으지 않은 Pod면 null */
export interface PodReading {
  namespace: string;
  name: string;
  cpuMilli: number | null;
  memoryBytes: number | null;
  bounds: Bounds;
}

export interface AppUsage {
  unavailable: UsageUnavailable | null;
  pods: PodReading[];
}

export interface PodRef {
  namespace: string;
  name: string;
}

/** ArgoCD 컨트롤러 지표에서 라벨을 줄여 합친 시리즈. delta는 앞 읽기 이후 늘어난 양(카운터·히스토그램 부품만) */
export interface PromSeries {
  component: string;
  name: string;
  labels: Record<string, string>;
  value: number;
  delta: number | null;
}

export interface ComponentStatus {
  component: string;
  service: string;
  ok: boolean;
  error: string | null;
  intervalMs: number | null;
}

export interface ControllerScrape {
  /** 읽은 시각(epoch ms) */
  at: number;
  components: ComponentStatus[];
  series: PromSeries[];
}
