import type { LbRow, LoadBalancerView, Network, NodeNet, PodNet, PolicyView, SubnetNet, TargetView } from "./types";

export const LB_ARN = "arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/web/1";

export const target = (over: Partial<TargetView> = {}): TargetView => ({
  id: "10.0.1.77", port: 8080, zone: "ap-northeast-2a", state: "healthy", reason: null, description: null, link: null, ...over,
});

export const loadBalancer = (over: Partial<LoadBalancerView> = {}): LoadBalancerView => ({
  arn: LB_ARN,
  name: "web",
  dnsName: "web-1.ap-northeast-2.elb.amazonaws.com",
  kind: "application",
  scheme: "internet-facing",
  state: "active",
  vpcId: "vpc-1",
  zones: [{ zone: "ap-northeast-2a", subnetId: "subnet-a" }],
  securityGroups: ["sg-1"],
  listeners: [
    {
      arn: "l1", protocol: "HTTPS", port: 443, sslPolicy: "ELBSecurityPolicy-2016-08", defaultAction: "forward: web-tg",
      rules: [{ priority: "10", conditions: "host-header: shop.example.com", action: "forward: api-tg" }],
    },
    { arn: "l2", protocol: "HTTP", port: 80, sslPolicy: null, defaultAction: "redirect: HTTPS:443 (HTTP_301)", rules: [] },
  ],
  targetGroups: [
    {
      arn: "tg1", name: "web-tg", protocol: "HTTP", port: 8080, targetType: "ip", healthCheck: { protocol: "HTTP", port: "traffic-port", path: "/healthz" },
      targets: [
        target({ id: "10.0.1.78", state: "unhealthy", reason: "Target.FailedHealthChecks", description: "Health checks failed", link: { kind: "Pod", namespace: "shop", name: "web-2" } }),
        target({ link: { kind: "Pod", namespace: "shop", name: "web-1" } }),
      ],
    },
  ],
  gaps: [],
  ...over,
});

export const row = (over: Partial<LbRow> = {}): LbRow => ({
  kind: "service", namespace: "shop", name: "web", class: null, hostnames: ["web-1.ap-northeast-2.elb.amazonaws.com"], ips: [], ports: ["80/TCP"], group: null,
  loadBalancer: loadBalancer(), matchedBy: "hostname", unmatched: null, ...over,
});

export const node = (over: Partial<NodeNet> = {}): NodeNet => ({
  name: "ip-10-0-0-10", ready: true, providerId: "aws:///ap-northeast-2a/i-0aaa", instanceId: "i-0aaa", fargate: false, instanceType: "m6i.large",
  internalIp: "10.0.0.10", zone: "ap-northeast-2a", instanceState: "running", subnetId: "subnet-a", ...over,
});

export const subnet = (over: Partial<SubnetNet> = {}): SubnetNet => ({
  id: "subnet-a", name: "private-a", zone: "ap-northeast-2a", cidrs: ["10.0.0.0/24"], availableIps: 100, capacity: 251, nodeCount: 1, podCount: 3, ...over,
});

export const pod = (over: Partial<PodNet> = {}): PodNet => ({
  namespace: "shop", name: "web-1", ip: "10.0.0.77", node: "ip-10-0-0-10", hostNetwork: false, subnetId: "subnet-a", ...over,
});

export const policy = (over: Partial<PolicyView> = {}): PolicyView => ({
  namespace: "shop", name: "allow-web", podSelector: "app=api", types: ["Ingress"],
  ingress: [{ peers: [{ podSelector: "app=web", namespaceSelector: null, ipBlock: null }], ports: [{ protocol: "TCP", port: "8080", endPort: null }] }],
  egress: [], createdAt: null, ...over,
});

export const network = (over: Partial<Network> = {}): Network => ({
  vpcId: "vpc-1",
  loadBalancers: [
    row(),
    row({ kind: "ingress", name: "site", loadBalancer: null, matchedBy: null, unmatched: "notFound", hostnames: ["classic-1.elb.amazonaws.com"], ports: [] }),
    row({ name: "pending", hostnames: [], loadBalancer: null, matchedBy: null, unmatched: "pending" }),
  ],
  unclaimed: [{ arn: "arn:orphan", name: "orphan", dnsName: "o.elb.amazonaws.com", kind: "network", scheme: "internal", state: "active", stack: "gone/svc" }],
  nodes: [node(), node({ name: "fargate-x", instanceId: null, fargate: true, instanceType: null, subnetId: null, instanceState: null })],
  subnets: [subnet(), subnet({ id: "subnet-unused", name: null, nodeCount: 0, podCount: 0, cidrs: ["10.0.9.0/24"] })],
  pods: { vpcCni: true, items: [pod(), pod({ name: "agent", ip: "10.0.0.10", hostNetwork: true, subnetId: "subnet-a", namespace: "kube-system" })], outside: 0, partial: false },
  policies: [policy()],
  namespaces: [
    { name: "blog", policies: 0, system: false },
    { name: "kube-system", policies: 0, system: true },
    { name: "shop", policies: 1, system: false },
  ],
  highlight: ["i-0aaa", LB_ARN],
  gaps: [],
  ...over,
});
