import type { K8sRules } from "../types";
import type { Finding, Fix, SecurityReport } from "./types";

export const TARGET = { profile: "app", region: "ap-northeast-2", cluster: "prod" };

const DEPLOYMENT = { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true };
const SERVICE_ACCOUNT = { group: "", version: "v1", kind: "ServiceAccount", plural: "serviceaccounts", namespaced: true };

/** 문제 하나. 기본은 dev 네임스페이스 Deployment의 privileged */
export function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "privileged|apps/Deployment/dev/web",
    check: "privileged",
    severity: "high",
    target: { type: "object", kind: DEPLOYMENT, namespace: "dev", name: "web" },
    namespace: "dev",
    system: false,
    message: "privileged 컨테이너가 있어요",
    evidence: ["컨테이너 app: privileged: true"],
    fix: null,
    ...over,
  };
}

export const saFix: Fix = {
  summary: "default ServiceAccount의 automountServiceAccountToken을 false로 바꿔요",
  caution: "이 ServiceAccount를 쓰는 Pod가 API를 호출한다면 새로 뜨는 Pod부터 막혀요",
  kind: SERVICE_ACCOUNT,
  namespace: "dev",
  name: "default",
  object: { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "default", namespace: "dev" }, automountServiceAccountToken: false },
};

export const escalationFix: Fix = {
  summary: "컨테이너 app에 allowPrivilegeEscalation: false를 더해요",
  caution: "Pod 템플릿이 바뀌어 Pod가 새로 만들어져요(롤아웃)",
  kind: DEPLOYMENT,
  namespace: "dev",
  name: "web",
  object: {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "dev" },
    spec: { template: { spec: { containers: [{ name: "app", securityContext: { allowPrivilegeEscalation: false } }] } } },
  },
};

export const FINDINGS: Finding[] = [
  finding(),
  finding({
    id: "privilegeEscalation|apps/Deployment/dev/web",
    check: "privilegeEscalation",
    severity: "medium",
    message: "allowPrivilegeEscalation이 false가 아닌 컨테이너가 있어요",
    evidence: ["컨테이너 app: allowPrivilegeEscalation 미지정(기본값 true)"],
    fix: escalationFix,
  }),
  finding({
    id: "saTokenAutomount|/ServiceAccount/dev/default",
    check: "saTokenAutomount",
    severity: "low",
    target: { type: "object", kind: SERVICE_ACCOUNT, namespace: "dev", name: "default" },
    message: "dev의 default ServiceAccount 토큰이 Pod에 자동으로 마운트돼요",
    evidence: ["쓰는 워크로드: Deployment web"],
    fix: saFix,
  }),
  finding({
    id: "privileged|apps/DaemonSet/kube-system/agent",
    target: { type: "object", kind: { ...DEPLOYMENT, kind: "DaemonSet", plural: "daemonsets" }, namespace: "kube-system", name: "agent" },
    namespace: "kube-system",
    system: true,
    message: "privileged 컨테이너가 있어요(시스템)",
  }),
  finding({
    id: "clusterPublicEndpoint|aws:cluster/prod",
    check: "clusterPublicEndpoint",
    target: { type: "aws", resource: "cluster", name: "prod" },
    namespace: null,
    message: "API 서버의 퍼블릭 엔드포인트가 모든 IP(0.0.0.0/0)에 열려 있어요",
    evidence: ["허용 CIDR: 0.0.0.0/0", "프라이빗 엔드포인트: 켬"],
  }),
  finding({
    id: "adminSubject|iam:arn:aws:iam::1:role/ops",
    check: "adminSubject",
    target: { type: "subject", subject: { kind: "iam", name: "arn:aws:iam::1:role/ops", namespace: null } },
    namespace: null,
    message: "IAM 주체 ops에게 클러스터 전체의 모든 권한이 있어요",
    evidence: ["클러스터 전체: access policy AmazonEKSClusterAdminPolicy"],
  }),
  finding({
    id: "secretsReadAll|sa:ci/runner",
    check: "secretsReadAll",
    target: { type: "subject", subject: { kind: "serviceAccount", name: "runner", namespace: "ci" } },
    namespace: "ci",
    message: "ServiceAccount ci/runner이(가) 모든 네임스페이스의 Secret을 읽을 수 있어요",
  }),
  finding({
    id: "anonymousAccess|rbac.authorization.k8s.io/ClusterRoleBinding//peek-anon",
    check: "anonymousAccess",
    severity: "high",
    target: { type: "object", kind: { group: "rbac.authorization.k8s.io", version: "v1", kind: "ClusterRoleBinding", plural: "clusterrolebindings", namespaced: false }, namespace: null, name: "peek-anon" },
    namespace: null,
    message: "로그인하지 않은 누구나(익명: system:unauthenticated) 쓸 수 있는 권한이 있어요",
    evidence: ["system:unauthenticated ClusterRole peek: get,list configmaps"],
  }),
];

export const report = (over: Partial<SecurityReport> = {}): SecurityReport => ({ findings: FINDINGS, skipped: [], gaps: [], fetchedAt: "2026-11-03T01:02:03Z", ...over });

export const ALLOWED: K8sRules = { namespace: "dev", incomplete: false, nonResourceRules: [], resourceRules: [{ verbs: ["*"], apiGroups: ["*"], resources: ["*"], resourceNames: [] }] };
export const READ_ONLY: K8sRules = { namespace: "dev", incomplete: false, nonResourceRules: [], resourceRules: [{ verbs: ["get", "list"], apiGroups: ["*"], resources: ["*"], resourceNames: [] }] };
