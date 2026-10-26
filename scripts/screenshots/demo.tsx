// README 스크린샷용 데모: 실제 AWS 대신 가짜 데이터로 Tauri 백엔드를 흉내 낸다.
// `npm run dev` 후 http://localhost:1420/scripts/screenshots/demo.html 로 열 수 있다.
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import App from "../../src/App";
import "../../src/styles.css";
import { iamMock } from "./iam";
import services from "./services.json";

const ACCOUNT = "123456789012";
const REGION = "ap-northeast-2";

function res(id: string, name: string, values: Record<string, string>, fields: [string, string][] = []) {
  return {
    id,
    name,
    arn: null,
    values: { name, id, ...values },
    tags: { Team: "platform", Env: "prod" },
    fields: fields.map(([label, value]) => ({ label, value })),
    raw: JSON.stringify({ id, name, ...values }, null, 2),
    consoleUrl: null,
  };
}

const RESOURCES: Record<string, ReturnType<typeof res>[]> = {
  "ec2/instances": [
    res("i-0a1b2c3d4e5f60001", "web-1", { state: "running", type: "t3.medium", privateIp: "10.0.1.21", az: "ap-northeast-2a" }, [
      ["VPC", "vpc-0abc1234"],
      ["Subnet", "subnet-0def5678"],
      ["Launched", "2026-10-02 09:14"],
    ]),
    res("i-0a1b2c3d4e5f60002", "web-2", { state: "running", type: "t3.medium", privateIp: "10.0.2.37", az: "ap-northeast-2c" }),
    res("i-0a1b2c3d4e5f60003", "api-1", { state: "running", type: "m6i.large", privateIp: "10.0.1.88", az: "ap-northeast-2a" }),
    res("i-0a1b2c3d4e5f60004", "api-2", { state: "running", type: "m6i.large", privateIp: "10.0.2.90", az: "ap-northeast-2c" }),
    res("i-0a1b2c3d4e5f60005", "batch-worker", { state: "stopped", type: "c6i.xlarge", privateIp: "10.0.3.12", az: "ap-northeast-2b" }),
    res("i-0a1b2c3d4e5f60006", "bastion", { state: "running", type: "t3.micro", privateIp: "10.0.0.5", az: "ap-northeast-2a" }),
    res("i-0a1b2c3d4e5f60007", "staging-web", { state: "pending", type: "t3.small", privateIp: "10.1.1.14", az: "ap-northeast-2a" }),
  ],
  "vpc/vpcs": [
    res("vpc-0a1b2c3d", "prod", { cidr: "10.0.0.0/16", default: "No", state: "available" }),
    res("vpc-0e5f6a7b", "staging", { cidr: "10.1.0.0/16", default: "No", state: "available" }),
    res("vpc-09f8e7d6", "default", { cidr: "172.31.0.0/16", default: "Yes", state: "available" }),
  ],
  "s3/buckets": [
    res("prod-assets", "prod-assets", { region: REGION, created: "2024-03-11T02:10:00Z" }),
    res("prod-logs", "prod-logs", { region: REGION, created: "2024-03-11T02:12:00Z" }),
    res("static-site", "static-site", { region: "us-east-1", created: "2025-01-20T08:00:00Z" }),
    res("data-lake-raw", "data-lake-raw", { region: REGION, created: "2025-06-02T11:30:00Z" }),
  ],
};

const HOME = "/Users/demo";
const LOCAL: Record<string, { name: string; isDir: boolean; size: number | null }[]> = {
  [HOME]: [
    { name: "Desktop", isDir: true, size: null },
    { name: "Documents", isDir: true, size: null },
    { name: "Downloads", isDir: true, size: null },
    { name: "Projects", isDir: true, size: null },
  ],
  [`${HOME}/Projects`]: [{ name: "web", isDir: true, size: null }],
  [`${HOME}/Projects/web`]: [{ name: "dist", isDir: true, size: null }],
  [`${HOME}/Projects/web/dist`]: [
    { name: "assets", isDir: true, size: null },
    { name: "favicon.svg", isDir: false, size: 1_204 },
    { name: "index.html", isDir: false, size: 4_310 },
    { name: "robots.txt", isDir: false, size: 68 },
    { name: "sitemap.xml", isDir: false, size: 2_950 },
  ],
};

const S3: Record<string, { name: string; isFolder: boolean; size: number | null }[]> = {
  "": [
    { name: "images/", isFolder: true, size: null },
    { name: "web/", isFolder: true, size: null },
    { name: "README.md", isFolder: false, size: 812 },
  ],
  "web/": [
    { name: "assets/", isFolder: true, size: null },
    { name: "favicon.svg", isFolder: false, size: 1_204 },
    { name: "index.html", isFolder: false, size: 4_182 },
    { name: "robots.txt", isFolder: false, size: 68 },
  ],
};

const OLD = `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Magic Store</title>
    <link rel="icon" href="/favicon.svg" />
    <link rel="stylesheet" href="/assets/index-a1b2.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/assets/index-a1b2.js"></script>
  </body>
</html>`;
const NEW = OLD.replace("Magic Store", "Magic Store — 가을 세일")
  .replace("index-a1b2.css", "index-c3d4.css")
  .replace("index-a1b2.js", "index-c3d4.js")
  .replace('    <link rel="icon"', '    <meta name="description" content="가을 한정 특가" />\n    <link rel="icon"');

function diffResult() {
  const a = OLD.split("\n");
  const b = NEW.split("\n");
  const seg = (text: string, emph = false) => [{ text, emph }];
  const line = (no: number, text: string, emph = false) => ({ no, segments: seg(text, emph) });
  // 바뀐 줄은 공통 앞/뒤를 빼고 가운데만 강조한다(실제 앱의 줄 안 강조처럼).
  const pair = (x: string, y: string) => {
    let p = 0;
    while (p < x.length && x[p] === y[p]) p++;
    let q = 0;
    while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
    const segs = (t: string) =>
      [
        { text: t.slice(0, p), emph: false },
        { text: t.slice(p, t.length - q), emph: true },
        { text: t.slice(t.length - q), emph: false },
      ].filter((s) => s.text);
    return [segs(x), segs(y)];
  };
  const rows: unknown[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) rows.push({ kind: "equal", left: line(i + 1, a[i]), right: line(j + 1, b[j]), hiddenRows: [] }), i++, j++;
    else if (b[j]?.includes("description")) rows.push({ kind: "insert", left: null, right: line(j + 1, b[j], true), hiddenRows: [] }), j++;
    else {
      const [l, r] = pair(a[i], b[j]);
      rows.push({ kind: "replace", left: { no: i + 1, segments: l }, right: { no: j + 1, segments: r }, hiddenRows: [] });
      i++, j++;
    }
  }
  const hunks = rows.map((r, k) => ((r as { kind: string }).kind !== "equal" && (rows[k - 1] as { kind: string } | undefined)?.kind === "equal" ? k : -1)).filter((k) => k >= 0);
  return {
    left: { label: "~/Projects/web/dist/index.html", size: 4_310, modified: "2026-10-26T05:10:00Z", md5: null },
    right: { label: "s3://prod-assets/web/index.html", size: 4_182, modified: "2026-10-21T01:00:00Z", md5: null },
    mode: "text",
    rows,
    hunks,
    stats: { added: 1, removed: 0, changed: 3 },
    metaVerdict: null,
    reason: null,
    eolOnly: false,
  };
}

function topology() {
  const AZ = ["ap-northeast-2a", "ap-northeast-2b", "ap-northeast-2c"];
  const sn = (id: string, name: string, az: string, tier: string, cidr: string, rt: string, ips: number) => ({
    id, name, az, cidr, tier, routeTableId: rt, availableIps: ips, tags: { Name: name },
  });
  const subnets = [
    sn("subnet-pub-a", "prod-public-a", AZ[0], "public", "10.0.0.0/24", "rtb-public", 247),
    sn("subnet-pub-b", "prod-public-b", AZ[1], "public", "10.0.1.0/24", "rtb-public", 249),
    sn("subnet-pub-c", "prod-public-c", AZ[2], "public", "10.0.2.0/24", "rtb-public", 248),
    sn("subnet-app-a", "prod-app-a", AZ[0], "private", "10.0.10.0/23", "rtb-private-a", 498),
    sn("subnet-app-b", "prod-app-b", AZ[1], "private", "10.0.12.0/23", "rtb-private-b", 501),
    sn("subnet-app-c", "prod-app-c", AZ[2], "private", "10.0.14.0/23", "rtb-private-c", 503),
    sn("subnet-db-a", "prod-db-a", AZ[0], "isolated", "10.0.20.0/24", "rtb-db", 250),
    sn("subnet-db-c", "prod-db-c", AZ[2], "isolated", "10.0.22.0/24", "rtb-db", 251),
  ];
  const local = { destination: "10.0.0.0/16", target: "local", targetKind: "local", state: "active" };
  const rt = (id: string, name: string, ids: string[], extra: object[]) => ({ id, name, main: false, subnetIds: ids, routes: [local, ...extra] });
  const nat = (z: string) => ({ destination: "0.0.0.0/0", target: `nat-0${z}11aa22bb`, targetKind: "nat", state: "active" });
  const s3pl = { destination: "pl-78a54011 (S3)", target: "vpce-0s3gw", targetKind: "vpce", state: "active" };
  const node = (id: string, name: string, kind: string, subnetIds: string[], state: string, fields: [string, string][]) => ({
    id, name, kind, subnetIds, state, fields: fields.map(([label, value]) => ({ label, value })), consoleUrl: null,
  });
  return {
    vpc: { id: "vpc-0a1b2c3d", name: "prod", cidrs: ["10.0.0.0/16"], isDefault: false, state: "available" },
    azs: AZ,
    subnets,
    routeTables: [
      rt("rtb-public", "prod-public", ["subnet-pub-a", "subnet-pub-b", "subnet-pub-c"], [
        { destination: "0.0.0.0/0", target: "igw-0f1e2d3c", targetKind: "igw", state: "active" },
      ]),
      rt("rtb-private-a", "prod-private-a", ["subnet-app-a"], [nat("a"), s3pl, { destination: "10.1.0.0/16", target: "pcx-0aa11bb2", targetKind: "pcx", state: "active" }]),
      rt("rtb-private-b", "prod-private-b", ["subnet-app-b"], [nat("a"), s3pl]),
      rt("rtb-private-c", "prod-private-c", ["subnet-app-c"], [nat("c"), s3pl]),
      rt("rtb-db", "prod-db", ["subnet-db-a", "subnet-db-c"], []),
    ],
    gateways: [
      { id: "igw-0f1e2d3c", name: "prod-igw", kind: "igw", label: "Internet Gateway", state: "available" },
      { id: "vpce-0s3gw", name: "prod-s3", kind: "vpce-gateway", label: "S3", state: "available" },
      { id: "vpce-0ddbgw", name: "prod-dynamodb", kind: "vpce-gateway", label: "DynamoDB", state: "available" },
      { id: "tgw-attach-0c9d8e7f", name: "corp-tgw", kind: "tgw", label: "tgw-0123abcd", state: "available" },
    ],
    peerings: [{ id: "pcx-0aa11bb2", peerVpcId: "vpc-0e5f6a7b", peerCidr: "10.1.0.0/16", peerOwnerId: ACCOUNT, peerRegion: REGION, status: "active" }],
    resources: [
      node("arn:alb/web", "web-alb", "elb", ["subnet-pub-a", "subnet-pub-b", "subnet-pub-c"], "active", [["Type", "application"], ["Scheme", "internet-facing"]]),
      node("nat-0a11aa22bb", "nat-a", "nat", ["subnet-pub-a"], "available", [["Public IP", "3.38.12.40"]]),
      node("nat-0c11aa22bb", "nat-c", "nat", ["subnet-pub-c"], "available", [["Public IP", "3.38.77.15"]]),
      node("i-bastion", "bastion", "ec2", ["subnet-pub-b"], "running", [["Type", "t3.micro"]]),
      node("i-web1", "web-1", "ec2", ["subnet-app-a"], "running", [["Type", "t3.medium"], ["Private IP", "10.0.10.21"]]),
      node("i-api1", "api-1", "ec2", ["subnet-app-a"], "running", [["Type", "m6i.large"]]),
      node("i-web2", "web-2", "ec2", ["subnet-app-b"], "running", [["Type", "t3.medium"]]),
      node("i-api2", "api-2", "ec2", ["subnet-app-c"], "running", [["Type", "m6i.large"]]),
      node("i-batch", "batch-worker", "ec2", ["subnet-app-c"], "stopped", [["Type", "c6i.xlarge"]]),
      node("fn-orders", "order-events", "lambda", ["subnet-app-a", "subnet-app-b", "subnet-app-c"], "active", [["Runtime", "nodejs20.x"]]),
      node("vpce-0ecr", "ecr-api", "vpce", ["subnet-app-a", "subnet-app-c"], "available", [["Service", "ecr.api"]]),
      node("db-orders", "orders-db", "rds", ["subnet-db-a", "subnet-db-c"], "available", [["Engine", "aurora-postgresql 16.4"], ["Multi-AZ", "Yes"]]),
    ],
    warnings: [],
  };
}

mockWindows("main");
mockIPC(
  (cmd, args) => {
    const a = (args ?? {}) as Record<string, any>;
    switch (cmd) {
      case "list_profiles":
        return [{ name: "prod", region: REGION }, { name: "staging", region: REGION }];
      case "get_account":
        return ACCOUNT;
      case "list_services":
        return services;
      case "get_settings":
        return {
          enabledServices: ["ec2", "s3", "lambda", "rds", "ecs", "eks", "vpc", "iam", "dynamodb", "logs", "sqs", "secretsmanager"],
          favorites: [{ service: "ec2", type: "instances" }, { service: "s3", type: "buckets" }],
          lastProfile: "prod",
          lastRegion: REGION,
          explorerLocalPath: `${HOME}/Projects/web/dist`,
          diffTool: "filemerge",
        };
      case "save_settings":
        return null;
      case "list_resources":
        return { items: RESOURCES[`${a.service}/${a.typeId}`] ?? [], truncated: false };
      case "list_s3_objects":
        return {
          entries: (S3[a.prefix] ?? []).map((e) => ({
            name: e.name.replace(/\/$/, ""),
            key: a.prefix + e.name,
            isFolder: e.isFolder,
            size: e.size,
            lastModified: e.isFolder ? null : "2026-10-21T01:00:00Z",
            storageClass: e.isFolder ? null : "STANDARD",
          })),
          nextToken: null,
        };
      case "local_home":
        return HOME;
      case "local_list":
        return (LOCAL[a.path] ?? []).map((e) => ({
          name: e.name,
          path: `${a.path}/${e.name}`,
          isDir: e.isDir,
          size: e.size,
          modified: e.isDir ? null : "2026-10-26T05:10:00Z",
        }));
      case "vpc_topology":
        return topology();
      case "diff_files":
        return diffResult();
      case "plan_upload":
        return (a.localPaths as string[]).map((p, k) => ({
          id: `t${k}`,
          direction: "upload",
          localPath: p,
          bucket: a.bucket,
          region: a.region,
          key: a.prefix + p.split("/").pop(),
        }));
      case "find_conflicts":
        return [];
      case "start_transfers":
        for (const r of a.requests as { id: string }[])
          setTimeout(() => void emit("transfer-progress", { id: r.id, status: "running", transferred: 2_730_000, total: 4_400_000, error: null }), 50);
        return null;
      case "plugin:updater|check":
        return null;
      case "plugin:app|version":
        return "0.1.0";
      default:
        return cmd.startsWith("iam_") ? iamMock(cmd, a) ?? null : null;
    }
  },
  { shouldMockEvents: true },
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
