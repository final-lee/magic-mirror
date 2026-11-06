import { parseDescribe, type DescribeNode } from "./describeParse";

type Field = Extract<DescribeNode, { t: "field" }>;
const field = (nodes: DescribeNode[], key: string) => nodes.find((n): n is Field => n.t === "field" && n.key === key)!;

// kubectl describe pod 출력에서 줄인 것(값 열 맞춤, 2칸 들여쓰기, 줄표 없는 Conditions)
const POD = `Name:             web-1
Labels:           app=web
                  tier=front
Annotations:      checksum/config: 978e
                  kubectl.kubernetes.io/restartedAt: 2026-10-27T14:12:48+09:00
Status:           Running
IPs:
  IP:           100.66.198.6
Containers:
  web:
    Image:          repo/web:1
    State:          Running
      Started:      Fri, 06 Nov 2026 11:38:52 +0900
    Args:
      --metrics-addr=:8080
      --log-level=debug
    Environment Variables from:
      web-config  ConfigMap  Optional: false
    Liveness:   http-get http://:http/health delay=0s
Conditions:
  Type                        Status
  PodReadyToStartContainers   True 
  Ready                       False 
Kube-Proxy Version:         
Events:
  Type     Reason   Age                 From     Message
  ----     ------   ----                ----     -------
  Warning  BackOff  41m (x8 over 18h)   kubelet  Back-off restarting failed container web
`;

test("fields keep continuation lines aligned to the value column as one value", () => {
  const nodes = parseDescribe(POD);
  expect(field(nodes, "Name").value).toEqual(["web-1"]);
  expect(field(nodes, "Labels").value).toEqual(["app=web", "tier=front"]);
  expect(field(nodes, "Annotations").value).toEqual(["checksum/config: 978e", "kubectl.kubernetes.io/restartedAt: 2026-10-27T14:12:48+09:00"]);
  expect(field(nodes, "Kube-Proxy Version").value).toEqual([]);
});

test("deeper lines are children; colons not followed by a space are not keys", () => {
  const nodes = parseDescribe(POD);
  expect(field(field(nodes, "IPs").children, "IP").value).toEqual(["100.66.198.6"]);
  const web = field(field(nodes, "Containers").children, "web");
  expect(field(web.children, "State").value).toEqual(["Running"]);
  expect(field(field(web.children, "State").children, "Started").value).toEqual(["Fri, 06 Nov 2026 11:38:52 +0900"]);
  expect(field(web.children, "Args").children).toEqual([{ t: "text", text: "--metrics-addr=:8080" }, { t: "text", text: "--log-level=debug" }]);
  // 두 칸 띄움이 든 줄은 키가 아니다
  expect(field(web.children, "Environment Variables from").children).toEqual([{ t: "text", text: "web-config  ConfigMap  Optional: false" }]);
  expect(field(web.children, "Liveness").value).toEqual(["http-get http://:http/health delay=0s"]);
});

test("tables with a dash row and the pod's Conditions table without one", () => {
  const nodes = parseDescribe(POD);
  expect(field(nodes, "Conditions").children).toEqual([{ t: "table", headers: ["Type", "Status"], rows: [["PodReadyToStartContainers", "True"], ["Ready", "False"]] }]);
  expect(field(nodes, "Events").children).toEqual([
    { t: "table", headers: ["Type", "Reason", "Age", "From", "Message"], rows: [["Warning", "BackOff", "41m (x8 over 18h)", "kubelet", "Back-off restarting failed container web"]] },
  ]);
});

test("uneven indentation (Deployment containers at 3 spaces) and a note line before a table", () => {
  const nodes = parseDescribe(`Pod Template:
  Containers:
   api:
    Image:      repo/api:2
    Mounts:         <none>
  Volumes:          <none>
Allocated resources:
  (Total limits may be over 100 percent, i.e., overcommitted.)
  Resource           Requests      Limits
  --------           --------      ------
  cpu                1249m (64%)   1450m (75%)
Non-terminated Pods:          (25 in total)
  Namespace  Name
  ---------  ----
  web        api-1
`);
  const template = field(nodes, "Pod Template").children;
  const api = field(field(template, "Containers").children, "api");
  expect(field(api.children, "Image").value).toEqual(["repo/api:2"]);
  expect(field(api.children, "Mounts").value).toEqual(["<none>"]);
  expect(field(template, "Volumes").value).toEqual(["<none>"]);
  expect(field(nodes, "Allocated resources").children).toEqual([
    { t: "text", text: "(Total limits may be over 100 percent, i.e., overcommitted.)" },
    { t: "table", headers: ["Resource", "Requests", "Limits"], rows: [["cpu", "1249m (64%)", "1450m (75%)"]] },
  ]);
  const pods = field(nodes, "Non-terminated Pods");
  expect(pods.value).toEqual(["(25 in total)"]);
  expect(pods.children).toEqual([{ t: "table", headers: ["Namespace", "Name"], rows: [["web", "api-1"]] }]);
});

test("text that is not describe output stays as text lines", () => {
  expect(parseDescribe("결과")).toEqual([{ t: "text", text: "결과" }]);
});
