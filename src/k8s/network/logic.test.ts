import { loadBalancer, pod, target } from "./fixtures";
import { directionView, filterPods, groupGaps, healthCounts, listenersText, peerText, portText, refOfLink, subnetLabel } from "./logic";
import type { NetworkGap, PolicyRule } from "./types";

test("health counts every target of every group: healthy, unhealthy and everything else apart", () => {
  const lb = loadBalancer({
    targetGroups: [
      { ...loadBalancer().targetGroups[0], targets: [target(), target({ id: "a", state: "unhealthy" }), target({ id: "b", state: "draining" }), target({ id: "c", state: "initial" })] },
      { ...loadBalancer().targetGroups[0], targets: [target({ state: "unavailable" })] },
    ],
  });
  expect(healthCounts(lb)).toEqual({ healthy: 1, unhealthy: 1, other: 3 });
  expect(healthCounts(null)).toEqual({ healthy: 0, unhealthy: 0, other: 0 });
});

test("listeners are listed as protocol:port in the order given", () => {
  expect(listenersText(loadBalancer())).toBe("HTTPS:443, HTTP:80");
  expect(listenersText(null)).toBe("");
});

test("ports: numbers, ranges, names and the absence of a port", () => {
  expect(portText({ protocol: "TCP", port: "8080", endPort: null })).toBe("TCP/8080");
  expect(portText({ protocol: "UDP", port: "9000", endPort: 9100 })).toBe("UDP/9000-9100");
  expect(portText({ protocol: "TCP", port: "metrics", endPort: null })).toBe("TCP/metrics");
  expect(portText({ protocol: "TCP", port: null, endPort: null })).toBe("TCP/모든 포트");
});

test("a peer with both selectors is an AND, an ip block shows its exceptions", () => {
  expect(peerText({ podSelector: "app=web", namespaceSelector: null, ipBlock: null })).toBe("Pod app=web");
  expect(peerText({ podSelector: "app=web", namespaceSelector: "team=edge", ipBlock: null })).toBe("네임스페이스 team=edge + Pod app=web");
  // 빈 셀렉터는 모두
  expect(peerText({ podSelector: "", namespaceSelector: "", ipBlock: null })).toBe("모든 네임스페이스 + 모든 Pod");
  expect(peerText({ podSelector: null, namespaceSelector: null, ipBlock: { cidr: "10.0.0.0/8", except: ["10.1.0.0/16"] } })).toBe("IP 10.0.0.0/8 (제외 10.1.0.0/16)");
  expect(peerText({ podSelector: null, namespaceSelector: null, ipBlock: null })).toBe("모든 곳");
});

test("a direction the policy does not cover is open, covered without rules is deny-all, an empty rule is allow-all", () => {
  const rule = (over: Partial<PolicyRule> = {}): PolicyRule => ({ peers: [], ports: [], ...over });
  expect(directionView("Egress", ["Ingress"], [])).toEqual({ mode: "open" });
  expect(directionView("Ingress", ["Ingress"], [])).toEqual({ mode: "deny" });
  expect(directionView("Ingress", ["Ingress"], [rule()])).toEqual({ mode: "rules", rules: [{ allowAll: true, peers: [], ports: "모든 포트" }] });
  // 포트만 있고 상대가 없으면 모든 곳에서 그 포트만 허용한다: 모두 허용이 아니다
  const only = directionView("Ingress", ["Ingress"], [rule({ ports: [{ protocol: "TCP", port: "443", endPort: null }] })]);
  expect(only).toEqual({ mode: "rules", rules: [{ allowAll: false, peers: [], ports: "TCP/443" }] });
});

test("gaps with the same reason are shown once, listing every part they hit", () => {
  const same = { kind: "other", message: "자격 증명을 읽지 못했어요" } as const;
  const gaps: NetworkGap[] = [
    { section: "cluster", subject: null, error: same },
    { section: "instances", subject: null, error: same },
    { section: "targetHealth", subject: "web / api-tg", error: { kind: "accessDenied", action: "elasticloadbalancing:DescribeTargetHealth" } },
    { section: "instances", subject: null, error: same },
  ];
  const groups = groupGaps(gaps);
  expect(groups).toHaveLength(2);
  expect(groups[0].labels).toEqual(["클러스터 VPC", "EC2 인스턴스"]);
  expect(groups[0].sections).toEqual(["cluster", "instances"]);
  // 로드 밸런서 하나에만 해당하는 실패는 그 이름이 붙는다
  expect(groups[1].labels).toEqual(["대상 상태 (web / api-tg)"]);
});

test("pods are found by name, namespace, ip, node or subnet ignoring case", () => {
  const items = [pod(), pod({ name: "db-0", ip: "10.0.5.5", node: "ip-b", subnetId: "subnet-pod", namespace: "data" })];
  expect(filterPods(items, "")).toHaveLength(2);
  expect(filterPods(items, "  DB").map((p) => p.name)).toEqual(["db-0"]);
  expect(filterPods(items, "10.0.0.").map((p) => p.name)).toEqual(["web-1"]);
  expect(filterPods(items, "subnet-pod").map((p) => p.name)).toEqual(["db-0"]);
  expect(filterPods(items, "nothing")).toEqual([]);
});

test("target links open nodes and pods, anything else has no destination", () => {
  expect(refOfLink({ kind: "Node", namespace: null, name: "n1" })).toMatchObject({ namespace: null, name: "n1", kind: { kind: "Node" } });
  expect(refOfLink({ kind: "Pod", namespace: "shop", name: "p1" })).toMatchObject({ namespace: "shop", name: "p1", kind: { kind: "Pod" } });
  expect(refOfLink({ kind: "Service", namespace: "shop", name: "s" })).toBeNull();
});

test("a subnet shows its Name tag before its id", () => {
  expect(subnetLabel({ id: "subnet-a", name: "private-a" })).toBe("private-a (subnet-a)");
  expect(subnetLabel({ id: "subnet-a", name: null })).toBe("subnet-a");
});
