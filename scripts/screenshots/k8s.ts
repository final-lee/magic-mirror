// 데모용 EKS 탭(☸️) 명령 흉내: k8s_* 명령과 EKS 목록.
// 클러스터 하나(prod-apne2)의 노드·Pod·워크로드를 코드로 만들어 두고, 거기서 목록·상세·사용량·로그·개요를 모두 뽑아 낸다.
// 사용량 그래프의 기록(1시간)은 앱이 15초마다 모은 값으로만 채워지므로, 첫 사용량 요청에서 지난 1시간치를 recordUsage로 미리 채운다.
import { stringify } from "yaml";
import { BUILTIN, DAEMONSETS, DEPLOYMENTS, JOBS, CRONJOBS, NODES, PODS, REPLICASETS, STATEFULSETS } from "../../src/k8s/kinds";
import { historyKey, recordUsage } from "../../src/k8s/usageHistory";
import type {
  K8sChange, K8sCondition, K8sContainer, K8sEvent, K8sKind, K8sKindRef, K8sLink, K8sLogLine, K8sLogMessage, K8sLogOptions, K8sMetrics,
  K8sNodeView, K8sObjectView, K8sOverview, K8sPodUsage, K8sPreview, K8sProblem, K8sRow, K8sRules, K8sTarget, K8sWatchMessage,
} from "../../src/k8s/types";
import type {
  AccessQuery, AccessView, BindingRef, Cell, CellDetail, Grant, MappingRow, MatrixPage, MatrixQuery, PolicyGrant, ProbeResult, RoleView, Subject, Via, WhoCan, WhoCanView, WorkloadIdentity, WorkloadView,
} from "../../src/k8s/access/types";
import type { HelmRelease, HelmReleaseDetail, HelmResource, HelmRevision } from "../../src/k8s/helm/types";
import type {
  LbRow, LoadBalancerView, Network, NodeNet, PodNet, PolicyRule, PolicyView, SubnetNet, TargetGroupView, TargetView,
} from "../../src/k8s/network/types";
import type { CheckId, Finding, Fix, SecurityReport, Severity } from "../../src/k8s/security/types";

type Args = Record<string, any>;

const ACCOUNT = "123456789012";
const REGION = "ap-northeast-2";
const CLUSTER = "prod-apne2";
const CONTEXT = "prod-apne2";
const CLUSTER_ARN = `arn:aws:eks:${REGION}:${ACCOUNT}:cluster/${CLUSTER}`;
const ENDPOINT = "https://8F3A27C41B9D5E60A1C7D2B3E4F58901.gr7.ap-northeast-2.eks.amazonaws.com";
const OIDC = "https://oidc.eks.ap-northeast-2.amazonaws.com/id/8F3A27C41B9D5E60A1C7D2B3E4F58901";
const NS = "commerce-prod";

const ECR = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com`;
const SYS = `602401143452.dkr.ecr.${REGION}.amazonaws.com`;

const NOW0 = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;
const MI = 1024 * 1024;
const iso = (ms: number) => new Date(ms).toISOString();

/** get_settings에 더할 값 */
export const k8sSettings: Record<string, unknown> = {
  k8sContexts: { [CLUSTER_ARN]: CONTEXT },
  k8sLaneWidths: { nav: 126, tree: 150, detailPct: 19 },
  k8sBookmarks: [PODS, DEPLOYMENTS, STATEFULSETS, NODES, CRONJOBS].map(({ group, version, kind, plural, namespaced }) => ({ group, version, kind, plural, namespaced })),
};

// ── 난수 ────────────────────────────────────────────────────────────────

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAME_CHARS = "bcdfghjklmnpqrstvwxz2456789";
function suffix(seed: string, n = 5, chars = NAME_CHARS): string {
  const r = rng(fnv(seed));
  return Array.from({ length: n }, () => chars[Math.floor(r() * chars.length)]).join("");
}

// ── 노드 ────────────────────────────────────────────────────────────────

interface NodeSpec {
  name: string;
  zone: string;
  subnet: number;
  instanceType: string;
  groupKind: "managed" | "karpenter";
  group: string;
  kubelet: string;
  cpu: number;
  cordoned: boolean;
  ageDays: number;
}

const host = (ip: string) => `ip-${ip.replace(/\./g, "-")}.${REGION}.compute.internal`;
const NODE_SPECS: NodeSpec[] = [
  { name: host("10.0.11.84"), zone: "ap-northeast-2a", subnet: 11, instanceType: "m6i.xlarge", groupKind: "managed", group: "general-purpose", kubelet: "v1.31.4-eks-aeac579", cpu: 4000, cordoned: false, ageDays: 19 },
  { name: host("10.0.12.157"), zone: "ap-northeast-2b", subnet: 12, instanceType: "m6i.xlarge", groupKind: "managed", group: "general-purpose", kubelet: "v1.31.4-eks-aeac579", cpu: 4000, cordoned: false, ageDays: 19 },
  { name: host("10.0.13.212"), zone: "ap-northeast-2c", subnet: 13, instanceType: "m6i.xlarge", groupKind: "managed", group: "general-purpose", kubelet: "v1.31.4-eks-aeac579", cpu: 4000, cordoned: false, ageDays: 19 },
  { name: host("10.0.12.33"), zone: "ap-northeast-2b", subnet: 12, instanceType: "c6i.xlarge", groupKind: "karpenter", group: "default", kubelet: "v1.31.4-eks-aeac579", cpu: 4000, cordoned: false, ageDays: 2 },
  { name: host("10.0.13.98"), zone: "ap-northeast-2c", subnet: 13, instanceType: "c6i.xlarge", groupKind: "karpenter", group: "default", kubelet: "v1.31.4-eks-aeac579", cpu: 4000, cordoned: false, ageDays: 2 },
  { name: host("10.0.12.250"), zone: "ap-northeast-2b", subnet: 12, instanceType: "m5.xlarge", groupKind: "managed", group: "legacy-v130", kubelet: "v1.30.8-eks-aeac579", cpu: 4000, cordoned: true, ageDays: 61 },
];
const SCHEDULABLE = NODE_SPECS.filter((n) => !n.cordoned);
const small = (n: NodeSpec) => n.instanceType === "c6i.xlarge";
const allocOf = (n: NodeSpec) => ({ cpuMilli: 3920, memoryBytes: (small(n) ? 6_900 : 14_600) * MI, pods: 58 });
const capacityOf = (n: NodeSpec) => ({ cpuMilli: n.cpu, memoryBytes: (small(n) ? 7_700 : 15_700) * MI, pods: 58 });

// ── 워크로드와 Pod ──────────────────────────────────────────────────────

interface Ctr {
  name: string;
  image: string;
  cpuReq?: number;
  cpuLim?: number;
  memReq?: number; // MiB
  memLim?: number; // MiB
  cpu: number; // 평소 사용량(밀리코어)
  mem: number; // 평소 사용량(MiB)
  port?: number;
}

type WlKind = "Deployment" | "StatefulSet" | "DaemonSet" | "Job";
type Shape = "web" | "flat" | "crash" | "pending" | "done";

interface Wl {
  ns: string;
  name: string;
  kind: WlKind;
  replicas: number;
  ctrs: Ctr[];
  podAgeH: number;
  shape: Shape;
  hash?: string;
  /** Pod 이름 끝(없으면 이름으로 만든다) */
  suffixes?: string[];
  /** Job의 CronJob */
  cron?: string;
}

const ctr = (name: string, image: string, cpuReq: number | undefined, cpuLim: number | undefined, memReq: number | undefined, memLim: number | undefined, cpu: number, mem: number, port?: number): Ctr =>
  ({ name, image, cpuReq, cpuLim, memReq, memLim, cpu, mem, port });

const OTEL = (cpu = 22, mem = 71) => ctr("otel-agent", "otel/opentelemetry-collector-contrib:0.112.0", 50, 200, 64, 128, cpu, mem);

const WORKLOADS: Wl[] = [
  { ns: NS, name: "web-frontend", kind: "Deployment", replicas: 3, podAgeH: 52, shape: "web", ctrs: [ctr("web", `${ECR}/web-frontend:v2.41.0`, 250, 1000, 384, 768, 185, 318, 3000)] },
  { ns: NS, name: "api-gateway", kind: "Deployment", replicas: 3, podAgeH: 52, shape: "web", ctrs: [ctr("gateway", `${ECR}/api-gateway:v1.18.3`, 300, 1000, 384, 640, 262, 300, 8080)] },
  { ns: NS, name: "orders-api", kind: "Deployment", replicas: 3, podAgeH: 6, shape: "web", hash: "6d8f7b9c54", suffixes: ["h9k4t", "m2x7q", "w5pzd"], ctrs: [ctr("orders-api", `${ECR}/orders-api:v3.7.2`, 500, 1000, 640, 1024, 372, 560, 8080), OTEL()] },
  { ns: NS, name: "catalog-api", kind: "Deployment", replicas: 2, podAgeH: 52, shape: "web", ctrs: [ctr("catalog-api", `${ECR}/catalog-api:v2.9.0`, 250, 500, 384, 640, 118, 281, 8080)] },
  { ns: NS, name: "cart-service", kind: "Deployment", replicas: 2, podAgeH: 120, shape: "web", ctrs: [ctr("cart-service", `${ECR}/cart-service:v1.12.4`, 200, 500, 256, 512, 96, 214, 8080)] },
  { ns: NS, name: "notification-worker", kind: "Deployment", replicas: 2, podAgeH: 26, shape: "flat", ctrs: [ctr("worker", `${ECR}/notification-worker:v0.9.7`, 100, 300, 192, 320, 41, 121)] },
  { ns: NS, name: "search-indexer", kind: "Deployment", replicas: 1, podAgeH: 5, shape: "crash", hash: "5d7b86f9c4", suffixes: ["xk8vq"], ctrs: [ctr("indexer", `${ECR}/search-indexer:v1.4.0-rc2`, 500, 1000, 768, 1024, 420, 560)] },
  { ns: NS, name: "report-generator", kind: "Deployment", replicas: 1, podAgeH: 0.4, shape: "pending", ctrs: [ctr("generator", `${ECR}/report-generator:v0.6.1`, 2000, 4000, 12288, 14336, 0, 0, 8080)] },
  { ns: NS, name: "redis-cache", kind: "StatefulSet", replicas: 3, podAgeH: 336, shape: "flat", ctrs: [ctr("redis", "redis:7.2.5-alpine", 100, 500, 256, 512, 36, 143, 6379), ctr("redis-exporter", "oliver006/redis_exporter:v1.62.0", 10, 50, 16, 32, 3, 14, 9121)] },
  { ns: NS, name: "nightly-report-28812340", kind: "Job", replicas: 1, podAgeH: 3, shape: "done", cron: "nightly-report", ctrs: [ctr("report", `${ECR}/report-generator:v0.6.1`, 500, 1000, 512, 1024, 0, 0)] },

  { ns: "payments-prod", name: "payments-api", kind: "Deployment", replicas: 3, podAgeH: 31, shape: "web", ctrs: [ctr("payments-api", `${ECR}/payments-api:v4.2.1`, 400, 1000, 512, 1024, 310, 598, 8080), OTEL(18, 66)] },
  { ns: "payments-prod", name: "payments-worker", kind: "Deployment", replicas: 2, podAgeH: 12, shape: "flat", ctrs: [ctr("worker", `${ECR}/payments-worker:v4.2.1`, 200, 500, 256, 512, 84, 232)] },
  { ns: "payments-prod", name: "fraud-check", kind: "Deployment", replicas: 2, podAgeH: 70, shape: "flat", ctrs: [ctr("fraud-check", `${ECR}/fraud-check:v1.7.0`, 500, 1500, 1024, 2048, 340, 1180, 8080)] },

  { ns: "kube-system", name: "coredns", kind: "Deployment", replicas: 2, podAgeH: 456, shape: "flat", ctrs: [ctr("coredns", `${SYS}/eks/coredns:v1.11.3-eksbuild.2`, 100, undefined, 70, 170, 7, 22, 53)] },
  { ns: "kube-system", name: "aws-node", kind: "DaemonSet", replicas: 6, podAgeH: 456, shape: "flat", ctrs: [ctr("aws-node", `${SYS}/amazon-k8s-cni:v1.19.2-eksbuild.1`, 25, undefined, undefined, undefined, 5, 48)] },
  { ns: "kube-system", name: "kube-proxy", kind: "DaemonSet", replicas: 6, podAgeH: 456, shape: "flat", ctrs: [ctr("kube-proxy", `${SYS}/eks/kube-proxy:v1.31.2-minimal-eksbuild.3`, 100, undefined, undefined, undefined, 3, 17)] },
  { ns: "kube-system", name: "ebs-csi-node", kind: "DaemonSet", replicas: 6, podAgeH: 456, shape: "flat", ctrs: [ctr("ebs-plugin", `${SYS}/eks/aws-ebs-csi-driver:v1.37.0`, 10, 100, 40, 256, 2, 24)] },
  { ns: "kube-system", name: "eks-pod-identity-agent", kind: "DaemonSet", replicas: 6, podAgeH: 456, shape: "flat", ctrs: [ctr("eks-pod-identity-agent", `${SYS}/eks/eks-pod-identity-agent:v0.1.17`, 10, 100, 32, 128, 1, 14)] },
  { ns: "kube-system", name: "ebs-csi-controller", kind: "Deployment", replicas: 2, podAgeH: 456, shape: "flat", ctrs: [ctr("ebs-plugin", `${SYS}/eks/aws-ebs-csi-driver:v1.37.0`, 20, 200, 80, 512, 4, 46)] },
  { ns: "kube-system", name: "metrics-server", kind: "Deployment", replicas: 2, podAgeH: 456, shape: "flat", ctrs: [ctr("metrics-server", `${SYS}/eks/metrics-server:v0.7.2-eksbuild.1`, 100, undefined, 200, 400, 6, 36)] },
  { ns: "kube-system", name: "aws-load-balancer-controller", kind: "Deployment", replicas: 2, podAgeH: 240, shape: "flat", ctrs: [ctr("controller", "public.ecr.aws/eks/aws-load-balancer-controller:v2.9.2", 100, 300, 128, 256, 9, 61)] },
  { ns: "karpenter", name: "karpenter", kind: "Deployment", replicas: 2, podAgeH: 190, shape: "flat", ctrs: [ctr("controller", "public.ecr.aws/karpenter/controller:1.1.1", 1000, 1000, 1024, 1024, 62, 218)] },
  { ns: "monitoring", name: "prometheus-server", kind: "StatefulSet", replicas: 1, podAgeH: 96, shape: "flat", ctrs: [ctr("prometheus", "quay.io/prometheus/prometheus:v2.55.1", 1000, 2000, 4096, 6144, 640, 3300, 9090)] },
  { ns: "monitoring", name: "alertmanager", kind: "StatefulSet", replicas: 1, podAgeH: 96, shape: "flat", ctrs: [ctr("alertmanager", "quay.io/prometheus/alertmanager:v0.27.0", 50, 200, 128, 256, 4, 31, 9093)] },
  { ns: "monitoring", name: "grafana", kind: "Deployment", replicas: 1, podAgeH: 96, shape: "flat", ctrs: [ctr("grafana", "grafana/grafana:11.3.0", 250, 500, 512, 1024, 38, 262, 3000)] },
  { ns: "monitoring", name: "kube-state-metrics", kind: "Deployment", replicas: 1, podAgeH: 96, shape: "flat", ctrs: [ctr("kube-state-metrics", "registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0", 100, 250, 200, 400, 12, 78, 8080)] },
  { ns: "monitoring", name: "node-exporter", kind: "DaemonSet", replicas: 6, podAgeH: 96, shape: "flat", ctrs: [ctr("node-exporter", "quay.io/prometheus/node-exporter:v1.8.2", 25, 200, 32, 64, 3, 19, 9100)] },
  { ns: "argocd", name: "argocd-server", kind: "Deployment", replicas: 2, podAgeH: 140, shape: "flat", ctrs: [ctr("server", "quay.io/argoproj/argocd:v2.13.1", 100, 500, 256, 512, 14, 94, 8080)] },
  { ns: "argocd", name: "argocd-repo-server", kind: "Deployment", replicas: 2, podAgeH: 140, shape: "flat", ctrs: [ctr("repo-server", "quay.io/argoproj/argocd:v2.13.1", 200, 1000, 512, 1024, 38, 210, 8081)] },
  { ns: "argocd", name: "argocd-application-controller", kind: "StatefulSet", replicas: 1, podAgeH: 140, shape: "flat", ctrs: [ctr("application-controller", "quay.io/argoproj/argocd:v2.13.1", 500, 1500, 1024, 2048, 96, 742)] },
  { ns: "argocd", name: "argocd-redis", kind: "Deployment", replicas: 1, podAgeH: 140, shape: "flat", ctrs: [ctr("redis", "public.ecr.aws/docker/library/redis:7.4.1-alpine", 50, 200, 64, 128, 5, 22, 6379)] },
  { ns: "argocd", name: "argocd-applicationset-controller", kind: "Deployment", replicas: 1, podAgeH: 140, shape: "flat", ctrs: [ctr("applicationset-controller", "quay.io/argoproj/argocd:v2.13.1", 100, 300, 128, 256, 6, 49)] },
  { ns: "ingress-nginx", name: "ingress-nginx-controller", kind: "Deployment", replicas: 3, podAgeH: 190, shape: "web", ctrs: [ctr("controller", "registry.k8s.io/ingress-nginx/controller:v1.11.3", 200, 1000, 256, 512, 148, 232, 80)] },
  { ns: "cert-manager", name: "cert-manager", kind: "Deployment", replicas: 1, podAgeH: 300, shape: "flat", ctrs: [ctr("cert-manager-controller", "quay.io/jetstack/cert-manager-controller:v1.16.1", 50, 200, 96, 256, 3, 44, 9402)] },
  { ns: "cert-manager", name: "cert-manager-cainjector", kind: "Deployment", replicas: 1, podAgeH: 300, shape: "flat", ctrs: [ctr("cert-manager-cainjector", "quay.io/jetstack/cert-manager-cainjector:v1.16.1", 50, 200, 96, 256, 2, 52)] },
  { ns: "cert-manager", name: "cert-manager-webhook", kind: "Deployment", replicas: 1, podAgeH: 300, shape: "flat", ctrs: [ctr("cert-manager-webhook", "quay.io/jetstack/cert-manager-webhook:v1.16.1", 25, 100, 32, 64, 1, 17, 10250)] },
];

interface PodRec {
  uid: string;
  ns: string;
  name: string;
  wl: Wl;
  node: NodeSpec | null;
  ip: string | null;
  createdMs: number;
  restarts: number;
  seed: number;
  rs: string | null;
  owners: { kind: string; name: string }[];
}

const rsHashOf = (w: Wl) => w.hash ?? suffix(`${w.ns}/${w.name}/rs`, 10);

const PODS_ALL: PodRec[] = (() => {
  const out: PodRec[] = [];
  const ipOctet = new Map<number, number>();
  const nextIp = (subnet: number) => {
    const n = (ipOctet.get(subnet) ?? 20) + 3 + (ipOctet.size % 5);
    ipOctet.set(subnet, n);
    return `10.0.${subnet}.${n % 250 + 3}`;
  };
  for (const w of WORKLOADS) {
    for (let i = 0; i < w.replicas; i++) {
      const rs = w.kind === "Deployment" ? `${w.name}-${rsHashOf(w)}` : null;
      let name: string;
      if (w.kind === "Deployment") name = `${rs}-${w.suffixes?.[i] ?? suffix(`${w.ns}/${w.name}/${i}`)}`;
      else if (w.kind === "StatefulSet") name = `${w.name}-${i}`;
      else if (w.kind === "DaemonSet") name = `${w.name}-${suffix(`${w.ns}/${w.name}/${i}`)}`;
      else name = `${w.name}-${suffix(`${w.ns}/${w.name}/${i}`)}`;
      const owners =
        w.kind === "Deployment" ? [{ kind: "ReplicaSet", name: rs! }, { kind: "Deployment", name: w.name }]
        : w.kind === "Job" ? [{ kind: "Job", name: w.name }, ...(w.cron ? [{ kind: "CronJob", name: w.cron }] : [])]
        : [{ kind: w.kind, name: w.name }];
      const jitter = (fnv(name) % 40) / 100;
      let ageH = w.podAgeH * (1 + jitter * (w.podAgeH > 24 ? 0.5 : 0));
      // payments-worker 하나는 20분 전에 새로 떴다(이벤트가 남아 있다)
      if (w.name === "payments-worker" && i === 1) ageH = 0.37;
      const restarts =
        w.shape === "crash" ? 14
        : w.name === "orders-api" && i === 0 ? 1
        : w.name === "api-gateway" && i === 2 ? 2
        : 0;
      out.push({
        uid: `uid-pod-${w.ns}-${name}`,
        ns: w.ns,
        name,
        wl: w,
        node: null,
        ip: null,
        createdMs: NOW0 - ageH * HOUR,
        restarts,
        seed: fnv(name),
        rs,
        owners,
      });
    }
  }
  // 스케줄러처럼: DaemonSet은 노드마다 하나, 나머지는 요청이 가장 덜 찬 노드(요청이 할당 가능량을 넘지 않는 곳)에 놓는다
  const used = new Map(NODE_SPECS.map((n) => [n, { cpu: 0, mem: 0 }]));
  const place = (p: PodRec, n: NodeSpec) => {
    const u = used.get(n)!;
    for (const c of p.wl.shape === "done" ? [] : p.wl.ctrs) {
      u.cpu += c.cpuReq ?? 0;
      u.mem += (c.memReq ?? 0) * MI;
    }
    p.node = n;
    p.ip = nextIp(n.subnet);
  };
  const fits = (p: PodRec, n: NodeSpec) => {
    const u = used.get(n)!;
    const cpu = u.cpu + p.wl.ctrs.reduce((a, c) => a + (c.cpuReq ?? 0), 0);
    const mem = u.mem + p.wl.ctrs.reduce((a, c) => a + (c.memReq ?? 0) * MI, 0);
    return cpu <= allocOf(n).cpuMilli * 0.88 && mem <= allocOf(n).memoryBytes * 0.88;
  };
  const load = (n: NodeSpec) => Math.max(used.get(n)!.cpu / allocOf(n).cpuMilli, used.get(n)!.mem / allocOf(n).memoryBytes);
  for (const p of out.filter((q) => q.wl.kind === "DaemonSet")) place(p, NODE_SPECS[out.filter((q) => q.wl === p.wl).indexOf(p)]);
  for (const p of out) {
    if (p.node || p.wl.shape === "pending" || p.wl.kind === "DaemonSet") continue;
    const options = SCHEDULABLE.filter((n) => fits(p, n)).sort((a, b) => load(a) - load(b));
    if (options.length === 0) throw new Error(`스케줄할 노드가 없어요: ${p.name}`);
    place(p, options[0]);
  }
  return out;
})();

/** 상세·이벤트에서 보여 줄 pod: 메모리가 천천히 차오르는 orders-api 하나 */
const LEAKY_POD = PODS_ALL.find((p) => p.name === "orders-api-6d8f7b9c54-m2x7q")!;

const podStatus = (p: PodRec): "Running" | "Pending" | "CrashLoopBackOff" | "Completed" =>
  p.wl.shape === "crash" ? "CrashLoopBackOff" : p.wl.shape === "pending" ? "Pending" : p.wl.shape === "done" ? "Completed" : "Running";

const sum = (list: (number | undefined)[]): number | null => (list.every((v) => v !== undefined) ? (list as number[]).reduce((a, b) => a + b, 0) : null);

function podBounds(p: PodRec) {
  return {
    cpuRequest: sum(p.wl.ctrs.map((c) => c.cpuReq)),
    cpuLimit: sum(p.wl.ctrs.map((c) => c.cpuLim)),
    memoryRequest: sum(p.wl.ctrs.map((c) => (c.memReq === undefined ? undefined : c.memReq * MI))),
    memoryLimit: sum(p.wl.ctrs.map((c) => (c.memLim === undefined ? undefined : c.memLim * MI))),
  };
}

function podProblems(p: PodRec): K8sProblem[] {
  switch (p.wl.shape) {
    case "crash":
      return ["crashLoopBackOff", "oomKilled", "notReady"];
    case "pending":
      return ["pending"];
    default:
      return [];
  }
}

function podRow(p: PodRec): K8sRow {
  const st = podStatus(p);
  const b = podBounds(p);
  const total = p.wl.ctrs.length;
  const ready = st === "Running" ? total : 0;
  const values: Record<string, string> = {
    ready: `${ready}/${total}`,
    status: st,
    restarts: String(p.restarts),
  };
  if (p.node) values.node = p.node.name;
  if (p.ip) values.ip = p.ip;
  if (b.cpuRequest !== null) values.cpuRequest = String(b.cpuRequest);
  if (b.cpuLimit !== null) values.cpuLimit = String(b.cpuLimit);
  if (b.memoryRequest !== null) values.memoryRequest = String(b.memoryRequest);
  if (b.memoryLimit !== null) values.memoryLimit = String(b.memoryLimit);
  const labels: Record<string, string> = { "app.kubernetes.io/name": p.wl.cron ?? p.wl.name, "app.kubernetes.io/part-of": "magic-store" };
  if (p.rs) labels["pod-template-hash"] = p.rs.slice(p.wl.name.length + 1);
  if (p.wl.kind === "StatefulSet") labels["statefulset.kubernetes.io/pod-name"] = p.name;
  return { uid: p.uid, name: p.name, namespace: p.ns, resourceVersion: String(48_000_000 + (p.seed % 900_000)), createdAt: iso(p.createdMs), labels, values, problems: podProblems(p) };
}

// ── 사용량 ──────────────────────────────────────────────────────────────

/** 모든 서비스가 함께 타는 트래픽 곡선: 18분 전에 한 번 크게 몰렸다 */
function traffic(t: number): number {
  const m = (NOW0 - t) / MIN;
  return 0.74 + 0.85 * Math.exp(-(((m - 15) / 7.5) ** 2)) + 0.4 * Math.exp(-(((m - 43) / 6) ** 2)) + 0.06 * Math.sin(m / 3.1) + 0.05 * Math.sin(m / 0.9);
}

const sample = (seed: number, t: number) => rng((seed ^ Math.floor(t / 15_000)) >>> 0)();

interface Reading {
  cpuMilli: number;
  memoryBytes: number;
}

/** 컨테이너 하나의 t 시점 사용량. 아직 없던 때나 쓰지 않는 Pod는 null */
function containerAt(p: PodRec, c: Ctr, ci: number, t: number): Reading | null {
  const shape = p.wl.shape;
  if (shape === "pending" || shape === "done" || t < p.createdMs) return null;
  const seed = (p.seed + ci * 7919) >>> 0;
  const m = (NOW0 - t) / MIN;
  const noise = sample(seed, t) - 0.5;
  const variant = 0.88 + (p.seed % 25) / 100;
  if (shape === "crash") {
    const idx = Math.floor(t / 15_000);
    // 지금 읽는 값은 컨테이너가 떠 있는 때로 둔다
    const phase = t > Date.now() - 20_000 ? 5 : ((idx % 20) + 20) % 20;
    if (phase >= 8) return null;
    return { cpuMilli: Math.round(180 + phase * 55 + noise * 40), memoryBytes: Math.round((260 + phase * 95 + noise * 20) * MI) };
  }
  let cpu = c.cpu * variant * (shape === "web" ? traffic(t) : 1 + 0.06 * Math.sin(m / 5 + (seed % 9)) + noise * 0.1);
  let mem = c.mem * variant * (1 + 0.012 * Math.sin(m / 11 + (seed % 5)) + noise * 0.012);
  if (shape === "web") mem *= 0.9 + 0.14 * traffic(t);
  if (p === LEAKY_POD && ci === 0) mem = c.mem * (1 + 0.47 * (1 - Math.min(m, 60) / 60) ** 1.25) + 14 * Math.sin(m / 2.3) + noise * 9;
  if (p.wl.name === "api-gateway" && p.name === PODS_ALL.find((q) => q.wl.name === "api-gateway")!.name) cpu *= 1.32;
  if (p.wl.name === "prometheus-server") mem = c.mem * (0.94 + 0.06 * (1 - m / 60)) + noise * 8;
  return { cpuMilli: Math.max(1, Math.round(cpu + noise * 4)), memoryBytes: Math.max(MI, Math.round(mem * MI)) };
}

function podUsageAt(p: PodRec, t: number): K8sPodUsage | null {
  const readings = p.wl.ctrs.map((c, i) => containerAt(p, c, i, t));
  if (readings.every((r) => r === null)) return null;
  const containers = p.wl.ctrs.flatMap((c, i) => (readings[i] ? [{ name: c.name, cpuMilli: readings[i]!.cpuMilli, memoryBytes: readings[i]!.memoryBytes }] : []));
  return {
    namespace: p.ns,
    name: p.name,
    cpuMilli: containers.reduce((a, c) => a + c.cpuMilli, 0),
    memoryBytes: containers.reduce((a, c) => a + c.memoryBytes, 0),
    containers,
    owners: p.owners,
  };
}

function nodeUsageAt(n: NodeSpec, t: number, pods: K8sPodUsage[]): Reading {
  const mine = new Set(PODS_ALL.filter((p) => p.node === n).map((p) => p.uid));
  const names = new Set(PODS_ALL.filter((p) => mine.has(p.uid)).map((p) => `${p.ns}/${p.name}`));
  let cpu = 0;
  let mem = 0;
  for (const u of pods) {
    if (!names.has(`${u.namespace}/${u.name}`)) continue;
    cpu += u.cpuMilli;
    mem += u.memoryBytes;
  }
  const noise = sample(fnv(n.name), t) - 0.5;
  return { cpuMilli: Math.round(cpu + 360 + noise * 50), memoryBytes: Math.round(mem + (1650 + noise * 30) * MI) };
}

function metricsAt(t: number, namespace: string | null): K8sMetrics {
  const all = PODS_ALL.flatMap((p) => {
    const u = podUsageAt(p, t);
    return u ? [u] : [];
  });
  const nodes = NODE_SPECS.map((n) => ({ name: n.name, ...nodeUsageAt(n, t, all) }));
  return { podsUnavailable: null, nodesUnavailable: null, pods: namespace === null ? all : all.filter((u) => u.namespace === namespace), nodes };
}

const backfilled = new Set<string>();

/** 지난 1시간치 사용량을 15초 간격으로 기록에 넣는다(앱은 실제로는 연결된 동안 15초마다 모은다) */
function backfill(target: K8sTarget) {
  const key = historyKey(target, CONTEXT);
  if (backfilled.has(key)) return;
  backfilled.add(key);
  const end = Date.now() - 20_000;
  for (let t = end - 58 * MIN; t <= end; t += 15_000) recordUsage(key, t, metricsAt(t, null));
}

// ── 목록 행 ─────────────────────────────────────────────────────────────

const NAMESPACE_NAMES = ["argocd", "cert-manager", NS, "default", "ingress-nginx", "karpenter", "kube-node-lease", "kube-public", "kube-system", "monitoring", "payments-prod"];

function namespaceRows(): K8sRow[] {
  return NAMESPACE_NAMES.map((name) => ({
    uid: `uid-ns-${name}`,
    name,
    namespace: null,
    resourceVersion: "1",
    createdAt: iso(NOW0 - (name.startsWith("kube-") || name === "default" ? 61 : 40) * 86_400_000),
    labels: { "kubernetes.io/metadata.name": name },
    values: { status: "Active" },
    problems: [],
  }));
}

function nodeRow(n: NodeSpec): K8sRow {
  const alloc = allocOf(n);
  const values: Record<string, string> = {
    status: n.cordoned ? "Ready,SchedulingDisabled" : "Ready",
    version: n.kubelet,
    instanceType: n.instanceType,
    zone: n.zone,
    groupKind: n.groupKind,
    group: n.group,
    cpuAllocatable: String(alloc.cpuMilli),
    memoryAllocatable: String(alloc.memoryBytes),
  };
  return {
    uid: `uid-node-${n.name}`,
    name: n.name,
    namespace: null,
    resourceVersion: "52112388",
    createdAt: iso(NOW0 - n.ageDays * 86_400_000),
    labels: { "kubernetes.io/hostname": n.name, "node.kubernetes.io/instance-type": n.instanceType, "topology.kubernetes.io/zone": n.zone, "kubernetes.io/arch": "amd64" },
    values,
    problems: [],
  };
}

const rsOf = (w: Wl) => `${w.name}-${rsHashOf(w)}`;

function workloadRows(w: Wl): K8sRow {
  const pods = PODS_ALL.filter((p) => p.wl === w);
  const ready = pods.filter((p) => podStatus(p) === "Running").length;
  const values: Record<string, string> = {};
  const problems: K8sProblem[] = [];
  if (w.kind === "Deployment") {
    values.ready = `${ready}/${w.replicas}`;
    values.upToDate = String(w.replicas);
    values.available = String(ready);
    if (ready < w.replicas) problems.push("notReady");
  } else if (w.kind === "StatefulSet") {
    values.ready = `${ready}/${w.replicas}`;
  } else if (w.kind === "DaemonSet") {
    values.desired = String(w.replicas);
    values.current = String(w.replicas);
    values.ready = String(ready);
    values.upToDate = String(w.replicas);
    values.available = String(ready);
  } else {
    values.completions = "1/1";
    values.status = "Complete";
  }
  const kindLower = w.kind.toLowerCase();
  return {
    uid: `uid-${kindLower}-${w.ns}-${w.name}`,
    name: w.name,
    namespace: w.ns,
    resourceVersion: String(51_000_000 + (fnv(w.name) % 900_000)),
    createdAt: iso(NOW0 - Math.max(w.podAgeH, 24) * HOUR * (w.podAgeH > 100 ? 1.8 : 1.2)),
    labels: { "app.kubernetes.io/name": w.name, "app.kubernetes.io/part-of": "magic-store" },
    values,
    problems,
  };
}

const rowsOfKind = (kind: string): K8sRow[] => {
  switch (kind) {
    case "Namespace":
      return namespaceRows();
    case "Node":
      return NODE_SPECS.map(nodeRow);
    case "Pod":
      return PODS_ALL.map(podRow);
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
      return WORKLOADS.filter((w) => w.kind === kind).map(workloadRows);
    case "ReplicaSet":
      return WORKLOADS.filter((w) => w.kind === "Deployment").map((w) => {
        const pods = PODS_ALL.filter((p) => p.wl === w);
        const ready = pods.filter((p) => podStatus(p) === "Running").length;
        return {
          uid: `uid-rs-${w.ns}-${rsOf(w)}`,
          name: rsOf(w),
          namespace: w.ns,
          resourceVersion: "50333121",
          createdAt: iso(NOW0 - Math.max(w.podAgeH, 1) * HOUR),
          labels: { "app.kubernetes.io/name": w.name, "pod-template-hash": rsHashOf(w) },
          values: { desired: String(w.replicas), current: String(w.replicas), ready: String(ready) },
          problems: ready < w.replicas ? ["notReady" as K8sProblem] : [],
        };
      });
    case "Job":
      return WORKLOADS.filter((w) => w.kind === "Job").map(workloadRows);
    case "CronJob":
      return [
        {
          uid: "uid-cronjob-nightly-report",
          name: "nightly-report",
          namespace: NS,
          resourceVersion: "49100312",
          createdAt: iso(NOW0 - 90 * 86_400_000),
          labels: { "app.kubernetes.io/name": "nightly-report" },
          values: { schedule: "0 2 * * *", suspend: "false", active: "0", lastSchedule: iso(NOW0 - 3 * HOUR) },
          problems: [],
        },
      ];
    case "Event":
      return EVENT_LIST.map(eventRow);
    default:
      return [];
  }
};

// ── 이벤트 ──────────────────────────────────────────────────────────────

interface Ev {
  ns: string;
  kind: string;
  object: string;
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  count: number;
  agoMin: number;
  source: string;
}

const pod = (workload: string, i = 0) => PODS_ALL.filter((p) => p.wl.name === workload)[i];
const indexer = pod("search-indexer");
const reporter = pod("report-generator");
const freshWorker = PODS_ALL.find((p) => p.wl.name === "payments-worker" && p.createdMs > NOW0 - HOUR)!;
const oomNode = SCHEDULABLE[2].name;

const EVENT_LIST: Ev[] = [
  { ns: NS, kind: "Pod", object: indexer.name, type: "Warning", reason: "BackOff", message: `Back-off restarting failed container indexer in pod ${indexer.name}_${NS}(${indexer.uid.slice(8, 44)})`, count: 214, agoMin: 2, source: "kubelet" },
  { ns: NS, kind: "Pod", object: indexer.name, type: "Normal", reason: "Pulled", message: `Container image "${ECR}/search-indexer:v1.4.0-rc2" already present on machine`, count: 215, agoMin: 4, source: "kubelet" },
  { ns: NS, kind: "Pod", object: indexer.name, type: "Normal", reason: "Created", message: "Created container indexer", count: 215, agoMin: 4, source: "kubelet" },
  { ns: NS, kind: "Pod", object: indexer.name, type: "Normal", reason: "Started", message: "Started container indexer", count: 215, agoMin: 4, source: "kubelet" },
  { ns: NS, kind: "Pod", object: reporter.name, type: "Warning", reason: "FailedScheduling", message: "0/6 nodes are available: 1 node(s) were unschedulable, 5 Insufficient memory. preemption: 0/6 nodes are available: 1 Preemption is not helpful for scheduling, 5 No preemption victims found for incoming pod.", count: 38, agoMin: 4, source: "default-scheduler" },
  { ns: NS, kind: "Pod", object: reporter.name, type: "Warning", reason: "FailedScheduling", message: 'Failed to schedule pod, incompatible with nodepool "default", daemonset overhead={"cpu":"175m","memory":"192Mi","pods":"6"}, no instance type satisfied resources {"cpu":"1175m","memory":"6336Mi","pods":"7"} and requirements karpenter.sh/capacity-type In [on-demand], kubernetes.io/arch In [amd64]', count: 12, agoMin: 6, source: "karpenter" },
  { ns: NS, kind: "Pod", object: pod("orders-api", 1).name, type: "Warning", reason: "Unhealthy", message: "Readiness probe failed: HTTP probe failed with statuscode: 503", count: 3, agoMin: 41, source: "kubelet" },
  { ns: NS, kind: "HorizontalPodAutoscaler", object: "orders-api", type: "Normal", reason: "SuccessfulRescale", message: "New size: 3; reason: cpu resource utilization (percentage of request) above target", count: 1, agoMin: 52, source: "horizontal-pod-autoscaler" },
  { ns: NS, kind: "HorizontalPodAutoscaler", object: "search-indexer", type: "Warning", reason: "FailedGetResourceMetric", message: "failed to get cpu utilization: did not receive metrics for targeted pods (pods might be missing metrics or are in pending state)", count: 4, agoMin: 28, source: "horizontal-pod-autoscaler" },
  { ns: "default", kind: "Node", object: oomNode, type: "Warning", reason: "OOMKilling", message: "Memory cgroup out of memory: Killed process 28817 (java) total-vm:4184828kB, anon-rss:1038192kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:2412kB oom_score_adj:937", count: 1, agoMin: 17, source: "kernel-monitor" },
  { ns: "payments-prod", kind: "Pod", object: freshWorker.name, type: "Normal", reason: "Scheduled", message: `Successfully assigned payments-prod/${freshWorker.name} to ${freshWorker.node?.name}`, count: 1, agoMin: 22, source: "default-scheduler" },
  { ns: "payments-prod", kind: "Pod", object: freshWorker.name, type: "Normal", reason: "Pulled", message: `Container image "${ECR}/payments-worker:v4.2.1" already present on machine`, count: 1, agoMin: 22, source: "kubelet" },
  { ns: "payments-prod", kind: "Pod", object: freshWorker.name, type: "Normal", reason: "Created", message: "Created container worker", count: 1, agoMin: 22, source: "kubelet" },
  { ns: "payments-prod", kind: "Pod", object: freshWorker.name, type: "Normal", reason: "Started", message: "Started container worker", count: 1, agoMin: 22, source: "kubelet" },
  { ns: "karpenter", kind: "NodeClaim", object: "default-7x4kq", type: "Normal", reason: "Registered", message: "Status condition transitioned, Type: Registered, Status: Unknown -> True", count: 1, agoMin: 47, source: "karpenter" },
];

function eventRow(e: Ev, i: number): K8sRow {
  return {
    uid: `uid-event-${i}`,
    name: `${e.object}.${(0x17000000 + i * 977).toString(16)}`,
    namespace: e.ns,
    resourceVersion: String(52_100_000 + i),
    createdAt: iso(NOW0 - e.agoMin * MIN),
    labels: {},
    values: { type: e.type, reason: e.reason, object: `${e.kind}/${e.object}`, message: e.message, count: String(e.count), lastSeen: iso(NOW0 - e.agoMin * MIN) },
    problems: [],
  };
}

const eventsFor = (kind: string, ns: string | null, name: string): K8sEvent[] =>
  EVENT_LIST.filter((e) => e.kind === kind && e.object === name && (ns === null || e.ns === ns))
    .sort((a, b) => a.agoMin - b.agoMin)
    .map((e) => ({ type: e.type, reason: e.reason, message: e.message, count: e.count, lastSeen: iso(NOW0 - e.agoMin * MIN), source: e.source, object: `${e.kind}/${e.object}` }));

// ── 상세 ────────────────────────────────────────────────────────────────


const linkOf = (group: string, kind: string, name: string, ns: string | null, uid: string, controller: boolean, problems: K8sProblem[] = []): K8sLink =>
  ({ group, version: "v1", kind, name, namespace: ns, uid, controller, problems });

function containerManifest(c: Ctr) {
  const resources: Record<string, Record<string, string>> = {};
  const req: Record<string, string> = {};
  const lim: Record<string, string> = {};
  if (c.cpuReq !== undefined) req.cpu = `${c.cpuReq}m`;
  if (c.memReq !== undefined) req.memory = `${c.memReq}Mi`;
  if (c.cpuLim !== undefined) lim.cpu = `${c.cpuLim}m`;
  if (c.memLim !== undefined) lim.memory = `${c.memLim}Mi`;
  if (Object.keys(req).length) resources.requests = req;
  if (Object.keys(lim).length) resources.limits = lim;
  return { name: c.name, image: c.image, ...(c.port ? { ports: [{ containerPort: c.port, name: "http", protocol: "TCP" }] } : {}), resources };
}

function podManifest(p: PodRec, withStatus: boolean) {
  const row = podRow(p);
  const manifest: Record<string, unknown> = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: p.name,
      namespace: p.ns,
      uid: p.uid,
      creationTimestamp: row.createdAt,
      labels: row.labels,
      ownerReferences: p.owners.length ? [{ apiVersion: "apps/v1", kind: p.owners[0].kind, name: p.owners[0].name, controller: true, blockOwnerDeletion: true }] : undefined,
    },
    spec: {
      serviceAccountName: p.wl.name,
      nodeName: p.node?.name,
      containers: p.wl.ctrs.map(containerManifest),
      restartPolicy: p.wl.kind === "Job" ? "OnFailure" : "Always",
      terminationGracePeriodSeconds: 30,
      tolerations: [{ key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 }],
    },
  };
  if (withStatus) {
    manifest.status = {
      phase: podStatus(p) === "Pending" ? "Pending" : p.wl.shape === "done" ? "Succeeded" : "Running",
      podIP: p.ip ?? undefined,
      hostIP: p.node ? p.node.name.replace(/^ip-/, "").replace(/\..*$/, "").replace(/-/g, ".") : undefined,
      qosClass: "Burstable",
    };
  }
  return JSON.parse(JSON.stringify(manifest));
}

function podView(p: PodRec): K8sObjectView {
  const row = podRow(p);
  const st = podStatus(p);
  const crash = st === "CrashLoopBackOff";
  const containers: K8sContainer[] = p.wl.ctrs.map((c) => ({
    name: c.name,
    image: c.image,
    init: false,
    state: st === "Pending" ? "waiting" : st === "Completed" ? "terminated" : crash ? "waiting" : "running",
    ready: st === "Running",
    restarts: p.restarts,
    reason: crash ? "CrashLoopBackOff" : st === "Pending" ? "ContainerCreating" : st === "Completed" ? "Completed" : null,
    message: crash ? `back-off 5m0s restarting failed container=${c.name} pod=${p.name}_${p.ns}(${p.uid.slice(8, 44)})` : null,
    lastTermination: crash
      ? { reason: "OOMKilled", exitCode: 137, finishedAt: iso(NOW0 - 3 * MIN) }
      : p.restarts > 0 && c === p.wl.ctrs[0]
        ? { reason: "Error", exitCode: 1, finishedAt: iso(NOW0 - 2.4 * HOUR) }
        : null,
    cpuRequest: c.cpuReq ?? null,
    cpuLimit: c.cpuLim ?? null,
    memoryRequest: c.memReq === undefined ? null : c.memReq * MI,
    memoryLimit: c.memLim === undefined ? null : c.memLim * MI,
  }));
  if (st === "Pending") {
    for (const c of containers) { c.reason = null; c.message = null; c.state = "unknown"; }
  }
  const cond = (type: string, status: boolean, reason: string | null, message: string | null, agoMin: number): K8sCondition =>
    ({ type, status: status ? "True" : "False", reason, message, lastTransition: iso(NOW0 - agoMin * MIN) });
  const age = (NOW0 - p.createdMs) / MIN;
  const conditions: K8sCondition[] =
    st === "Pending"
      ? [cond("PodScheduled", false, "Unschedulable", "0/6 nodes are available: 1 node(s) were unschedulable, 5 Insufficient memory.", age)]
      : [
          cond("Initialized", true, null, null, age),
          cond("Ready", st === "Running", st === "Running" ? null : "ContainersNotReady", st === "Running" ? null : `containers with unready status: [${p.wl.ctrs[0].name}]`, st === "Running" ? age - 0.5 : 3),
          cond("ContainersReady", st === "Running", st === "Running" ? null : "ContainersNotReady", null, st === "Running" ? age - 0.5 : 3),
          cond("PodScheduled", true, null, null, age),
        ];
  const port = p.wl.ctrs.find((c) => c.port);
  return {
    kind: PODS,
    row,
    annotations: {
      "kubectl.kubernetes.io/default-container": p.wl.ctrs[0].name,
      ...(p.wl.ctrs.some((c) => c.port) ? { "prometheus.io/scrape": "true", "prometheus.io/port": String(port?.port ?? 8080) } : {}),
    },
    owners: p.owners.length ? [linkOf(p.owners[0].kind === "StatefulSet" || p.owners[0].kind === "DaemonSet" ? "apps" : p.owners[0].kind === "Job" ? "batch" : "apps", p.owners[0].kind, p.owners[0].name, p.ns, `uid-owner-${p.owners[0].name}`, true)] : [],
    children: [],
    childrenTruncated: false,
    childrenError: null,
    containers,
    conditions,
    events: eventsFor("Pod", p.ns, p.name),
    eventsError: null,
    yaml: stringify(podManifest(p, true)),
    editYaml: stringify(podManifest(p, false)),
    secretKeys: null,
    ports: p.wl.ctrs.filter((c) => c.port).map((c) => ({ name: "http", port: c.port!, container: c.name, target: null })),
  };
}

function workloadManifest(w: Wl, withStatus: boolean) {
  const replicas = w.replicas;
  const manifest: Record<string, unknown> = {
    apiVersion: "apps/v1",
    kind: w.kind,
    metadata: { name: w.name, namespace: w.ns, labels: { "app.kubernetes.io/name": w.name, "app.kubernetes.io/part-of": "magic-store" }, annotations: { "deployment.kubernetes.io/revision": "14" } },
    spec: {
      replicas,
      revisionHistoryLimit: 10,
      selector: { matchLabels: { "app.kubernetes.io/name": w.name } },
      strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": w.name, "app.kubernetes.io/part-of": "magic-store" } },
        spec: { serviceAccountName: w.name, containers: w.ctrs.map(containerManifest), terminationGracePeriodSeconds: 30 },
      },
    },
  };
  if (withStatus) {
    const ready = PODS_ALL.filter((p) => p.wl === w && podStatus(p) === "Running").length;
    manifest.status = { replicas, readyReplicas: ready, updatedReplicas: replicas, availableReplicas: ready, observedGeneration: 27 };
  }
  return JSON.parse(JSON.stringify(manifest));
}

function workloadView(w: Wl): K8sObjectView {
  const row = workloadRows(w);
  const kindRef = w.kind === "Deployment" ? DEPLOYMENTS : w.kind === "StatefulSet" ? STATEFULSETS : w.kind === "DaemonSet" ? DAEMONSETS : JOBS;
  const rs = rsOf(w);
  const unhealthy = (row.problems as string[]).length > 0;
  const containers: K8sContainer[] = w.ctrs.map((c) => ({
    name: c.name, image: c.image, init: false, state: "template", ready: false, restarts: 0, reason: null, message: null, lastTermination: null,
    cpuRequest: c.cpuReq ?? null, cpuLimit: c.cpuLim ?? null, memoryRequest: c.memReq === undefined ? null : c.memReq * MI, memoryLimit: c.memLim === undefined ? null : c.memLim * MI,
  }));
  const cond = (type: string, status: string, reason: string, message: string, agoMin: number): K8sCondition => ({ type, status, reason, message, lastTransition: iso(NOW0 - agoMin * MIN) });
  const conditions: K8sCondition[] =
    w.kind === "Deployment"
      ? [
          cond("Available", unhealthy ? "False" : "True", unhealthy ? "MinimumReplicasUnavailable" : "MinimumReplicasAvailable", unhealthy ? "Deployment does not have minimum availability." : "Deployment has minimum availability.", w.podAgeH * 60),
          cond("Progressing", unhealthy ? "False" : "True", unhealthy ? "ProgressDeadlineExceeded" : "NewReplicaSetAvailable", `ReplicaSet "${rs}" ${unhealthy ? "has timed out progressing." : "has successfully progressed."}`, w.podAgeH * 60),
        ]
      : [];
  const children: K8sLink[] =
    w.kind === "Deployment"
      ? [
          linkOf("apps", "ReplicaSet", rs, w.ns, `uid-rs-${w.ns}-${rs}`, true, row.problems),
          linkOf("apps", "ReplicaSet", `${w.name}-${suffix(`${w.name}/old`, 10)}`, w.ns, `uid-rs-old-${w.name}`, true),
        ]
      : PODS_ALL.filter((p) => p.wl === w).map((p) => linkOf("", "Pod", p.name, p.ns, p.uid, true, podProblems(p)));
  return {
    kind: kindRef,
    row,
    annotations: w.kind === "Deployment" ? { "deployment.kubernetes.io/revision": "14", "argocd.argoproj.io/tracking-id": `${w.ns}:apps/Deployment:${w.ns}/${w.name}` } : {},
    owners: [],
    children,
    childrenTruncated: false,
    childrenError: null,
    containers,
    conditions,
    events: eventsFor(w.kind, w.ns, w.name),
    eventsError: null,
    yaml: stringify(workloadManifest(w, true)),
    editYaml: stringify(workloadManifest(w, false)),
    secretKeys: null,
  };
}

function genericView(kindRef: K8sKindRef, ns: string | null, name: string): K8sObjectView {
  const row = rowsOfKind(kindRef.kind).find((r) => r.name === name && r.namespace === ns) ?? {
    uid: `uid-${kindRef.kind}-${name}`, name, namespace: ns, resourceVersion: "1", createdAt: iso(NOW0 - 3 * 86_400_000), labels: {}, values: {}, problems: [],
  };
  const manifest = { apiVersion: kindRef.group ? `${kindRef.group}/${kindRef.version}` : kindRef.version, kind: kindRef.kind, metadata: { name, ...(ns ? { namespace: ns } : {}), labels: row.labels } };
  return {
    kind: kindRef, row, annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null, containers: [], conditions: [],
    events: eventsFor(kindRef.kind, ns, name), eventsError: null, yaml: stringify(manifest), editYaml: stringify(manifest), secretKeys: null,
  };
}

function getObject(kind: K8sKindRef, ns: string | null, name: string): K8sObjectView {
  if (kind.group === "" && kind.kind === "Pod") {
    const p = PODS_ALL.find((q) => q.ns === ns && q.name === name);
    if (p) return podView(p);
  }
  if (kind.group === "apps" && ["Deployment", "StatefulSet", "DaemonSet"].includes(kind.kind)) {
    const w = WORKLOADS.find((x) => x.ns === ns && x.name === name && x.kind === kind.kind);
    if (w) return workloadView(w);
  }
  if (kind.group === "apps" && kind.kind === "ReplicaSet") {
    const w = WORKLOADS.find((x) => x.ns === ns && rsOf(x) === name);
    if (w) {
      const v = workloadView(w);
      const pods = PODS_ALL.filter((p) => p.wl === w);
      return { ...genericView(REPLICASETS, ns, name), containers: v.containers, children: pods.map((p) => linkOf("", "Pod", p.name, p.ns, p.uid, true, podProblems(p))), owners: [linkOf("apps", "Deployment", w.name, w.ns, `uid-deployment-${w.ns}-${w.name}`, true)] };
    }
  }
  return genericView(kind, ns, name);
}

// ── 로그 ────────────────────────────────────────────────────────────────

const pick = <T,>(r: () => number, list: T[]): T => list[Math.floor(r() * list.length)];
const userId = (r: () => number) => `u_${Math.floor(10_000 + r() * 89_999)}`;
const orderId = (r: () => number) => `ORD-2026-${Math.floor(880_000 + r() * 9_999)}`;
const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join("");

function orderLine(r: () => number, t: number, flaky: boolean, forced?: number): string {
  const time = iso(t);
  const roll = forced ?? r();
  const j = (level: string, msg: string, fields: Record<string, unknown>) => JSON.stringify({ level, time, msg, ...fields });
  const trace = hex(r, 32);
  if (roll < 0.2) return j("info", "order created", { orderId: orderId(r), userId: userId(r), items: 1 + Math.floor(r() * 4), amount: Math.round((9 + r() * 140) * 1000), currency: "KRW", latencyMs: 24 + Math.floor(r() * 60), traceId: trace });
  if (roll < 0.32) return j("info", "payment authorized", { orderId: orderId(r), provider: "tosspayments", method: pick(r, ["card", "card", "kakaopay", "naverpay"]), latencyMs: 180 + Math.floor(r() * 420), traceId: trace });
  if (roll < 0.42) return j("info", "inventory reserved", { orderId: orderId(r), sku: `SKU-${Math.floor(1000 + r() * 8999)}`, qty: 1 + Math.floor(r() * 3), warehouse: pick(r, ["ICN-1", "ICN-2", "PUS-1"]) });
  if (roll < 0.56) return j("info", `GET /v1/orders/${orderId(r)} 200`, { method: "GET", status: 200, latencyMs: 6 + Math.floor(r() * 38), requestId: hex(r, 12) });
  if (roll < 0.64) return j("info", "order status updated", { orderId: orderId(r), from: "PAID", to: pick(r, ["PREPARING", "PREPARING", "SHIPPED"]) });
  if (roll < 0.7) return j("info", "published event", { topic: "orders.events", partition: Math.floor(r() * 12), offset: 4_182_000 + Math.floor(r() * 9000) });
  if (roll < 0.8) return j("debug", "cache hit", { key: `orders:${userId(r)}`, ttlMs: Math.floor(r() * 300_000) });
  if (roll < 0.86) return j("debug", "db query", { query: "SELECT id, status, total FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20", rows: Math.floor(r() * 20), durationMs: 2 + Math.floor(r() * 14) });
  if (roll < (flaky ? 0.9 : 0.92)) return j("warn", pick(r, ["slow query detected", "payment provider retry"]), { durationMs: 520 + Math.floor(r() * 400), thresholdMs: 500, table: "orders", attempt: 2, provider: "tosspayments", reason: "timeout" });
  if (roll < (flaky ? 0.95 : 0.96)) return j("warn", "readiness probe latency high", { path: "/healthz", latencyMs: 1200 + Math.floor(r() * 900) });
  return pick(r, [
    () => j("error", "payment authorization failed", { orderId: orderId(r), provider: "tosspayments", code: "PG_TIMEOUT", attempt: 3, error: "Post \"https://api.tosspayments.com/v1/payments/confirm\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)", traceId: trace }),
    () => j("error", "failed to publish event", { topic: "orders.events", error: "kafka: client has run out of available brokers to talk to: dial tcp 10.0.12.71:9092: i/o timeout", traceId: trace }),
  ])();
}

function otelLine(r: () => number): string {
  const msg = pick(r, ["Exporting traces", "Exporting metrics", "Batch flushed"]);
  const count = 40 + Math.floor(r() * 200);
  return `level=info msg="${msg}" exporter=otlp count=${count}`;
}

interface LogSource {
  pod: string;
  container: string;
  line: (r: () => number, t: number, forced?: number) => string;
  perMin: number;
}

function logSources(w: Wl, only?: PodRec): LogSource[] {
  const pods = PODS_ALL.filter((p) => p.wl === w && (!only || p === only) && podStatus(p) === "Running");
  return pods.flatMap((p) =>
    w.ctrs.map((c, ci): LogSource => ({
      pod: p.name,
      container: c.name,
      perMin: ci === 0 ? (p === LEAKY_POD ? 20 : 15) : 3,
      line: ci === 0 ? (r, t, forced) => orderLine(r, t, p === LEAKY_POD, forced) : otelLine,
    })),
  );
}

function sendLogs(a: Args, w: Wl, only?: PodRec) {
  const ch = a.onEvent as { onmessage: (m: K8sLogMessage) => void };
  const options = (a.options ?? {}) as K8sLogOptions;
  const sources = logSources(w, only).filter((s) => !options.container || s.container === options.container);
  const end = Date.now() - 800;
  const start = end - 5 * MIN;
  const all: { s: LogSource; t: number; text: string }[] = [];
  for (const s of sources) {
    const r = rng(fnv(`${s.pod}/${s.container}`));
    const n = Math.round(s.perMin * 5);
    for (let i = 0; i < n; i++) {
      const t = start + ((i + r() * 0.9) / n) * (end - start);
      all.push({ s, t, text: s.line(r, t) });
    }
  }
  all.sort((x, y) => x.t - y.t);
  // 화면에 보이는 끝쪽에 오류·경고가 섞여 있게 한다
  const forcedAt: [number, number][] = [[4, 0.985], [11, 0.91], [17, 0.992], [23, 0.93]];
  for (const [fromEnd, roll] of forcedAt) {
    let i = all.length - 1 - fromEnd;
    while (i > 0 && all[i].s.container !== w.ctrs[0].name) i--;
    all[i].text = all[i].s.line(rng(i + 77), all[i].t, roll);
  }
  setTimeout(() => {
    for (const s of sources) ch.onmessage({ type: "source", pod: s.pod, container: s.container, state: "attached" });
    let run: { s: LogSource; lines: K8sLogLine[] } | null = null;
    const flush = () => {
      if (run) ch.onmessage({ type: "lines", pod: run.s.pod, container: run.s.container, lines: run.lines });
      run = null;
    };
    for (const e of all) {
      if (run && run.s !== e.s) flush();
      if (!run) run = { s: e.s, lines: [] };
      run.lines.push({ ts: new Date(e.t).toISOString().replace("Z", "000Z"), text: e.text });
    }
    flush();
  }, 40);
}

// ── 개요 ────────────────────────────────────────────────────────────────

function overview(): K8sOverview {
  const t = Date.now();
  const metrics = metricsAt(t, null);
  const nodes: K8sNodeView[] = NODE_SPECS.map((n) => {
    const mine = PODS_ALL.filter((p) => p.node === n && podStatus(p) !== "Completed");
    const req = { cpuMilli: 0, memoryBytes: 0, pods: mine.length };
    const lim = { cpuMilli: 0, memoryBytes: 0, pods: mine.length };
    for (const p of mine) {
      for (const c of p.wl.ctrs) {
        req.cpuMilli += c.cpuReq ?? 0;
        req.memoryBytes += (c.memReq ?? 0) * MI;
        lim.cpuMilli += c.cpuLim ?? 0;
        lim.memoryBytes += (c.memLim ?? 0) * MI;
      }
    }
    const usage = metrics.nodes.find((u) => u.name === n.name)!;
    return {
      name: n.name,
      ready: true,
      unschedulable: n.cordoned,
      pressures: [],
      instanceType: n.instanceType,
      zone: n.zone,
      groupKind: n.groupKind,
      group: n.group,
      kubeletVersion: n.kubelet,
      capacity: capacityOf(n),
      allocatable: allocOf(n),
      requested: req,
      limits: lim,
      usage: { cpuMilli: usage.cpuMilli, memoryBytes: usage.memoryBytes },
    };
  });
  return {
    cluster: {
      version: "1.31",
      platformVersion: "eks.12",
      status: "ACTIVE",
      endpointPublic: true,
      endpointPrivate: true,
      publicCidrs: ["203.0.113.0/24", "198.51.100.17/32"],
      logging: ["api", "audit", "authenticator", "controllerManager"],
      secretsEncrypted: true,
      oidcIssuer: OIDC,
      authenticationMode: "API_AND_CONFIG_MAP",
    },
    nodes,
    requestsPartial: false,
    metrics: true,
    nodegroups: [
      { name: "general-purpose", status: "ACTIVE", version: "1.31", instanceTypes: ["m6i.xlarge"], capacityType: "ON_DEMAND", min: 3, max: 6, desired: 4 },
      { name: "legacy-v130", status: "ACTIVE", version: "1.30", instanceTypes: ["m5.xlarge"], capacityType: "ON_DEMAND", min: 1, max: 2, desired: 1 },
    ],
    fargateProfiles: ["batch-jobs"],
    nodePools: ["default", "spot-burst"],
    addons: [
      { name: "vpc-cni", version: "v1.19.2-eksbuild.1", latest: "v1.19.2-eksbuild.1", status: "ACTIVE", issues: [] },
      { name: "coredns", version: "v1.11.3-eksbuild.2", latest: "v1.11.4-eksbuild.2", status: "ACTIVE", issues: [] },
      { name: "kube-proxy", version: "v1.31.2-eksbuild.3", latest: "v1.31.3-eksbuild.2", status: "ACTIVE", issues: [] },
      { name: "aws-ebs-csi-driver", version: "v1.37.0-eksbuild.1", latest: "v1.38.1-eksbuild.1", status: "ACTIVE", issues: [] },
      { name: "eks-pod-identity-agent", version: "v1.3.4-eksbuild.1", latest: "v1.3.4-eksbuild.1", status: "ACTIVE", issues: [] },
      { name: "metrics-server", version: "v0.7.2-eksbuild.1", latest: "v0.7.2-eksbuild.1", status: "ACTIVE", issues: [] },
      { name: "amazon-cloudwatch-observability", version: "v2.1.2-eksbuild.1", latest: "v3.3.0-eksbuild.1", status: "DEGRADED", issues: ["InsufficientNumberOfReplicas: The add-on is unhealthy because it doesn't have the desired number of replicas."] },
    ],
    insights: [
      { name: "Kubelet version skew", category: "UPGRADE_READINESS", status: "WARNING", reason: "Kubelet version of node 'ip-10-0-12-250.ap-northeast-2.compute.internal' is 1 minor version behind the control plane version", description: "Checks for kubelet versions of worker nodes in the cluster to see if upgrade would cause non compliance with supported Kubernetes kubelet version skew policy.", kubernetesVersion: "1.32" },
      { name: "Deprecated APIs removed in Kubernetes v1.32", category: "UPGRADE_READINESS", status: "WARNING", reason: "Deprecated API usage detected: flowcontrol.apiserver.k8s.io/v1beta3 FlowSchema, PriorityLevelConfiguration", description: "Checks for usage of deprecated APIs that are scheduled for removal in Kubernetes v1.32.", kubernetesVersion: "1.32" },
      { name: "kube-proxy version skew", category: "UPGRADE_READINESS", status: "PASSING", reason: "kube-proxy versions match the cluster control plane version on all nodes.", description: null, kubernetesVersion: "1.32" },
      { name: "EKS add-on version compatibility", category: "UPGRADE_READINESS", status: "PASSING", reason: "All installed EKS add-on versions are compatible with the next Kubernetes version.", description: null, kubernetesVersion: "1.32" },
      { name: "Cluster health issues", category: "UPGRADE_READINESS", status: "PASSING", reason: "No cluster health issues detected.", description: null, kubernetesVersion: "1.32" },
    ],
    removedApis: [
      { kind: "FlowSchema", apiVersion: "flowcontrol.apiserver.k8s.io/v1beta3", replacement: "flowcontrol.apiserver.k8s.io/v1", removedIn: "1.32", namespace: null, name: "legacy-batch-throttle" },
      { kind: "PriorityLevelConfiguration", apiVersion: "flowcontrol.apiserver.k8s.io/v1beta3", replacement: "flowcontrol.apiserver.k8s.io/v1", removedIn: "1.32", namespace: null, name: "workload-low-legacy" },
    ],
    nextVersion: "1.32",
    skew: [{ node: NODE_SPECS[5].name, kubeletVersion: NODE_SPECS[5].kubelet, minorsBehind: 1 }],
    gaps: [],
  };
}

// ── 종류 발견 ───────────────────────────────────────────────────────────

const CRD_KINDS: K8sKind[] = [
  { group: "argoproj.io", version: "v1alpha1", kind: "Application", plural: "applications", namespaced: true, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], custom: true },
  { group: "argoproj.io", version: "v1alpha1", kind: "AppProject", plural: "appprojects", namespaced: true, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], custom: true },
  { group: "cert-manager.io", version: "v1", kind: "Certificate", plural: "certificates", namespaced: true, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], custom: true },
  { group: "cert-manager.io", version: "v1", kind: "ClusterIssuer", plural: "clusterissuers", namespaced: false, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], custom: true },
  { group: "karpenter.sh", version: "v1", kind: "NodePool", plural: "nodepools", namespaced: false, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], custom: true },
  { group: "karpenter.sh", version: "v1", kind: "NodeClaim", plural: "nodeclaims", namespaced: false, verbs: ["get", "list", "watch", "delete"], custom: true },
  { group: "karpenter.k8s.aws", version: "v1", kind: "EC2NodeClass", plural: "ec2nodeclasses", namespaced: false, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], custom: true },
  { group: "monitoring.coreos.com", version: "v1", kind: "ServiceMonitor", plural: "servicemonitors", namespaced: true, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], custom: true },
];

const kinds = (): K8sKind[] => [
  ...BUILTIN.map((k) => ({ ...k, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], custom: false })),
  ...CRD_KINDS,
];

// ── 변경 미리보기 ───────────────────────────────────────────────────────

const dangerous = (ns: string | null, name: string) => ns === "kube-system" || (ns?.toLowerCase().includes("prod") ?? false) || name.toLowerCase().includes("prod");

function preview(change: K8sChange): K8sPreview {
  const ns = change.namespace;
  const base = `/apis/${change.kind.group ? `${change.kind.group}/` : ""}${change.kind.version}`;
  const path = (sub = "") => `${change.kind.group ? base : "/api/v1"}${ns ? `/namespaces/${ns}` : ""}/${change.kind.plural}/${change.name}${sub}`;
  const confirmName = dangerous(ns, change.name) ? change.name : null;
  const w = WORKLOADS.find((x) => x.ns === ns && x.name === change.name);
  switch (change.type) {
    case "scale": {
      return {
        calls: [{ verb: "PATCH", path: path(), body: { metadata: { resourceVersion: "51394207" }, spec: { replicas: change.replicas } } }],
        diff: [{ path: "spec.replicas", before: w?.replicas ?? 3, after: change.replicas }],
        impact: ["원하는 Pod 수를 바꿉니다"],
        warnings: [],
        confirmName,
        reversible: true,
        conflicts: [],
      };
    }
    case "restart": {
      const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      return {
        calls: [{ verb: "PATCH", path: path(), body: { metadata: { resourceVersion: "51394207" }, spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": at } } } } } }],
        diff: [{ path: "spec.template.metadata.annotations.kubectl.kubernetes.io/restartedAt", before: null, after: at }],
        impact: ["새 Pod로 순차 교체합니다"],
        warnings: ["재시작은 직접 되돌릴 수 없어요. 롤아웃 되돌리기를 이용해 주세요"],
        confirmName,
        reversible: false,
        conflicts: [],
      };
    }
    case "delete":
      return {
        calls: [{ verb: "DELETE", path: path(), body: { preconditions: { resourceVersion: "51394207" } } }],
        diff: [{ path: "", before: change.name, after: null }],
        impact: ["객체를 삭제합니다"],
        warnings: ["소유자가 이 객체를 다시 만들 수 있어요"],
        confirmName: confirmName ?? change.name,
        reversible: false,
        conflicts: [],
      };
    default:
      return { calls: [{ verb: "PATCH", path: path(), body: null }], diff: [], impact: [], warnings: [], confirmName, reversible: true, conflicts: [] };
  }
}

// ── 감시 ────────────────────────────────────────────────────────────────

let nextWatch = 100;

function sendWatch(a: Args): number {
  const id = nextWatch++;
  const kind = a.kind as K8sKindRef;
  const ns = (a.namespace ?? null) as string | null;
  const rows = rowsOfKind(kind.kind).filter((r) => !kind.namespaced || ns === null || r.namespace === ns);
  const ch = a.onEvent as { onmessage: (m: K8sWatchMessage) => void };
  setTimeout(() => ch.onmessage({ type: "reset", rows }), 30);
  return id;
}

// ── 접근(권한 표·신원) ───────────────────────────────────────────────────

type Lv = number[];
const ALL2: Lv = [2, 2, 2, 2, 2, 2, 2];

interface AGrant {
  /** null이면 클러스터 전체 */
  ns: string | null;
  via: Via;
  binding: BindingRef | null;
  role: RoleView | null;
  /** 읽기·쓰기·삭제·셸·Secret·RBAC·권한 상승 칸의 수준(0 없음, 1 일부, 2 전부) */
  lv: Lv;
  agg?: string;
}

interface ASubject {
  subject: Subject;
  label: string | null;
  grants: AGrant[];
}

const clusterRole = (name: string): RoleView => ({ kind: "ClusterRole", namespace: null, name });
const crb = (name: string): BindingRef => ({ kind: "ClusterRoleBinding", namespace: null, name });
const rb = (ns: string, name: string): BindingRef => ({ kind: "RoleBinding", namespace: ns, name });
const DIRECT: Via = { kind: "direct" };
const viaGroup = (group: string): Via => ({ kind: "group", group });
const viaPolicy = (name: string): Via => ({ kind: "accessPolicy", policy: `arn:aws:eks::aws:cluster-access-policy/${name}` });
const builtin = (group: string): Via => ({ kind: "builtin", group });

const ssoArn = (set: string, id: string) => `arn:aws:iam::${ACCOUNT}:role/aws-reserved/sso.amazonaws.com/${REGION}/AWSReservedSSO_${set}_${id}`;
const PLATFORM_ARN = ssoArn("PlatformAdmin", "6f1c2a9b7d3e4f58");
const DEVELOPER_ARN = ssoArn("Developer", "a47d09e51b2c8f36");
const READONLY_ARN = ssoArn("ReadOnly", "3be8c1d7f0a95246");
const AUDIT_ARN = ssoArn("SecurityAudit", "c92e5a60d4b71f83");
const CI_ARN = `arn:aws:iam::${ACCOUNT}:role/github-actions-deploy`;
const NODE_ARN = `arn:aws:iam::${ACCOUNT}:role/eks-general-purpose-node-role`;
const LEGACY_ARN = `arn:aws:iam::${ACCOUNT}:role/eks-admin-legacy`;

const iamSubject = (name: string): Subject => ({ kind: "iam", name, namespace: null });
const groupSubject = (name: string): Subject => ({ kind: "group", name, namespace: null });
const userSubject = (name: string): Subject => ({ kind: "user", name, namespace: null });
const saSubject = (namespace: string, name: string): Subject => ({ kind: "serviceAccount", name, namespace });

const ASUBJECTS: ASubject[] = [
  { subject: iamSubject(PLATFORM_ARN), label: "PlatformAdmin", grants: [
    { ns: null, via: viaPolicy("AmazonEKSClusterAdminPolicy"), binding: null, role: clusterRole("cluster-admin"), lv: ALL2 },
    { ns: null, via: viaGroup("platform-admins"), binding: crb("platform-admins-cluster-admin"), role: clusterRole("cluster-admin"), lv: ALL2 },
  ] },
  { subject: iamSubject(DEVELOPER_ARN), label: "Developer", grants: [
    { ns: null, via: viaPolicy("AmazonEKSViewPolicy"), binding: null, role: clusterRole("view"), lv: [2, 0, 0, 0, 0, 0, 0], agg: "aggregate-to-view" },
    { ns: NS, via: viaGroup("commerce-developers"), binding: rb(NS, "commerce-developers-edit"), role: clusterRole("edit"), lv: [2, 2, 2, 2, 2, 0, 1] },
    { ns: "payments-prod", via: viaGroup("commerce-developers"), binding: rb("payments-prod", "commerce-developers-view"), role: clusterRole("view"), lv: [2, 0, 0, 0, 0, 0, 0] },
    { ns: "monitoring", via: viaGroup("commerce-developers"), binding: rb("monitoring", "commerce-developers-exec"), role: clusterRole("pod-exec"), lv: [1, 0, 0, 2, 0, 0, 0] },
  ] },
  { subject: iamSubject(READONLY_ARN), label: "ReadOnly", grants: [
    { ns: null, via: viaPolicy("AmazonEKSViewPolicy"), binding: null, role: clusterRole("view"), lv: [2, 0, 0, 0, 0, 0, 0], agg: "aggregate-to-view" },
  ] },
  { subject: iamSubject(AUDIT_ARN), label: "SecurityAudit", grants: [
    { ns: null, via: viaPolicy("AmazonEKSViewPolicy"), binding: null, role: clusterRole("view"), lv: [2, 0, 0, 0, 0, 0, 0], agg: "aggregate-to-view" },
    { ns: null, via: viaGroup("security-auditors"), binding: crb("security-auditors-audit"), role: clusterRole("security-audit"), lv: [2, 0, 0, 0, 1, 0, 0] },
  ] },
  { subject: iamSubject(CI_ARN), label: "github-actions-deploy", grants: [
    { ns: NS, via: viaGroup("ci-deployers"), binding: rb(NS, "ci-deploy"), role: clusterRole("deployer"), lv: [1, 2, 0, 0, 0, 0, 1] },
    { ns: "payments-prod", via: viaGroup("ci-deployers"), binding: rb("payments-prod", "ci-deploy"), role: clusterRole("deployer"), lv: [1, 2, 0, 0, 0, 0, 1] },
  ] },
  { subject: iamSubject(NODE_ARN), label: "eks-general-purpose-node-role", grants: [
    { ns: null, via: builtin("system:nodes"), binding: crb("system:node"), role: clusterRole("system:node"), lv: [1, 0, 0, 0, 1, 0, 0] },
  ] },

  { subject: groupSubject("system:masters"), label: null, grants: [{ ns: null, via: builtin("system:masters"), binding: crb("cluster-admin"), role: clusterRole("cluster-admin"), lv: ALL2 }] },
  { subject: groupSubject("platform-admins"), label: null, grants: [{ ns: null, via: DIRECT, binding: crb("platform-admins-cluster-admin"), role: clusterRole("cluster-admin"), lv: ALL2 }] },
  { subject: groupSubject("commerce-developers"), label: null, grants: [
    { ns: NS, via: DIRECT, binding: rb(NS, "commerce-developers-edit"), role: clusterRole("edit"), lv: [2, 2, 2, 2, 2, 0, 1] },
    { ns: "payments-prod", via: DIRECT, binding: rb("payments-prod", "commerce-developers-view"), role: clusterRole("view"), lv: [2, 0, 0, 0, 0, 0, 0] },
    { ns: "monitoring", via: DIRECT, binding: rb("monitoring", "commerce-developers-exec"), role: clusterRole("pod-exec"), lv: [1, 0, 0, 2, 0, 0, 0] },
  ] },
  { subject: groupSubject("ci-deployers"), label: null, grants: [
    { ns: NS, via: DIRECT, binding: rb(NS, "ci-deploy"), role: clusterRole("deployer"), lv: [1, 2, 0, 0, 0, 0, 1] },
    { ns: "payments-prod", via: DIRECT, binding: rb("payments-prod", "ci-deploy"), role: clusterRole("deployer"), lv: [1, 2, 0, 0, 0, 0, 1] },
  ] },
  { subject: groupSubject("security-auditors"), label: null, grants: [{ ns: null, via: DIRECT, binding: crb("security-auditors-audit"), role: clusterRole("security-audit"), lv: [2, 0, 0, 0, 1, 0, 0] }] },
  { subject: groupSubject("system:nodes"), label: null, grants: [{ ns: null, via: DIRECT, binding: crb("system:node"), role: clusterRole("system:node"), lv: [1, 0, 0, 0, 1, 0, 0] }] },
  { subject: groupSubject("system:authenticated"), label: null, grants: [{ ns: null, via: DIRECT, binding: crb("legacy-metrics-reader"), role: clusterRole("view"), lv: [2, 0, 0, 0, 0, 0, 0] }] },

  { subject: userSubject("ops-oncall"), label: null, grants: [
    { ns: null, via: DIRECT, binding: crb("ops-oncall-view"), role: clusterRole("view"), lv: [2, 0, 0, 0, 0, 0, 0] },
    { ns: NS, via: DIRECT, binding: rb(NS, "ops-oncall-exec"), role: clusterRole("pod-exec"), lv: [1, 0, 0, 2, 0, 0, 0] },
  ] },

  { subject: saSubject("argocd", "argocd-application-controller"), label: null, grants: [{ ns: null, via: DIRECT, binding: crb("argocd-application-controller"), role: clusterRole("cluster-admin"), lv: ALL2 }] },
  { subject: saSubject("karpenter", "karpenter"), label: null, grants: [{ ns: null, via: DIRECT, binding: crb("karpenter"), role: clusterRole("karpenter"), lv: [1, 1, 1, 0, 0, 0, 1] }] },
  { subject: saSubject("kube-system", "aws-load-balancer-controller"), label: null, grants: [{ ns: null, via: DIRECT, binding: crb("aws-load-balancer-controller"), role: clusterRole("aws-load-balancer-controller"), lv: [1, 1, 0, 0, 1, 0, 1] }] },
  { subject: saSubject("monitoring", "prometheus"), label: null, grants: [{ ns: null, via: DIRECT, binding: crb("prometheus"), role: clusterRole("prometheus"), lv: [1, 0, 0, 0, 0, 0, 0] }] },
  { subject: saSubject("cert-manager", "cert-manager"), label: null, grants: [
    { ns: null, via: DIRECT, binding: crb("cert-manager-controller-issuers"), role: clusterRole("cert-manager-controller-issuers"), lv: [1, 1, 0, 0, 0, 0, 0] },
    { ns: "cert-manager", via: DIRECT, binding: rb("cert-manager", "cert-manager-controller-secrets"), role: clusterRole("cert-manager-secrets"), lv: [0, 0, 0, 0, 2, 0, 0] },
  ] },
  { subject: saSubject(NS, "orders-api"), label: null, grants: [] },
];

const sameSubj = (a: Subject, b: Subject) => a.kind === b.kind && a.name === b.name && a.namespace === b.namespace;
const subjectOf = (s: Subject) => ASUBJECTS.find((x) => sameSubj(x.subject, s));
const applies = (g: AGrant, ns: string | null) => g.ns === null || (ns !== null && g.ns === ns);

function levelsFor(s: ASubject, ns: string | null): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const g of s.grants) if (applies(g, ns)) g.lv.forEach((v, i) => { out[i] = Math.max(out[i], v); });
  return out;
}

const CELL_ORDER: Cell[] = ["read", "write", "delete", "exec", "secretRead", "rbacWrite", "escalate"];
const RBAC_GROUP = "rbac.authorization.k8s.io";
const PROBES: Record<Cell, [string, string, string, string | null][]> = {
  read: [["get", "", "pods", null], ["list", "", "pods", null], ["get", "apps", "deployments", null], ["list", "", "services", null], ["list", "networking.k8s.io", "ingresses", null]],
  write: [["create", "apps", "deployments", null], ["patch", "apps", "deployments", null], ["update", "", "configmaps", null], ["create", "", "services", null]],
  delete: [["delete", "apps", "deployments", null], ["delete", "", "pods", null], ["deletecollection", "", "pods", null]],
  exec: [["create", "", "pods", "exec"], ["create", "", "pods", "attach"], ["create", "", "pods", "portforward"]],
  secretRead: [["get", "", "secrets", null], ["list", "", "secrets", null], ["watch", "", "secrets", null]],
  rbacWrite: [["create", RBAC_GROUP, "roles", null], ["update", RBAC_GROUP, "rolebindings", null], ["delete", RBAC_GROUP, "rolebindings", null]],
  escalate: [["escalate", RBAC_GROUP, "clusterroles", null], ["bind", RBAC_GROUP, "clusterroles", null], ["impersonate", "", "users", null], ["create", "", "serviceaccounts", "token"], ["create", "", "pods", null]],
};

function accessCell(subject: Subject, cell: Cell, namespace: string | null): CellDetail {
  const s = subjectOf(subject);
  const idx = CELL_ORDER.indexOf(cell);
  const using = (s?.grants ?? []).filter((g) => applies(g, namespace) && g.lv[idx] > 0);
  const level = using.reduce((m, g) => Math.max(m, g.lv[idx]), 0);
  const probes = PROBES[cell].map(([verb, group, resource, sub], i, all): ProbeResult => {
    const allowed = level === 2 || (level === 1 && (cell === "escalate" ? i === all.length - 1 : i < 2));
    const resourceName = sub ? `${resource}/${sub}` : resource;
    const grants: Grant[] = allowed
      ? using.filter((g) => g.lv[idx] === 2 || level === 1).map((g) => ({
          namespace: g.ns,
          rule: { verbs: [verb], apiGroups: [group], resources: [resourceName], resourceNames: [], nonResourceUrls: [] },
          source: { via: g.via, binding: g.binding, role: g.role, aggregatedFrom: g.agg ?? null, sessionDependent: false },
        }))
      : [];
    return { query: { verb, group, resource, subresource: sub, namespace, name: null }, allowed, namesOnly: false, direct: cell === "escalate" && i < all.length - 1 && allowed, grants };
  });
  return { subject, namespace, cell, level, probes };
}

function accessMatrix(q: MatrixQuery): MatrixPage {
  const text = q.text.toLowerCase();
  const rows = ASUBJECTS.filter((s) => (q.kinds.length === 0 || q.kinds.includes(s.subject.kind)) && (text === "" || s.subject.name.toLowerCase().includes(text) || (s.label ?? "").toLowerCase().includes(text)));
  return {
    total: rows.length,
    rows: rows.slice(q.offset, q.offset + q.limit).map((s) => ({ subject: s.subject, label: s.label, levels: q.namespaces.map((ns) => levelsFor(s, ns)) })),
  };
}

function mappingRow(arn: string, over: Partial<MappingRow>): MappingRow {
  const s = subjectOf(iamSubject(arn));
  return {
    source: "accessEntry", principalArn: arn, kind: "role", username: "", groups: [], accessType: "STANDARD", policies: [], permissionSet: null,
    label: arn.split("/").pop() ?? arn, effective: true, inactiveReason: null, subject: iamSubject(arn), levels: s ? levelsFor(s, null) : null, unevaluated: [], ...over,
  };
}

const sessionName = (set: string, id: string) => `arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_${set}_${id}/{{SessionName}}`;
const policyGrant = (name: string): PolicyGrant => ({ policyArn: `arn:aws:eks::aws:cluster-access-policy/${name}`, policyName: name, role: name.includes("ClusterAdmin") ? "cluster-admin" : "view", scope: { kind: "cluster" } });

function accessView(): AccessView {
  const mappings: MappingRow[] = [
    mappingRow(PLATFORM_ARN, { label: "PlatformAdmin", permissionSet: "PlatformAdmin", username: sessionName("PlatformAdmin", "6f1c2a9b7d3e4f58"), groups: ["platform-admins"], policies: [policyGrant("AmazonEKSClusterAdminPolicy")] }),
    mappingRow(DEVELOPER_ARN, { label: "Developer", permissionSet: "Developer", username: sessionName("Developer", "a47d09e51b2c8f36"), groups: ["commerce-developers"], policies: [policyGrant("AmazonEKSViewPolicy")] }),
    mappingRow(READONLY_ARN, { label: "ReadOnly", permissionSet: "ReadOnly", username: sessionName("ReadOnly", "3be8c1d7f0a95246"), groups: [], policies: [policyGrant("AmazonEKSViewPolicy")] }),
    mappingRow(AUDIT_ARN, { label: "SecurityAudit", permissionSet: "SecurityAudit", username: sessionName("SecurityAudit", "c92e5a60d4b71f83"), groups: ["security-auditors"], policies: [policyGrant("AmazonEKSViewPolicy")] }),
    mappingRow(CI_ARN, { label: "github-actions-deploy", username: "github-actions-deploy", groups: ["ci-deployers"] }),
    mappingRow(NODE_ARN, { source: "awsAuth", label: "eks-general-purpose-node-role", username: "system:node:{{EC2PrivateDNSName}}", groups: ["system:bootstrappers", "system:nodes"], accessType: null }),
    mappingRow(LEGACY_ARN, {
      source: "awsAuth", label: "eks-admin-legacy", username: "eks-admin", groups: ["system:masters"], accessType: null, effective: false, levels: null,
      inactiveReason: "같은 신원의 access entry가 있어서 aws-auth 매핑은 쓰이지 않아요",
    }),
  ];
  return {
    authMode: "API_AND_CONFIG_MAP",
    mode: "apiAndConfigMap",
    mappings,
    ssoGroups: ["PlatformAdmin", "Developer", "ReadOnly", "SecurityAudit"].map((set) => ({ permissionSet: set, principals: mappings.filter((m) => m.permissionSet === set).map((m) => m.principalArn) })),
    awsAuth: { present: true, accounts: [], errors: [] },
    namespaces: NAMESPACE_NAMES,
    subjectCount: ASUBJECTS.length,
    dangling: [
      { binding: { kind: "RoleBinding", namespace: "payments-prod", name: "legacy-etl-binding" }, role: clusterRole("etl-runner") },
      { binding: { kind: "ClusterRoleBinding", namespace: null, name: "old-datadog-reader" }, role: clusterRole("datadog-agent") },
    ],
    rbacAvailable: true,
    gaps: [],
    fetchedAt: iso(Date.now() - 4 * MIN).replace(/\.\d+Z$/, "Z"),
  };
}

function whoCan(q: AccessQuery): WhoCanView {
  const cell: Cell = q.resource === "secrets" ? "secretRead" : q.subresource === "exec" ? "exec" : ["create", "update", "patch"].includes(q.verb) ? "write" : q.verb === "delete" ? "delete" : "read";
  const idx = CELL_ORDER.indexOf(cell);
  const entries: WhoCan[] = ASUBJECTS.flatMap((s) => {
    const using = s.grants.filter((g) => applies(g, q.namespace) && g.lv[idx] > 0);
    if (using.length === 0) return [];
    return [{
      subject: s.subject, label: s.label,
      grants: using.map((g) => ({
        namespace: g.ns,
        rule: { verbs: [q.verb], apiGroups: [q.group], resources: [q.resource], resourceNames: [], nonResourceUrls: [] },
        source: { via: g.via, binding: g.binding, role: g.role, aggregatedFrom: g.agg ?? null, sessionDependent: false },
      })),
    }];
  });
  return { entries, total: entries.length };
}

function workloadIdentity(): WorkloadView {
  const item = (namespace: string, serviceAccount: string, role: string, pods: string[], over: Partial<WorkloadIdentity> = {}): WorkloadIdentity => ({
    namespace, serviceAccount, exists: true, irsa: { roleArn: `arn:aws:iam::${ACCOUNT}:role/${role}`, audience: "sts.amazonaws.com", check: { kind: "works" } },
    podIdentity: null, pods, podCount: pods.length, notes: [], ...over,
  });
  return {
    items: [
      item("kube-system", "aws-load-balancer-controller", "eks-prod-apne2-alb-controller", PODS_ALL.filter((p) => p.wl.name === "aws-load-balancer-controller").map((p) => p.name)),
      item("karpenter", "karpenter", "eks-prod-apne2-karpenter", PODS_ALL.filter((p) => p.wl.name === "karpenter").map((p) => p.name), {
        irsa: null,
        podIdentity: { associationId: "a-0f3c9d27e1b84a65c", roleArn: `arn:aws:iam::${ACCOUNT}:role/eks-prod-apne2-karpenter`, targetRoleArn: null, check: { kind: "works" } },
      }),
      item(NS, "orders-api", "commerce-orders-api-irsa", PODS_ALL.filter((p) => p.wl.name === "orders-api").map((p) => p.name)),
      item("payments-prod", "payments-api", "commerce-payments-api-irsa", PODS_ALL.filter((p) => p.wl.name === "payments-api").map((p) => p.name), {
        irsa: { roleArn: `arn:aws:iam::${ACCOUNT}:role/commerce-payments-api-irsa`, audience: "sts.amazonaws.com", check: { kind: "broken", reasons: ["역할의 신뢰 정책이 이 ServiceAccount(payments-prod/payments-api)를 허용하지 않아요"] } },
      }),
    ],
    oidcIssuer: OIDC,
    truncated: false,
    gaps: [],
  };
}

// ── 보안 점검 ───────────────────────────────────────────────────────────

const refOf = (k: K8sKindRef) => ({ group: k.group, version: k.version, kind: k.kind, plural: k.plural, namespaced: k.namespaced });
const CRB_KIND: K8sKindRef = { group: RBAC_GROUP, version: "v1", kind: "ClusterRoleBinding", plural: "clusterrolebindings", namespaced: false };
const CR_KIND: K8sKindRef = { group: RBAC_GROUP, version: "v1", kind: "ClusterRole", plural: "clusterroles", namespaced: false };
const SA_KIND: K8sKindRef = { group: "", version: "v1", kind: "ServiceAccount", plural: "serviceaccounts", namespaced: true };
const NS_KIND: K8sKindRef = { group: "", version: "v1", kind: "Namespace", plural: "namespaces", namespaced: false };

function objFinding(check: CheckId, severity: Severity, kind: K8sKindRef, ns: string | null, name: string, message: string, evidence: string[], fix: Fix | null = null, system = false): Finding {
  return { id: `${check}|${kind.group}/${kind.kind}/${ns ?? ""}/${name}`, check, severity, target: { type: "object", kind: refOf(kind), namespace: ns, name }, namespace: ns, system, message, evidence, fix };
}

function deploymentFix(ns: string, name: string, container: string, field: Record<string, unknown>, summary: string, caution: string): Fix {
  return {
    summary, caution, kind: refOf(DEPLOYMENTS), namespace: ns, name,
    object: { apiVersion: "apps/v1", kind: "Deployment", metadata: { name, namespace: ns }, spec: { template: { spec: { containers: [{ name: container, securityContext: field }] } } } },
  };
}

const saFix = (ns: string): Fix => ({
  summary: `${ns}/default ServiceAccount의 automountServiceAccountToken을 false로 바꿔요`,
  caution: "이 ServiceAccount를 쓰는 Pod가 API를 호출한다면 새로 뜨는 Pod부터 막혀요",
  kind: refOf(SA_KIND), namespace: ns, name: "default",
  object: { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "default", namespace: ns }, automountServiceAccountToken: false },
});

function findings(): SecurityReport {
  const f: Finding[] = [
    // 클러스터
    { id: "clusterVersionSupport|aws/cluster/prod-apne2", check: "clusterVersionSupport", severity: "medium", target: { type: "aws", resource: "cluster", name: CLUSTER }, namespace: null, system: false,
      message: "Kubernetes 1.31의 표준 지원이 22일 뒤(2026-11-26)에 끝나요", evidence: ["클러스터 버전: 1.31 (eks.12)", "표준 지원 종료: 2026-11-26", "확장 지원 종료: 2027-11-26 (표준 지원이 끝나면 클러스터당 시간당 추가 요금)"], fix: null },
    { id: "clusterAwsAuth|aws/cluster/prod-apne2", check: "clusterAwsAuth", severity: "low", target: { type: "aws", resource: "cluster", name: CLUSTER }, namespace: null, system: false,
      message: "aws-auth ConfigMap에 매핑이 2개 남아 있어요", evidence: ["인증 모드: API_AND_CONFIG_MAP", "kube-system/aws-auth: mapRoles 2개(eks-general-purpose-node-role, eks-admin-legacy)"], fix: null },
    { id: "clusterCreatorAdmin|aws/cluster/prod-apne2", check: "clusterCreatorAdmin", severity: "medium", target: { type: "aws", resource: "cluster", name: CLUSTER }, namespace: null, system: false,
      message: "클러스터 생성자에게 관리자 권한이 자동으로 붙어 있어요", evidence: ["bootstrapClusterCreatorAdminPermissions: true", `생성자: arn:aws:iam::${ACCOUNT}:user/terraform-bootstrap`], fix: null },
    { id: "imdsHopLimit|aws/nodegroup/legacy-v130", check: "imdsHopLimit", severity: "medium", target: { type: "aws", resource: "nodegroup", name: "legacy-v130" }, namespace: null, system: false,
      message: "노드의 IMDS 홉 제한이 2라서 Pod가 노드 역할 자격 증명을 읽을 수 있어요", evidence: ["시작 템플릿 lt-0a1b2c3d4e5f6a7b8 (버전 4)", "HttpPutResponseHopLimit: 2", "HttpTokens: required"], fix: null },

    // 권한
    { id: "adminSubject|serviceAccount/argocd/argocd-application-controller", check: "adminSubject", severity: "high", target: { type: "subject", subject: saSubject("argocd", "argocd-application-controller") }, namespace: "argocd", system: false,
      message: "ServiceAccount argocd/argocd-application-controller가 cluster-admin 권한을 가져요", evidence: ["ClusterRoleBinding argocd-application-controller → ClusterRole cluster-admin", "규칙: 모든 apiGroups·resources·verbs(*)"], fix: null },
    { id: "adminSubject|group/platform-admins", check: "adminSubject", severity: "medium", target: { type: "subject", subject: groupSubject("platform-admins") }, namespace: null, system: false,
      message: "그룹 platform-admins가 cluster-admin 권한을 가져요 (access entry 1개가 이 그룹을 써요)", evidence: ["ClusterRoleBinding platform-admins-cluster-admin → ClusterRole cluster-admin", `access entry ${PLATFORM_ARN.split("/").pop()}가 이 그룹을 줘요`], fix: null },
    objFinding("anonymousAccess", "high", CRB_KIND, null, "legacy-metrics-reader", "system:authenticated 그룹(접속할 수 있는 모든 IAM 신원)에게 view 권한을 줬어요",
      ["ClusterRoleBinding legacy-metrics-reader → ClusterRole view", "주체: Group system:authenticated", "만든 시각: 2025-03-11 (kubectl apply, field manager kubectl-client-side-apply)"]),
    objFinding("escalateBind", "high", CR_KIND, null, "ci-pipeline-runner", "ClusterRole ci-pipeline-runner가 clusterroles에 bind·escalate를 가져요",
      ["규칙: rbac.authorization.k8s.io clusterroles [bind, escalate, get, list]", "이 역할을 쓰는 바인딩: ClusterRoleBinding ci-pipeline-runner → ServiceAccount commerce-prod/ci-runner"]),
    objFinding("impersonate", "medium", CR_KIND, null, "support-impersonator", "ClusterRole support-impersonator가 users·groups에 impersonate를 가져요",
      ["규칙: \"\" users, groups [impersonate]", "이 역할을 쓰는 바인딩: ClusterRoleBinding support-impersonator → Group platform-admins"]),
    { id: "nodesProxy|serviceAccount/monitoring/prometheus", check: "nodesProxy", severity: "medium", target: { type: "subject", subject: saSubject("monitoring", "prometheus") }, namespace: "monitoring", system: false,
      message: "ServiceAccount monitoring/prometheus가 nodes/proxy에 get을 가져요", evidence: ["ClusterRoleBinding prometheus → ClusterRole prometheus", "규칙: \"\" nodes/proxy [get], nodes/metrics [get]"], fix: null },
    { id: "podCreateStrongSa|group/commerce-developers", check: "podCreateStrongSa", severity: "medium", target: { type: "subject", subject: groupSubject("commerce-developers") }, namespace: NS, system: false,
      message: "그룹 commerce-developers가 commerce-prod에서 Pod를 만들 수 있고, 그 네임스페이스에 강한 ServiceAccount가 있어요", evidence: ["RoleBinding commerce-prod/commerce-developers-edit → ClusterRole edit (pods create)", "같은 네임스페이스의 ServiceAccount ci-runner가 ClusterRole ci-pipeline-runner(bind·escalate)를 가져요"], fix: null },
    { id: "secretsReadAll|group/security-auditors", check: "secretsReadAll", severity: "medium", target: { type: "subject", subject: groupSubject("security-auditors") }, namespace: null, system: false,
      message: "그룹 security-auditors가 모든 네임스페이스의 Secret 이름을 읽을 수 있어요", evidence: ["ClusterRoleBinding security-auditors-audit → ClusterRole security-audit", "규칙: \"\" secrets [get, list]"], fix: null },
    objFinding("unusedRole", "low", { group: RBAC_GROUP, version: "v1", kind: "Role", plural: "roles", namespaced: true }, NS, "legacy-cronjob-runner", "Role commerce-prod/legacy-cronjob-runner를 쓰는 바인딩이 없어요", ["이 역할을 가리키는 RoleBinding·ClusterRoleBinding이 없어요", "규칙: batch jobs, cronjobs [create, delete, get, list]"]),
    objFinding("bindingMissingRole", "low", { group: RBAC_GROUP, version: "v1", kind: "RoleBinding", plural: "rolebindings", namespaced: true }, "payments-prod", "legacy-etl-binding", "RoleBinding payments-prod/legacy-etl-binding이 없는 ClusterRole etl-runner를 가리켜요", ["roleRef: ClusterRole etl-runner (찾을 수 없어요)", "주체: ServiceAccount payments-prod/etl"]),
    objFinding("bindingMissingSubject", "low", { group: RBAC_GROUP, version: "v1", kind: "RoleBinding", plural: "rolebindings", namespaced: true }, NS, "old-intern-view", "RoleBinding commerce-prod/old-intern-view의 ServiceAccount가 없어요", ["주체: ServiceAccount commerce-prod/intern (찾을 수 없어요)", "roleRef: ClusterRole view"]),

    // 워크로드
    objFinding("privileged", "high", PODS, NS, "debug-shell-alice", "privileged 컨테이너가 있어요", ["컨테이너 debug: securityContext.privileged: true", "이미지: nicolaka/netshoot:v0.13", "Pod 나이: 9일 (소유자 없음)"]),
    objFinding("privileged", "high", DAEMONSETS, "kube-system", "kube-proxy", "privileged 컨테이너가 있어요", ["컨테이너 kube-proxy: securityContext.privileged: true"], null, true),
    objFinding("privileged", "high", DEPLOYMENTS, "monitoring", "blackbox-exporter", "privileged 컨테이너가 있어요", ["컨테이너 blackbox-exporter: securityContext.privileged: true", "이미지: prom/blackbox-exporter:latest"],
      deploymentFix("monitoring", "blackbox-exporter", "blackbox-exporter", { privileged: false }, "컨테이너 blackbox-exporter의 privileged를 false로 바꿔요", "ICMP probe를 쓴다면 NET_RAW capability가 따로 필요해요. 바꾼 뒤 probe가 실패하는지 확인하세요")),
    objFinding("hostPath", "medium", DAEMONSETS, "monitoring", "node-exporter", "hostPath 볼륨으로 노드 파일 시스템을 마운트해요", ["볼륨 proc: hostPath /proc", "볼륨 sys: hostPath /sys", "볼륨 root: hostPath / (readOnly)"]),
    objFinding("hostNetwork", "medium", DAEMONSETS, "monitoring", "node-exporter", "hostNetwork: true로 노드 네트워크를 그대로 써요", ["spec.template.spec.hostNetwork: true", "포트: 9100 (노드 IP에 바로 열려요)"]),
    objFinding("hostPid", "medium", DAEMONSETS, "monitoring", "node-exporter", "hostPID: true로 노드의 프로세스를 볼 수 있어요", ["spec.template.spec.hostPID: true"]),
    objFinding("runsAsRoot", "medium", DEPLOYMENTS, NS, "search-indexer", "컨테이너가 root로 실행돼요", ["컨테이너 indexer: runAsNonRoot 미지정, runAsUser 미지정(이미지 기본값 root)"]),
    objFinding("runsAsRoot", "medium", DEPLOYMENTS, "payments-prod", "fraud-check", "컨테이너가 root로 실행돼요", ["컨테이너 fraud-check: runAsUser: 0"]),
    objFinding("privilegeEscalation", "medium", DEPLOYMENTS, NS, "web-frontend", "allowPrivilegeEscalation이 false가 아닌 컨테이너가 있어요", ["컨테이너 web: allowPrivilegeEscalation 미지정(기본값 true)"],
      deploymentFix(NS, "web-frontend", "web", { allowPrivilegeEscalation: false }, "컨테이너 web에 allowPrivilegeEscalation: false를 더해요", "Pod 템플릿이 바뀌어 Pod가 새로 만들어져요(롤아웃)")),
    objFinding("privilegeEscalation", "medium", DEPLOYMENTS, NS, "api-gateway", "allowPrivilegeEscalation이 false가 아닌 컨테이너가 있어요", ["컨테이너 gateway: allowPrivilegeEscalation 미지정(기본값 true)"],
      deploymentFix(NS, "api-gateway", "gateway", { allowPrivilegeEscalation: false }, "컨테이너 gateway에 allowPrivilegeEscalation: false를 더해요", "Pod 템플릿이 바뀌어 Pod가 새로 만들어져요(롤아웃)")),
    objFinding("privilegeEscalation", "medium", DEPLOYMENTS, NS, "orders-api", "allowPrivilegeEscalation이 false가 아닌 컨테이너가 있어요", ["컨테이너 orders-api: allowPrivilegeEscalation 미지정(기본값 true)", "컨테이너 otel-agent: allowPrivilegeEscalation 미지정(기본값 true)"],
      deploymentFix(NS, "orders-api", "orders-api", { allowPrivilegeEscalation: false }, "컨테이너 orders-api에 allowPrivilegeEscalation: false를 더해요", "Pod 템플릿이 바뀌어 Pod가 새로 만들어져요(롤아웃)")),
    objFinding("imageLatest", "medium", DEPLOYMENTS, "monitoring", "blackbox-exporter", "이미지 태그가 latest예요", ["컨테이너 blackbox-exporter: prom/blackbox-exporter:latest"]),
    objFinding("resourcesMissing", "low", DEPLOYMENTS, "argocd", "argocd-redis", "메모리 limit이 없는 컨테이너가 있어요", ["컨테이너 redis: resources.limits.memory 없음"]),
    objFinding("resourcesMissing", "low", DEPLOYMENTS, "monitoring", "blackbox-exporter", "CPU·메모리 requests가 없는 컨테이너가 있어요", ["컨테이너 blackbox-exporter: resources 없음"]),
    objFinding("probesMissing", "low", DEPLOYMENTS, NS, "notification-worker", "readinessProbe가 없는 컨테이너가 있어요", ["컨테이너 worker: readinessProbe 없음, livenessProbe 없음"]),
    objFinding("probesMissing", "low", DEPLOYMENTS, NS, "search-indexer", "readinessProbe가 없는 컨테이너가 있어요", ["컨테이너 indexer: readinessProbe 없음"]),
    objFinding("saTokenAutomount", "low", SA_KIND, NS, "default", "default ServiceAccount가 API 토큰을 자동으로 마운트해요", ["automountServiceAccountToken 미지정(기본값 true)", "이 ServiceAccount를 쓰는 Pod: 2개"], saFix(NS)),
    objFinding("saTokenAutomount", "low", SA_KIND, "payments-prod", "default", "default ServiceAccount가 API 토큰을 자동으로 마운트해요", ["automountServiceAccountToken 미지정(기본값 true)", "이 ServiceAccount를 쓰는 Pod: 0개"], saFix("payments-prod")),
    objFinding("noNetworkPolicy", "medium", NS_KIND, null, "monitoring", "NetworkPolicy가 없는 네임스페이스예요", ["네임스페이스 monitoring: Pod 9개, NetworkPolicy 0개", "모든 Pod가 클러스터 안의 어디서든 접근돼요"]),
    objFinding("noNetworkPolicy", "medium", NS_KIND, null, "argocd", "NetworkPolicy가 없는 네임스페이스예요", ["네임스페이스 argocd: Pod 7개, NetworkPolicy 0개"]),
    objFinding("noNetworkPolicy", "low", NS_KIND, null, "cert-manager", "NetworkPolicy가 없는 네임스페이스예요", ["네임스페이스 cert-manager: Pod 3개, NetworkPolicy 0개"]),
    // 시스템 네임스페이스(기본으로 숨겨요)
    objFinding("hostNetwork", "medium", DAEMONSETS, "kube-system", "aws-node", "hostNetwork: true로 노드 네트워크를 그대로 써요", ["spec.template.spec.hostNetwork: true"], null, true),
    objFinding("hostNetwork", "medium", DAEMONSETS, "kube-system", "kube-proxy", "hostNetwork: true로 노드 네트워크를 그대로 써요", ["spec.template.spec.hostNetwork: true"], null, true),
    objFinding("hostPath", "medium", DAEMONSETS, "kube-system", "ebs-csi-node", "hostPath 볼륨으로 노드 파일 시스템을 마운트해요", ["볼륨 kubelet-dir: hostPath /var/lib/kubelet"], null, true),
    objFinding("runsAsRoot", "medium", DAEMONSETS, "kube-system", "aws-node", "컨테이너가 root로 실행돼요", ["컨테이너 aws-node: runAsUser 미지정"], null, true),
  ];
  return { findings: f, skipped: [], gaps: [], fetchedAt: iso(Date.now() - 90_000).replace(/\.\d+Z$/, "Z") };
}

// ── Helm ────────────────────────────────────────────────────────────────

interface Rel {
  ns: string;
  name: string;
  chartName: string;
  chartVersion: string;
  appVersion: string;
  status: string;
  revision: number;
  /** 마지막 갱신이 몇 분 전인지 */
  agoMin: number;
  description: string;
  values: Record<string, unknown>;
  kinds?: string[];
}

const SERVICE_CHART = "magic-service";
const svcValues = (image: string, tag: string, replicas: number, extra: Record<string, unknown> = {}) => ({
  replicaCount: replicas,
  image: { repository: `${ECR}/${image}`, tag },
  service: { type: "ClusterIP", port: 80 },
  resources: { requests: { cpu: "250m", memory: "384Mi" }, limits: { cpu: "1", memory: "768Mi" } },
  ...extra,
});

const RELEASES: Rel[] = [
  { ns: NS, name: "orders-api", chartName: SERVICE_CHART, chartVersion: "0.18.4", appVersion: "v3.7.2", status: "deployed", revision: 21, agoMin: 6 * 60, description: "Upgrade complete",
    values: svcValues("orders-api", "v3.7.2", 3, { autoscaling: { enabled: true, minReplicas: 3, maxReplicas: 10, targetCPUUtilizationPercentage: 70 }, otel: { enabled: true }, env: { LOG_LEVEL: "info", PAYMENT_PROVIDER: "tosspayments", KAFKA_BROKERS: "kafka-0.kafka:9092,kafka-1.kafka:9092" }, pdb: { minAvailable: 2 } }) },
  { ns: NS, name: "web-frontend", chartName: SERVICE_CHART, chartVersion: "0.18.4", appVersion: "v2.41.0", status: "deployed", revision: 34, agoMin: 52 * 60, description: "Upgrade complete", values: svcValues("web-frontend", "v2.41.0", 3) },
  { ns: NS, name: "api-gateway", chartName: SERVICE_CHART, chartVersion: "0.18.4", appVersion: "v1.18.3", status: "deployed", revision: 17, agoMin: 52 * 60, description: "Upgrade complete", values: svcValues("api-gateway", "v1.18.3", 3) },
  { ns: NS, name: "catalog-api", chartName: SERVICE_CHART, chartVersion: "0.18.2", appVersion: "v2.9.0", status: "deployed", revision: 12, agoMin: 4 * 24 * 60, description: "Upgrade complete", values: svcValues("catalog-api", "v2.9.0", 2) },
  { ns: NS, name: "search-indexer", chartName: SERVICE_CHART, chartVersion: "0.18.4", appVersion: "v1.4.0-rc2", status: "failed", revision: 9, agoMin: 5 * 60, description: 'Upgrade "search-indexer" failed: timed out waiting for the condition', values: svcValues("search-indexer", "v1.4.0-rc2", 1) },
  { ns: NS, name: "redis-cache", chartName: "redis", chartVersion: "20.3.0", appVersion: "7.4.1", status: "deployed", revision: 4, agoMin: 14 * 24 * 60, description: "Upgrade complete",
    values: { architecture: "replication", auth: { enabled: true, existingSecret: "redis-cache-auth" }, replica: { replicaCount: 2 }, metrics: { enabled: true } } },
  { ns: "payments-prod", name: "payments-api", chartName: SERVICE_CHART, chartVersion: "0.18.4", appVersion: "v4.2.1", status: "pending-upgrade", revision: 15, agoMin: 3, description: "Preparing upgrade", values: svcValues("payments-api", "v4.2.1", 3) },
  { ns: "payments-prod", name: "payments-worker", chartName: SERVICE_CHART, chartVersion: "0.18.4", appVersion: "v4.2.1", status: "deployed", revision: 11, agoMin: 31 * 60, description: "Upgrade complete", values: svcValues("payments-worker", "v4.2.1", 2) },
  { ns: "payments-prod", name: "fraud-check", chartName: SERVICE_CHART, chartVersion: "0.17.9", appVersion: "v1.7.0", status: "deployed", revision: 6, agoMin: 9 * 24 * 60, description: "Upgrade complete", values: svcValues("fraud-check", "v1.7.0", 2) },
  { ns: "ingress-nginx", name: "ingress-nginx", chartName: "ingress-nginx", chartVersion: "4.11.3", appVersion: "1.11.3", status: "deployed", revision: 7, agoMin: 12 * 24 * 60, description: "Upgrade complete",
    values: { controller: { replicaCount: 3, service: { type: "LoadBalancer", annotations: { "service.beta.kubernetes.io/aws-load-balancer-type": "external", "service.beta.kubernetes.io/aws-load-balancer-scheme": "internet-facing" } }, metrics: { enabled: true } } } },
  { ns: "cert-manager", name: "cert-manager", chartName: "cert-manager", chartVersion: "v1.16.1", appVersion: "v1.16.1", status: "deployed", revision: 3, agoMin: 40 * 24 * 60, description: "Upgrade complete", values: { crds: { enabled: true }, prometheus: { enabled: true } } },
  { ns: "argocd", name: "argocd", chartName: "argo-cd", chartVersion: "7.7.5", appVersion: "v2.13.1", status: "deployed", revision: 12, agoMin: 20 * 24 * 60, description: "Upgrade complete",
    values: { global: { domain: "argocd.magic-store.example" }, server: { replicas: 2 }, repoServer: { replicas: 2 }, configs: { params: { "server.insecure": true } } } },
  { ns: "monitoring", name: "prometheus", chartName: "prometheus", chartVersion: "25.27.0", appVersion: "v2.55.1", status: "deployed", revision: 9, agoMin: 33 * 24 * 60, description: "Upgrade complete", values: { server: { retention: "15d", persistentVolume: { size: "100Gi", storageClass: "gp3" } }, alertmanager: { enabled: true } } },
  { ns: "monitoring", name: "grafana", chartName: "grafana", chartVersion: "8.6.0", appVersion: "11.3.0", status: "deployed", revision: 5, agoMin: 33 * 24 * 60, description: "Upgrade complete", values: { persistence: { enabled: true, size: "10Gi" }, adminExistingSecret: "grafana-admin" } },
  { ns: "monitoring", name: "blackbox-exporter", chartName: "prometheus-blackbox-exporter", chartVersion: "9.1.0", appVersion: "v0.25.0", status: "failed", revision: 2, agoMin: 26 * 60, description: 'Upgrade "blackbox-exporter" failed: cannot patch "blackbox-exporter" with kind Deployment: field is immutable', values: { replicas: 1 } },
  { ns: "kube-system", name: "aws-load-balancer-controller", chartName: "aws-load-balancer-controller", chartVersion: "1.9.2", appVersion: "v2.9.2", status: "deployed", revision: 4, agoMin: 31 * 24 * 60, description: "Upgrade complete", values: { clusterName: CLUSTER, serviceAccount: { create: true, name: "aws-load-balancer-controller" }, replicaCount: 2 } },
  { ns: "karpenter", name: "karpenter", chartName: "karpenter", chartVersion: "1.1.1", appVersion: "1.1.1", status: "deployed", revision: 6, agoMin: 8 * 24 * 60, description: "Upgrade complete", values: { settings: { clusterName: CLUSTER, interruptionQueue: CLUSTER }, controller: { resources: { requests: { cpu: "1", memory: "1Gi" } } } } },
];

const releaseAt = (r: Rel) => iso(NOW0 - r.agoMin * MIN);

function helmRelease(r: Rel): HelmRelease {
  return {
    name: r.name, namespace: r.ns, revision: r.revision, status: r.status, problem: r.status === "failed" || r.status.startsWith("pending-") || r.status === "unknown",
    chart: `${r.chartName}-${r.chartVersion}`, chartName: r.chartName, chartVersion: r.chartVersion, appVersion: r.appVersion, updated: releaseAt(r), description: r.description,
    revisions: Math.min(r.revision, 10), driver: "secret", unreadable: false,
  };
}

function helmHistory(r: Rel): HelmRevision[] {
  const out: HelmRevision[] = [];
  for (let rev = r.revision; rev > Math.max(0, r.revision - 8); rev--) {
    const latest = rev === r.revision;
    const failedMid = r.name === "orders-api" && rev === r.revision - 3;
    const chartVersion = rev <= r.revision - 6 ? "0.17.9" : r.chartVersion;
    const [patch] = r.appVersion.match(/\d+(?=(-|$))/) ?? ["0"];
    const appVersion = latest ? r.appVersion : r.appVersion.replace(/\d+(-.*)?$/, String(Math.max(0, Number(patch) - (r.revision - rev))));
    out.push({
      revision: rev,
      status: latest ? r.status : failedMid ? "failed" : "superseded",
      updated: iso(NOW0 - (r.agoMin + (r.revision - rev) * (r.name === "orders-api" ? 190 : 1900)) * MIN),
      chart: `${r.chartName}-${chartVersion}`, chartName: r.chartName, chartVersion, appVersion,
      description: latest ? r.description : failedMid ? "Upgrade failed: post-upgrade hooks failed: job orders-api-migrate failed" : rev === 1 ? "Install complete" : "Upgrade complete",
      unreadable: false,
    });
  }
  return out;
}

function helmDetail(ns: string, name: string, revision: number | null): HelmReleaseDetail {
  const r = RELEASES.find((x) => x.ns === ns && x.name === name)!;
  const history = helmHistory(r);
  const shown = revision === null ? history[0] : (history.find((h) => h.revision === revision) ?? history[0]);
  const computed = { ...r.values, nameOverride: "", fullnameOverride: "", podAnnotations: {}, nodeSelector: {}, tolerations: [], affinity: {}, serviceAccount: { create: true, name: "" }, securityContext: {} };
  const resources: HelmResource[] = [
    { apiVersion: "v1", kind: "ServiceAccount", name, namespace: ns },
    { apiVersion: "v1", kind: "ConfigMap", name: `${name}-config`, namespace: ns },
    { apiVersion: "v1", kind: "Service", name, namespace: ns },
    { apiVersion: "apps/v1", kind: r.chartName === "redis" ? "StatefulSet" : "Deployment", name, namespace: ns },
    ...(r.chartName === SERVICE_CHART ? [
      { apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", name, namespace: ns },
      { apiVersion: "policy/v1", kind: "PodDisruptionBudget", name, namespace: ns },
      { apiVersion: "networking.k8s.io/v1", kind: "Ingress", name, namespace: ns },
    ] : []),
  ];
  const manifest = resources
    .map((x) => `# Source: ${r.chartName}/templates/${x.kind.toLowerCase()}.yaml\n${stringify({ apiVersion: x.apiVersion, kind: x.kind, metadata: { name: x.name, namespace: ns, labels: { "app.kubernetes.io/name": name, "app.kubernetes.io/instance": name, "app.kubernetes.io/managed-by": "Helm", "helm.sh/chart": `${r.chartName}-${r.chartVersion}` } } })}`)
    .join("---\n");
  const first = history[history.length - 1];
  return {
    name, namespace: ns, revision: shown.revision, latest: r.revision, status: shown.status, problem: r.status === "failed" || r.status.startsWith("pending-"), description: shown.description,
    firstDeployed: first.updated, lastDeployed: shown.updated,
    notes: `1. 앱 주소를 확인하세요:\n   kubectl -n ${ns} get ingress ${name}\n2. 롤아웃 상태:\n   kubectl -n ${ns} rollout status deployment/${name}\n`,
    chart: {
      name: r.chartName, version: r.chartVersion, appVersion: r.appVersion,
      description: r.chartName === SERVICE_CHART ? "Magic Store 마이크로서비스 공통 차트" : `${r.chartName} Helm chart for Kubernetes`,
      home: r.chartName === SERVICE_CHART ? "https://git.magic-store.example/platform/charts" : `https://github.com/${r.chartName}`,
      kubeVersion: ">=1.25.0-0", deprecated: false,
      dependencies: r.chartName === "argo-cd" ? [{ name: "redis-ha", version: "4.27.5", repository: "https://dandydeveloper.github.io/charts/" }] : [],
    },
    userValues: stringify(r.values),
    computedValues: stringify(computed),
    manifest, resources,
    hooks: r.chartName === SERVICE_CHART ? [{ name: `${name}-migrate`, kind: "Job", events: ["pre-upgrade", "pre-install"] }] : [],
    history, driver: "secret",
  };
}

// ── 네트워크 ────────────────────────────────────────────────────────────

const VPC_ID = "vpc-0a1b2c3d";
const SUBNETS: Record<string, string> = { "ap-northeast-2a": "subnet-0a11b2c3", "ap-northeast-2b": "subnet-0b22c3d4", "ap-northeast-2c": "subnet-0c33d4e5" };
const lbZones = () => Object.entries(SUBNETS).map(([zone, subnetId]) => ({ zone, subnetId }));
const hashHex = (s: string, n = 10) => suffix(s, n, "0123456789abcdef");

function targetsOf(workload: string, port: number, unhealthyIndex = -1): TargetView[] {
  return PODS_ALL.filter((p) => p.wl.name === workload && podStatus(p) === "Running").map((p, i) => {
    const bad = i === unhealthyIndex;
    return {
      id: p.ip!, port, zone: p.node!.zone, state: bad ? "unhealthy" : "healthy",
      reason: bad ? "Target.FailedHealthChecks" : null, description: bad ? "Health checks failed with these codes: [503]" : null,
      link: { kind: "Pod", namespace: p.ns, name: p.name },
    };
  });
}

function nodeTargets(port: number): TargetView[] {
  return SCHEDULABLE.slice(0, 3).map((n) => ({ id: `i-0${hashHex(n.name, 16)}`, port, zone: n.zone, state: "healthy", reason: null, description: null, link: { kind: "Node", namespace: null, name: n.name } }));
}

function targetGroup(lb: string, workload: string, port: number, targets: TargetView[], opts: { path?: string | null; type?: string; protocol?: string } = {}): TargetGroupView {
  const short = `k8s-${NS.replace(/-/g, "")}-${workload.replace(/-/g, "").slice(0, 8)}-${hashHex(lb + workload)}`;
  return {
    arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/${short}/${hashHex(short + "a", 16)}`, name: short, protocol: opts.protocol ?? "HTTP", port,
    targetType: opts.type ?? "ip", healthCheck: { protocol: opts.protocol ?? "HTTP", port: "traffic-port", path: opts.path === undefined ? "/healthz" : opts.path }, targets,
  };
}

function alb(name: string, scheme: "internet-facing" | "internal", groups: TargetGroupView[], rules: { priority: string; conditions: string; action: string }[], https = true): LoadBalancerView {
  const id = hashHex(name, 16);
  const arn = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/${name}/${id}`;
  const dns = `${scheme === "internal" ? "internal-" : ""}${name}-${Math.floor(1_000_000_000 + (fnv(name) % 900_000_000))}.${REGION}.elb.amazonaws.com`;
  return {
    arn, name, dnsName: dns, kind: "application", scheme, state: "active", vpcId: VPC_ID, zones: lbZones(), securityGroups: [`sg-0${hashHex(name + "sg", 15)}`, "sg-0b7e1a94c2d5f3086"],
    listeners: [
      { arn: `${arn}/l80`, protocol: "HTTP", port: 80, sslPolicy: null, defaultAction: "redirect → HTTPS:443 (301)", rules: [] },
      ...(https ? [{ arn: `${arn}/l443`, protocol: "HTTPS", port: 443, sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06", defaultAction: "fixed-response 404 text/plain", rules }] : []),
    ],
    targetGroups: groups, gaps: [],
  };
}

function nlb(name: string, scheme: "internet-facing" | "internal", ports: [number, TargetGroupView][]): LoadBalancerView {
  const arn = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/net/${name}/${hashHex(name, 16)}`;
  return {
    arn, name, dnsName: `${name}-${hashHex(name + "d", 16)}.elb.${REGION}.amazonaws.com`, kind: "network", scheme, state: "active", vpcId: VPC_ID, zones: lbZones(), securityGroups: [`sg-0${hashHex(name + "sg", 15)}`],
    listeners: ports.map(([port, g]) => ({ arn: `${arn}/l${port}`, protocol: "TCP", port, sslPolicy: null, defaultAction: `forward → ${g.name}`, rules: [] })),
    targetGroups: ports.map(([, g]) => g), gaps: [],
  };
}

function network(): Network {
  const webTg = (lb: string) => targetGroup(lb, "web-frontend", 3000, targetsOf("web-frontend", 3000), { path: "/api/health" });
  const webLb = alb("k8s-commerce-web-9d2f4a1c7e", "internet-facing", [webTg("web")], [
    { priority: "10", conditions: "host-header: shop.magic-store.example", action: "forward → web-frontend (100%)" },
    { priority: "20", conditions: "host-header: www.magic-store.example", action: "redirect → https://shop.magic-store.example (301)" },
  ]);
  const gwTg = targetGroup("gw", "api-gateway", 8080, targetsOf("api-gateway", 8080, 2), { path: "/healthz" });
  const gwLb = alb("k8s-commerce-apigw-7d4e9b21c3", "internet-facing", [gwTg], [
    { priority: "10", conditions: "host-header: api.magic-store.example, path-pattern: /v1/*", action: "forward → api-gateway (100%)" },
    { priority: "20", conditions: "host-header: api.magic-store.example, http-header: X-Canary=1", action: "forward → api-gateway (100%)" },
  ]);
  const ordersLb = nlb("k8s-commerce-ordersgr-3f9a61bd20", "internal", [[9090, targetGroup("og", "orders-grpc", 9090, targetsOf("orders-api", 9090), { path: null, protocol: "TCP" })]]);
  const nginxLb = nlb("k8s-ingressn-ingressn-b41e8c0d93", "internet-facing", [
    [80, targetGroup("ng80", "ingress-nginx", 30080, nodeTargets(30080), { type: "instance", protocol: "TCP", path: null })],
    [443, targetGroup("ng443", "ingress-nginx", 30443, nodeTargets(30443), { type: "instance", protocol: "TCP", path: null })],
  ]);
  const payLb = alb("k8s-payments-payapi-5c81d2e9fa", "internet-facing", [targetGroup("pay", "payments-api", 8080, targetsOf("payments-api", 8080), { path: "/healthz" })], [
    { priority: "10", conditions: "host-header: pay.magic-store.example", action: "forward → payments-api (100%)" },
  ]);
  const argoLb = alb("k8s-argocd-argocdse-2a9e7f10b4", "internal", [targetGroup("argo", "argocd-server", 8080, targetsOf("argocd-server", 8080), { path: "/healthz" })], [
    { priority: "10", conditions: "host-header: argocd.magic-store.example", action: "forward → argocd-server (100%)" },
  ]);
  const grafanaLb = alb("k8s-monitori-grafana-e60b3c7a15", "internal", [targetGroup("gf", "grafana", 3000, targetsOf("grafana", 3000), { path: "/api/health" })], [
    { priority: "10", conditions: "host-header: grafana.magic-store.example", action: "forward → grafana (100%)" },
  ]);
  const rows: LbRow[] = [
    { kind: "ingress", namespace: NS, name: "web-frontend", class: "alb", hostnames: [webLb.dnsName], ips: [], ports: ["shop.magic-store.example → web-frontend:3000", "www.magic-store.example → redirect"], group: "magic-store-public", loadBalancer: webLb, matchedBy: "both", unmatched: null },
    { kind: "ingress", namespace: NS, name: "api-gateway", class: "alb", hostnames: [gwLb.dnsName], ips: [], ports: ["api.magic-store.example/v1/* → api-gateway:8080"], group: "magic-store-public", loadBalancer: gwLb, matchedBy: "both", unmatched: null },
    { kind: "service", namespace: NS, name: "orders-grpc", class: "service.beta.kubernetes.io/aws-load-balancer-type: external", hostnames: [ordersLb.dnsName], ips: [], ports: ["9090:31744/TCP"], group: null, loadBalancer: ordersLb, matchedBy: "hostname", unmatched: null },
    { kind: "ingress", namespace: NS, name: "report-generator", class: "alb", hostnames: [], ips: [], ports: ["reports.magic-store.example → report-generator:8080"], group: null, loadBalancer: null, matchedBy: null, unmatched: "pending" },
    { kind: "service", namespace: "ingress-nginx", name: "ingress-nginx-controller", class: "service.beta.kubernetes.io/aws-load-balancer-type: external", hostnames: [nginxLb.dnsName], ips: [], ports: ["80:30080/TCP", "443:30443/TCP"], group: null, loadBalancer: nginxLb, matchedBy: "hostname", unmatched: null },
    { kind: "ingress", namespace: "payments-prod", name: "payments-api", class: "alb", hostnames: [payLb.dnsName], ips: [], ports: ["pay.magic-store.example → payments-api:8080"], group: null, loadBalancer: payLb, matchedBy: "both", unmatched: null },
    { kind: "ingress", namespace: "argocd", name: "argocd-server", class: "alb", hostnames: [argoLb.dnsName], ips: [], ports: ["argocd.magic-store.example → argocd-server:8080"], group: "internal-tools", loadBalancer: argoLb, matchedBy: "tag", unmatched: null },
    { kind: "ingress", namespace: "monitoring", name: "grafana", class: "alb", hostnames: [grafanaLb.dnsName], ips: [], ports: ["grafana.magic-store.example → grafana:3000"], group: "internal-tools", loadBalancer: grafanaLb, matchedBy: "tag", unmatched: null },
  ];
  const nodes: NodeNet[] = NODE_SPECS.map((n) => ({
    name: n.name, ready: true, providerId: `aws:///${n.zone}/i-0${hashHex(n.name, 16)}`, instanceId: `i-0${hashHex(n.name, 16)}`, fargate: false, instanceType: n.instanceType,
    internalIp: n.name.replace(/^ip-/, "").replace(/\..*$/, "").replace(/-/g, "."), zone: n.zone, instanceState: "running", subnetId: SUBNETS[n.zone],
  }));
  const subnets: SubnetNet[] = Object.entries(SUBNETS).map(([zone, id], i) => ({
    id, name: `prod-private-${zone.slice(-1)}`, zone, cidrs: [`10.0.${11 + i}.0/24`], availableIps: 90 + i * 17, capacity: 251, nodeCount: NODE_SPECS.filter((n) => n.zone === zone).length,
    podCount: PODS_ALL.filter((p) => p.node?.zone === zone).length,
  }));
  const pods: PodNet[] = PODS_ALL.filter((p) => p.ip).map((p) => ({ namespace: p.ns, name: p.name, ip: p.ip!, node: p.node!.name, hostNetwork: p.wl.name === "node-exporter" || p.wl.name === "kube-proxy" || p.wl.name === "aws-node", subnetId: SUBNETS[p.node!.zone] }));
  const dns: PolicyRule = { peers: [{ podSelector: null, namespaceSelector: "kubernetes.io/metadata.name=kube-system", ipBlock: null }], ports: [{ protocol: "UDP", port: "53", endPort: null }, { protocol: "TCP", port: "53", endPort: null }] };
  const policies: PolicyView[] = [
    { namespace: NS, name: "default-deny-ingress", podSelector: "(모든 Pod)", types: ["Ingress"], ingress: [], egress: [], createdAt: iso(NOW0 - 80 * 86_400_000) },
    { namespace: NS, name: "allow-from-ingress-nginx", podSelector: "app.kubernetes.io/part-of=magic-store", types: ["Ingress"], ingress: [{ peers: [{ podSelector: null, namespaceSelector: "kubernetes.io/metadata.name=ingress-nginx", ipBlock: null }], ports: [{ protocol: "TCP", port: "8080", endPort: null }] }], egress: [], createdAt: iso(NOW0 - 80 * 86_400_000) },
    { namespace: NS, name: "allow-egress-dns", podSelector: "(모든 Pod)", types: ["Egress"], ingress: [], egress: [dns], createdAt: iso(NOW0 - 80 * 86_400_000) },
    { namespace: "payments-prod", name: "default-deny-all", podSelector: "(모든 Pod)", types: ["Ingress", "Egress"], ingress: [], egress: [], createdAt: iso(NOW0 - 60 * 86_400_000) },
    { namespace: "payments-prod", name: "allow-from-commerce", podSelector: "app.kubernetes.io/name=payments-api", types: ["Ingress"], ingress: [{ peers: [{ podSelector: null, namespaceSelector: `kubernetes.io/metadata.name=${NS}`, ipBlock: null }], ports: [{ protocol: "TCP", port: "8080", endPort: null }] }], egress: [], createdAt: iso(NOW0 - 60 * 86_400_000) },
  ];
  return {
    vpcId: VPC_ID,
    loadBalancers: rows,
    unclaimed: [
      { arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/k8s-legacyin-legacyin-a9c4e1f2b0/${hashHex("legacy", 16)}`, name: "k8s-legacyin-legacyin-a9c4e1f2b0", dnsName: `k8s-legacyin-legacyin-a9c4e1f2b0-1948273650.${REGION}.elb.amazonaws.com`, kind: "application", scheme: "internet-facing", state: "active", stack: "legacy/legacy-ingress" },
    ],
    nodes, subnets, pods: { vpcCni: true, items: pods, outside: 0, partial: false }, policies,
    namespaces: NAMESPACE_NAMES.map((name) => ({ name, policies: policies.filter((p) => p.namespace === name).length, system: name.startsWith("kube-") })),
    highlight: [...nodes.map((n) => n.instanceId!), ...rows.flatMap((r) => (r.loadBalancer ? [r.loadBalancer.arn] : []))],
    gaps: [],
  };
}

// ── 명령 ────────────────────────────────────────────────────────────────

const RULES = (namespace: string): K8sRules => ({
  namespace,
  resourceRules: [{ verbs: ["*"], apiGroups: ["*"], resources: ["*"], resourceNames: [] }],
  nonResourceRules: [{ verbs: ["*"], nonResourceUrls: ["*"] }],
  incomplete: false,
});

const arnOf = (cluster: string) => `arn:aws:eks:${REGION}:${ACCOUNT}:cluster/${cluster}`;

/** 다루지 않는 명령이면 undefined를 돌려준다 */
export function k8sMock(cmd: string, a: Args): unknown {
  switch (cmd) {
    case "k8s_context": {
      const cluster = (a.target as K8sTarget).cluster;
      return {
        arn: arnOf(cluster),
        endpoint: ENDPOINT,
        version: "1.31",
        endpointPublic: true,
        endpointPrivate: true,
        publicCidrs: ["203.0.113.0/24", "198.51.100.17/32"],
        kubeconfigMissing: false,
        kubeconfigPaths: ["/Users/demo/.kube/config"],
        candidates: [{ name: cluster, cluster: arnOf(cluster), user: arnOf(cluster), namespace: cluster === CLUSTER ? NS : null, execProfile: "prod" }],
        chosen: cluster,
        savedMissing: null,
        updateCommand: `aws eks update-kubeconfig --name ${cluster} --region ${REGION} --profile prod --alias ${cluster}`,
      };
    }
    case "k8s_open":
      return {
        context: a.context,
        execProfile: "prod",
        identity: { username: "alice", groups: ["platform-admins"], arn: `arn:aws:iam::${ACCOUNT}:role/PlatformAdmin`, source: "selfSubjectReview" },
        serverVersion: "v1.31.4-eks-2d5f260",
      };
    case "k8s_close":
    case "k8s_unwatch":
      return null;
    case "k8s_rules":
      return RULES(a.namespace);
    case "k8s_kinds":
      return kinds();
    case "k8s_watch":
      return sendWatch(a);
    case "k8s_get":
      return getObject(a.kind, a.namespace ?? null, a.name);
    case "k8s_metrics": {
      backfill(a.target);
      return metricsAt(Date.now(), a.namespace ?? null);
    }
    case "k8s_overview":
      return overview();
    case "k8s_revisions":
      return [
        { revision: "12", name: `${a.object.name}-5b9c8d7f66` },
        { revision: "13", name: `${a.object.name}-7f6d5c8b94` },
      ];
    case "k8s_preview":
      return preview(a.change as K8sChange);
    case "k8s_apply":
      return { logId: `log-${Date.now()}` };
    case "k8s_logs": {
      const p = PODS_ALL.find((q) => q.ns === a.namespace && q.name === a.pod);
      if (p) sendLogs({ ...a, options: { ...a.options, container: a.options?.container ?? null } }, p.wl, p);
      return nextWatch++;
    }
    case "k8s_workload_logs": {
      const w = WORKLOADS.find((x) => x.ns === a.namespace && x.name === a.name);
      if (w) sendLogs(a, w);
      return nextWatch++;
    }
    case "k8s_forward_list":
    case "k8s_change_log":
      return [];
    case "k8s_access":
      return accessView();
    case "k8s_access_matrix":
      return accessMatrix(a.query as MatrixQuery);
    case "k8s_access_cell":
      return accessCell(a.subject as Subject, a.cell as Cell, a.namespace ?? null);
    case "k8s_who_can":
      return whoCan(a.query as AccessQuery);
    case "k8s_review":
      return { allowed: true, denied: false, reason: null };
    case "k8s_workload_identity":
      return workloadIdentity();
    case "k8s_findings":
      return findings();
    case "k8s_network":
      return network();
    case "k8s_helm_tool":
      return { available: true, path: "/opt/homebrew/bin/helm", version: "v3.16.3", reason: null };
    case "k8s_helm_releases":
      return RELEASES.filter((r) => a.namespace == null || r.ns === a.namespace).map(helmRelease);
    case "k8s_helm_release":
      return helmDetail(a.namespace, a.name, a.revision ?? null);
    case "k8s_helm_show_values":
      return "replicaCount: 1\nimage:\n  repository: \"\"\n  tag: \"\"\n";
    case "k8s_shell_confirm_name":
      return dangerous(a.namespace, a.pod) ? a.pod : null;
    default:
      return cmd.startsWith("k8s_") ? null : undefined;
  }
}

// ── EKS 클러스터 목록(사이드바) ──────────────────────────────────────────

function cluster(name: string, version: string, status: string, hostPrefix: string) {
  const endpoint = `https://${hostPrefix}.gr7.${REGION}.eks.amazonaws.com`;
  const values = { name, id: name, version, status, endpoint };
  return {
    id: name,
    name,
    arn: arnOf(name),
    values,
    tags: { Team: "platform", Env: name.startsWith("prod") ? "prod" : name.startsWith("staging") ? "staging" : "prod" },
    fields: [
      { label: "ARN", value: arnOf(name) },
      { label: "Platform version", value: version === "1.31" ? "eks.12" : "eks.20" },
      { label: "Created", value: "2025-08-14 10:22" },
    ],
    raw: JSON.stringify({ ...values, arn: arnOf(name) }, null, 2),
    consoleUrl: `https://${REGION}.console.aws.amazon.com/eks/home?region=${REGION}#/clusters/${name}`,
  };
}

function nodeGroup(name: string, clusterName: string, instanceTypes: string, size: string) {
  const values = { name, id: name, cluster: clusterName, status: "ACTIVE", instanceTypes, size };
  return {
    id: `${clusterName}/${name}`,
    name,
    arn: `arn:aws:eks:${REGION}:${ACCOUNT}:nodegroup/${clusterName}/${name}/0a1b2c3d`,
    values,
    tags: { Team: "platform" },
    fields: [],
    raw: JSON.stringify(values, null, 2),
    consoleUrl: null,
  };
}

/** list_resources가 돌려줄 목록: "서비스/타입" → 항목 */
export const k8sResources: Record<string, unknown[]> = {
  "eks/clusters": [
    cluster(CLUSTER, "1.31", "ACTIVE", "8F3A27C41B9D5E60A1C7D2B3E4F58901"),
    cluster("staging-apne2", "1.31", "ACTIVE", "3C91D07AE5B24F68B0A1C9D7E2F43650"),
    cluster("ml-training", "1.30", "ACTIVE", "B7E20A94C1D35F86E2A07B9C4D1F6382"),
  ],
  "eks/node-groups": [
    nodeGroup("general-purpose", CLUSTER, "m6i.xlarge", "3 / 4 / 6"),
    nodeGroup("legacy-v130", CLUSTER, "m5.xlarge", "1 / 1 / 2"),
    nodeGroup("default", "staging-apne2", "t3.large", "2 / 2 / 4"),
    nodeGroup("gpu-a10g", "ml-training", "g5.2xlarge", "0 / 2 / 8"),
  ],
};
