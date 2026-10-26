// README 스크린샷용 데모: 실제 AWS 대신 가짜 데이터로 Tauri 백엔드를 흉내 낸다.
// `npm run dev` 후 http://localhost:1420/scripts/screenshots/demo.html 로 열 수 있다.
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import App from "../../src/App";
import "../../src/styles.css";
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
        return null;
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
