// 데모용 Argo Workflows 명령 흉내. 시각은 지금 기준으로 만든다(목록의 "n분 전"이 늘 그럴듯하게).
import type {
  CronRow,
  EventBindingRow,
  EventSourceRow,
  SensorRow,
  TemplateRow,
  WfArtifact,
  WfContainer,
  WfDetail,
  WfListQuery,
  WfLogMessage,
  WfNode,
  WfPage,
  WfRow,
} from "../../src/argowf/types";

const URL = "https://argo-workflows.demo.ts.net";
const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();

function row(namespace: string, name: string, phase: WfRow["phase"], startMin: number, endMin: number | null, extra: Partial<WfRow> = {}): WfRow {
  return {
    namespace,
    name,
    uid: `uid-${namespace}-${name}`,
    resourceVersion: "1",
    phase,
    message: null,
    progress: null,
    startedAt: at(startMin),
    finishedAt: endMin === null ? null : at(endMin),
    cron: null,
    template: null,
    clusterTemplate: false,
    creator: null,
    suspended: false,
    activeDeadlineSeconds: null,
    archived: false,
    labels: {},
    annotations: {},
    createdAt: at(startMin),
    estimatedDuration: null,
    ...extra,
  };
}

const cronRuns = (namespace: string, cron: string, results: WfRow["phase"][], everyMin: number, durMin: number): WfRow[] =>
  results.map((phase, i) => {
    const start = (results.length - 1 - i) * everyMin + 3;
    return row(namespace, `${cron}-${1793615400 - i * 86_400}`, phase, start, phase === "Running" ? null : start - durMin, {
      cron,
      progress: phase === "Succeeded" ? "1/1" : "0/1",
      message: phase === "Failed" ? "main: Error (exit code 2)" : null,
      labels: { "workflows.argoproj.io/cron-workflow": cron, "workflows.argoproj.io/phase": phase },
      estimatedDuration: durMin * 60,
    });
  });

const etlLabels = (phase: string) => ({ "workflows.argoproj.io/workflow-template": "etl-pipeline", team: "data", "workflows.argoproj.io/phase": phase });

const WORKFLOWS: WfRow[] = [
  row("data", "etl-orders-x7k2p", "Running", 12, null, {
    template: "etl-pipeline",
    progress: "4/7",
    creator: "dev@example.com",
    labels: etlLabels("Running"),
    estimatedDuration: 22 * 60,
  }),
  row("data", "etl-orders-q9m3c", "Failed", 95, 71, {
    template: "etl-pipeline",
    progress: "5/7",
    message: "child 'etl-orders-q9m3c-2730112' failed",
    labels: etlLabels("Failed"),
  }),
  row("data", "etl-orders-b2n8v", "Succeeded", 1440 + 30, 1440 + 8, { template: "etl-pipeline", progress: "7/7", labels: etlLabels("Succeeded") }),
  row("ml", "train-ranker-ww4x1", "Pending", 14, null, {
    template: "gpu-train",
    clusterTemplate: true,
    progress: "0/3",
    message: "Unschedulable: 0/12 nodes are available: insufficient nvidia.com/gpu",
    labels: { "workflows.argoproj.io/cluster-workflow-template": "gpu-train", "workflows.argoproj.io/phase": "Pending" },
  }),
  row("ops", "release-approve-5kq2", "Running", 40, null, {
    progress: "1/3",
    suspended: true,
    creator: "ops@example.com",
    labels: { "events.argoproj.io/sensor": "release-sensor", "events.argoproj.io/trigger": "release-workflow", "workflows.argoproj.io/phase": "Running" },
  }),
  ...cronRuns("backend", "notify-daily-digest", ["Succeeded", "Succeeded", "Failed", "Failed", "Failed"], 1440, 2),
  ...cronRuns("backend", "cleanup-sessions", ["Succeeded", "Succeeded", "Succeeded", "Succeeded", "Running"], 60, 1),
  row("ops", "db-backup-manual-7hd2s", "Succeeded", 300, 285, { creator: "ops@example.com", progress: "2/2" }),
];

const container = (name: string, image: string, command: string[], extra: Partial<WfContainer> = {}): WfContainer => ({
  name,
  role: "main",
  image,
  command,
  args: [],
  workingDir: null,
  env: ["APP_ENV"],
  requests: { cpu: "500m", memory: "1Gi" },
  limits: { memory: "2Gi" },
  volumeMounts: [],
  ...extra,
});

const artifact = (name: string, direction: WfArtifact["direction"], key: string | null): WfArtifact => ({
  name,
  direction,
  key,
  repository: key ? "s3" : null,
});

function node(
  id: string,
  displayName: string,
  type: string,
  phase: string,
  startMin: number,
  endMin: number | null,
  children: string[] = [],
  extra: Partial<WfNode> = {},
): WfNode {
  const pod = type === "Pod";
  return {
    id,
    name: id,
    displayName,
    type,
    phase,
    message: null,
    templateName: displayName.replace(/\(\d+\)$/, ""),
    templateScope: "local/",
    startedAt: at(startMin),
    finishedAt: endMin === null ? null : at(endMin),
    children,
    boundaryId: null,
    podName: pod ? `${id}-pod` : null,
    exitCode: null,
    inputs: [],
    outputs: [],
    artifacts: pod ? [artifact("main-logs", "output", `logs/${id}/main.log`)] : [],
    hostNodeName: pod ? "ip-10-0-12-34.ap-northeast-2.compute.internal" : null,
    memoization: null,
    containers: pod ? [container("main", "example.registry/etl:1.4.2", ["python", "-m", "etl"], { args: [displayName] })] : [],
    estimatedDuration: null,
    resourcesDuration: pod ? { cpu: 40, memory: 80 } : {},
    ...extra,
  };
}

const detailBase = (wf: WfRow, yaml: string): Omit<WfDetail, "nodes"> => ({
  row: wf,
  parameters: [],
  entrypoint: "main",
  serviceAccount: "default",
  activeDeadlineSeconds: null,
  podGC: "OnPodSuccess",
  ttl: null,
  conditions: [],
  resourcesDuration: { cpu: 12, memory: 30 },
  yaml,
  outputs: [],
  createdFrom: [],
  synchronization: [],
});

const yamlOf = (wf: WfRow, extra = "") =>
  `apiVersion: argoproj.io/v1alpha1\nkind: Workflow\nmetadata:\n  name: ${wf.name}\n  namespace: ${wf.namespace}\nspec:\n  entrypoint: main\n${extra}`;

function etlDetail(wf: WfRow): WfDetail {
  const n = wf.name;
  const running = wf.phase === "Running";
  const failed = wf.phase === "Failed";
  const base = running ? 12 : failed ? 95 : 1470;
  const end = (m: number) => (running ? null : base - m);
  const nodes: WfNode[] = [
    node(n, n, "DAG", wf.phase, base, end(24), [`${n}-1`, `${n}-2`, `${n}-3`]),
    node(`${n}-1`, "extract-orders", "Pod", "Succeeded", base, base - 3, [`${n}-4`], {
      boundaryId: n,
      outputs: [{ name: "rows", value: "182340" }],
      artifacts: [artifact("orders.json", "output", `etl/${n}/orders.json`), artifact("main-logs", "output", `logs/${n}-1/main.log`)],
      memoization: { hit: false, key: "orders-2026-11-02", cacheName: "etl-cache" },
    }),
    node(`${n}-2`, "extract-customers", "Pod", "Succeeded", base, base - 2, [`${n}-4`], {
      boundaryId: n,
      outputs: [{ name: "rows", value: "20411" }],
      memoization: { hit: true, key: "customers-2026-11-02", cacheName: "etl-cache" },
    }),
    node(`${n}-3`, "extract-refunds", "Retry", "Succeeded", base, base - 5, [`${n}-3a`, `${n}-3b`], { boundaryId: n }),
    node(`${n}-3a`, "extract-refunds(0)", "Pod", "Failed", base, base - 2, [], { boundaryId: n, message: "main: Error (exit code 1)", exitCode: "1" }),
    node(`${n}-3b`, "extract-refunds(1)", "Pod", "Succeeded", base - 2, base - 5, [`${n}-4`], { boundaryId: n }),
    node(`${n}-4`, "join", "Pod", running ? "Running" : "Succeeded", base - 5, running ? null : base - 11, running ? [] : [`${n}-5`, `${n}-6`], {
      boundaryId: n,
      inputs: [{ name: "date", value: "2026-11-02" }],
      estimatedDuration: running ? 8 * 60 : null,
    }),
    ...(running
      ? []
      : [
          node(`${n}-5`, "load-warehouse", "Pod", failed ? "Failed" : "Succeeded", base - 11, base - 24, [], {
            boundaryId: n,
            ...(failed ? { message: "main: Error (exit code 2)", exitCode: "2" } : {}),
          }),
          node(`${n}-6`, "notify", "Pod", failed ? "Omitted" : "Succeeded", base - 11, base - 12, [], { boundaryId: n }),
        ]),
  ];
  return {
    ...detailBase(wf, yamlOf(wf, "  workflowTemplateRef:\n    name: etl-pipeline\n")),
    nodes,
    parameters: [
      { name: "date", value: "2026-11-02" },
      { name: "full-refresh", value: "false" },
    ],
    serviceAccount: "etl-runner",
    activeDeadlineSeconds: 7200,
    ttl: "secondsAfterSuccess=2592000",
    conditions: [{ type: "PodRunning", status: running ? "True" : "False", message: null }],
    resourcesDuration: { cpu: 812, memory: 1630 },
    outputs: failed ? [] : [{ name: "loaded-rows", value: "202751" }],
    createdFrom: [{ kind: "template", name: "etl-pipeline" }],
    synchronization: running ? [{ kind: "mutex", key: "data/etl-warehouse", holding: [n], waiting: ["etl-orders-next"] }] : [],
  };
}

function approvalDetail(wf: WfRow): WfDetail {
  const n = wf.name;
  return {
    ...detailBase(wf, yamlOf(wf)),
    nodes: [
      node(n, n, "Steps", "Running", 40, null, [`${n}-s1`]),
      node(`${n}-s1`, "[0]", "StepGroup", "Succeeded", 40, 35, [`${n}-build`], { boundaryId: n }),
      node(`${n}-build`, "build", "Pod", "Succeeded", 40, 35, [`${n}-s2`], { boundaryId: n }),
      node(`${n}-s2`, "[1]", "StepGroup", "Running", 35, null, [`${n}-approve`], { boundaryId: n }),
      node(`${n}-approve`, "approve", "Suspend", "Running", 35, null, [], {
        boundaryId: n,
        outputs: [
          { name: "approver", value: null },
          { name: "target", value: "stg" },
        ],
      }),
    ],
    createdFrom: [{ kind: "event", name: "release-sensor" }],
  };
}

function simpleDetail(wf: WfRow): WfDetail {
  const start = (Date.now() - Date.parse(wf.startedAt ?? "")) / 60_000;
  const end = wf.finishedAt ? (Date.now() - Date.parse(wf.finishedAt)) / 60_000 : null;
  return {
    ...detailBase(wf, yamlOf(wf)),
    nodes: [
      node(wf.name, wf.name, "Retry", wf.phase, start, end, [`${wf.name}-0`]),
      node(`${wf.name}-0`, `${wf.name}(0)`, "Pod", wf.phase, start, end, [], wf.phase === "Failed" ? { message: wf.message, exitCode: "2" } : {}),
    ],
    parameters: wf.cron ? [{ name: "scheduledFor", value: wf.startedAt }] : [],
    entrypoint: "job",
    serviceAccount: wf.cron ? "notifier" : "default",
    createdFrom: wf.cron ? [{ kind: "cron", name: wf.cron }] : [],
  };
}

const next = (minAhead: number) => new Date(now + minAhead * 60_000).toISOString();

function cron(namespace: string, name: string, schedule: string, extra: Partial<CronRow> = {}): CronRow {
  return {
    namespace,
    name,
    schedules: [schedule],
    timezone: "Asia/Seoul",
    suspended: false,
    concurrencyPolicy: "Forbid",
    startingDeadlineSeconds: 300,
    lastScheduledTime: at(3),
    active: [],
    succeeded: 12,
    failed: 0,
    nextRuns: [next(57), next(117), next(177), next(237), next(297)],
    missed: false,
    serviceAccount: "notifier",
    hasDeadline: true,
    template: null,
    clusterTemplate: false,
    labels: {},
    ...extra,
  };
}

const CRONS: CronRow[] = [
  cron("backend", "notify-daily-digest", "30 19 * * *", { failed: 3, succeeded: 27, nextRuns: [next(300), next(1740), next(3180), next(4620), next(6060)] }),
  cron("backend", "cleanup-sessions", "0 * * * *", { active: ["cleanup-sessions-1793615400"] }),
  cron("ops", "weekly-report", "0 9 * * 1", { suspended: true, serviceAccount: null, hasDeadline: false, missed: false, succeeded: 4 }),
  cron("data", "nightly-etl", "0 2 * * *", {
    missed: true,
    lastScheduledTime: at(2 * 1440 + 30),
    concurrencyPolicy: "Replace",
    template: "etl-pipeline",
    serviceAccount: null,
  }),
];

const TEMPLATES: TemplateRow[] = [
  {
    kind: "WorkflowTemplate",
    namespace: "data",
    name: "etl-pipeline",
    description: "주문·고객·환불 데이터를 모아 웨어하우스에 적재해요",
    parameters: [
      { name: "date", value: "2026-11-02", enum: [], description: "기준 날짜" },
      { name: "full-refresh", value: "false", enum: ["true", "false"], description: "전체 다시 적재" },
    ],
    entrypoint: "main",
    templates: ["main", "extract", "join", "load-warehouse", "notify"],
    serviceAccount: "etl-runner",
    hasDeadline: true,
  },
  {
    kind: "ClusterWorkflowTemplate",
    namespace: null,
    name: "gpu-train",
    description: null,
    parameters: [{ name: "model", value: "ranker", enum: [], description: null }],
    entrypoint: "train",
    templates: ["train", "evaluate", "publish"],
    serviceAccount: null,
    hasDeadline: false,
  },
];

const EVENT_SOURCES: EventSourceRow[] = [
  {
    namespace: "ops",
    name: "github",
    types: ["webhook"],
    eventNames: ["release"],
    status: "Deployed",
    message: null,
    yaml: 'apiVersion: argoproj.io/v1alpha1\nkind: EventSource\nmetadata:\n  name: github\nspec:\n  webhook:\n    release:\n      port: "12000"\n      endpoint: /release\n',
  },
  {
    namespace: "data",
    name: "orders-queue",
    types: ["sqs"],
    eventNames: ["new-batch"],
    status: "Deployed",
    message: null,
    yaml: "apiVersion: argoproj.io/v1alpha1\nkind: EventSource\nmetadata:\n  name: orders-queue\n",
  },
];

const SENSORS: SensorRow[] = [
  {
    namespace: "ops",
    name: "release-sensor",
    dependencies: [{ name: "release", eventSourceName: "github", eventName: "release" }],
    triggers: [{ name: "release-workflow", type: "argoWorkflow", target: "Workflow/release-approve-" }],
    status: "Deployed",
    message: null,
    yaml: "apiVersion: argoproj.io/v1alpha1\nkind: Sensor\nmetadata:\n  name: release-sensor\n",
  },
  {
    namespace: "data",
    name: "orders-sensor",
    dependencies: [{ name: "batch", eventSourceName: "orders-queue", eventName: "new-batch" }],
    triggers: [{ name: "run-etl", type: "argoWorkflow", target: "WorkflowTemplate/etl-pipeline" }],
    status: "Deployed",
    message: null,
    yaml: "apiVersion: argoproj.io/v1alpha1\nkind: Sensor\nmetadata:\n  name: orders-sensor\n",
  },
];

const BINDINGS: EventBindingRow[] = [
  {
    namespace: "data",
    name: "on-orders-batch",
    selector: 'payload.kind == "orders" && discriminator == "batch"',
    template: { name: "etl-pipeline", clusterScope: false },
    parameters: ["date=payload.date"],
  },
];

const LOG = [
  '{"level":"info","msg":"connecting to warehouse","host":"wh.internal"}',
  '{"level":"info","msg":"loading partition","date":"2026-11-02","rows":182340}',
  '{"level":"warn","msg":"slow batch","ms":8123}',
  '{"level":"error","msg":"COPY failed: permission denied for schema analytics"}',
  "Traceback (most recent call last):",
  '  File "/app/load.py", line 88, in <module>',
  "psycopg.errors.InsufficientPrivilege: permission denied for schema analytics",
];

type Args = Record<string, any>;
let created = 0;
let streams = 0;

/** 목록 조건을 데모 자료에 적용한다(서버가 거르는 것과 같은 결과) */
function page(rows: WfRow[], q: WfListQuery | undefined): WfPage {
  const sel = (q?.labelSelector ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const matched = rows.filter((w) => {
    if (q?.namespace && w.namespace !== q.namespace) return false;
    if (q?.phases?.length && !q.phases.includes(w.phase)) return false;
    if (q?.name) {
      const v = q.name.value;
      if (q.name.mode === "exact" ? w.name !== v : q.name.mode === "prefix" ? !w.name.startsWith(v) : !w.name.includes(v)) return false;
    }
    if (q?.createdAfter && (w.createdAt ?? "") < q.createdAfter) return false;
    if (q?.finishedBefore && (!w.finishedAt || w.finishedAt > q.finishedBefore)) return false;
    return sel.every((s) => {
      const [k, v] = s.split("=");
      return v === undefined ? k in w.labels : w.labels[k] === v;
    });
  });
  const startAt = Number(q?.continueToken ?? 0);
  const limit = q?.limit ?? 200;
  const slice = matched.slice(startAt, startAt + limit);
  return { rows: slice, continueToken: startAt + limit < matched.length ? String(startAt + limit) : null, resourceVersion: "100" };
}

function detailOf(namespace: string, name: string): WfDetail {
  const wf = WORKFLOWS.find((w) => w.namespace === namespace && w.name === name) ?? row(namespace, name, "Running", 0, null);
  if (wf.template === "etl-pipeline") return etlDetail(wf);
  if (wf.name.startsWith("release-approve")) return approvalDetail(wf);
  return simpleDetail(wf);
}

const sendLines = (a: Args, lines: { pod: string; text: string }[]) => {
  const ch = a.onEvent as { onmessage: (m: WfLogMessage) => void };
  setTimeout(() => {
    ch.onmessage({ type: "lines", lines });
    ch.onmessage({ type: "end" });
  }, 120);
  return ++streams;
};

export function argowfMock(cmd: string, a: Args): unknown {
  switch (cmd) {
    case "argowf_contexts":
      return [
        {
          name: "demo-eks",
          cluster: "arn:aws:eks:ap-northeast-2:123456789012:cluster/demo-eks",
          server: "https://ABC.yl4.ap-northeast-2.eks.amazonaws.com",
          ssoProfile: null,
        },
        { name: "kind-local", cluster: "kind-local", server: "https://127.0.0.1:6443", ssoProfile: null },
      ];
    case "argowf_session":
      return {
        url: a.server.url,
        version: "v4.1.6",
        identity: a.server.context ?? "토큰",
        auth: a.server.context ? "context" : "token",
        kube: !!a.server.context,
        ssoProfile: null,
      };
    case "argowf_set_token":
      return { url: a.url, version: "v4.1.6", identity: "토큰", auth: "token", kube: false, ssoProfile: null };
    case "argowf_forget_token":
      return null;
    case "argowf_info":
      return {
        managedNamespace: null,
        links: [
          { name: "Datadog 로그", scope: "pod-logs", url: "https://app.datadoghq.com/logs?query=pod_name%3A${metadata.name}" },
          { name: "Grafana", scope: "workflow", url: "https://grafana.example.com/d/argo?var-workflow=${metadata.name}&var-ns=${metadata.namespace}" },
        ],
        columns: [{ name: "팀", type: "label", key: "team" }],
      };
    case "argowf_userinfo":
      return {
        issuer: null,
        subject: "arn:aws:sts::123456789012:assumed-role/Admin/dev",
        groups: ["system:authenticated"],
        email: null,
        emailVerified: null,
        serviceAccountName: null,
        serviceAccountNamespace: null,
      };
    case "argowf_copy_token":
      return "Bearer k8s-aws-v1.demo-token";
    case "argowf_workflows":
      return page(WORKFLOWS, a.query);
    case "argowf_archived":
      return page([], a.query);
    case "argowf_watch":
    case "argowf_watch_workflow":
      return ++streams;
    case "argowf_watch_stop":
      return null;
    case "argowf_workflow":
      return detailOf(a.namespace, a.name);
    case "argowf_role_arn":
      return a.serviceAccount === "default" ? null : `arn:aws:iam::123456789012:role/${a.serviceAccount}`;
    case "argowf_events":
      return [
        {
          at: at(90),
          type: "Warning",
          reason: "WorkflowNodeFailed",
          message: "Failed node load-warehouse: main: Error (exit code 2)",
          object: `Workflow/${a.name}`,
          count: 1,
        },
        { at: at(95), type: "Normal", reason: "WorkflowRunning", message: "Workflow Running", object: `Workflow/${a.name}`, count: 1 },
      ];
    case "argowf_logs":
      return sendLines(
        a,
        LOG.map((text) => ({
          pod: a.podName ?? `${a.name}-load-warehouse`,
          text: a.options?.timestamps ? `2026-11-03T05:50:0${LOG.indexOf(text)}Z ${text}` : text,
        })),
      );
    case "argowf_logs_stop":
      return null;
    case "argowf_save_text":
    case "argowf_save_artifact":
      return `/Users/demo/Downloads/${a.suggestedName ?? a.artifact?.name ?? "artifact"}`;
    case "argowf_artifact_preview":
      return a.artifact?.name === "main-logs"
        ? { contentType: "text/plain", size: 512, text: LOG.join("\n"), imageBase64: null }
        : { contentType: "application/json", size: 64, text: '{"rows":182340,"date":"2026-11-02","source":"orders"}', imageBase64: null };
    case "argowf_crons":
      return CRONS;
    case "argowf_cron": {
      const c = CRONS.find((x) => x.namespace === a.namespace && x.name === a.name) ?? CRONS[0];
      return {
        row: c,
        entrypoint: "job",
        template: c.template,
        parameters: [{ name: "scheduledFor", value: "{{workflow.scheduledTime}}" }],
        yaml: `apiVersion: argoproj.io/v1alpha1\nkind: CronWorkflow\nmetadata:\n  name: ${c.name}\n`,
      };
    }
    case "argowf_templates":
      return TEMPLATES;
    case "argowf_template": {
      const t = TEMPLATES.find((x) => x.kind === a.kind && x.name === a.name) ?? TEMPLATES[0];
      return { row: t, yaml: `apiVersion: argoproj.io/v1alpha1\nkind: ${t.kind}\nmetadata:\n  name: ${t.name}\n` };
    }
    case "argowf_workflow_action":
      return a.action.kind === "resubmit" ? `${a.name.replace(/-[a-z0-9]+$/, "")}-re${++created}` : a.action.kind === "retry" ? a.name : null;
    case "argowf_batch_action":
      return (a.targets as { namespace: string; name: string }[]).map((t) => ({
        ...t,
        ok: true,
        error: null,
        created: a.action.kind === "resubmit" ? `${t.name}-re${++created}` : null,
      }));
    case "argowf_archived_action":
      return null;
    case "argowf_cron_action":
      return a.action.kind === "submit" ? `${a.name}-manual-${++created}` : null;
    case "argowf_submit_template":
      return `${a.options?.generateName ?? `${a.name}-`}${++created}`;
    case "argowf_manifest":
      return `apiVersion: argoproj.io/v1alpha1\nkind: ${a.kind}\nmetadata:\n  name: ${a.name}\n${a.namespace ? `  namespace: ${a.namespace}\n` : ""}spec: {}\n`;
    case "argowf_lint":
      return String(a.yaml).includes("kind:") ? { ok: true, message: null } : { ok: false, message: "kind가 없어요" };
    case "argowf_create":
      return { namespace: a.namespace, name: `demo-${++created}` };
    case "argowf_update":
    case "argowf_delete":
      return null;
    case "argowf_event_bindings":
      return BINDINGS.filter((b) => !a.namespace || b.namespace === a.namespace);
    case "argowf_event_sources":
      return EVENT_SOURCES.filter((s) => !a.namespace || s.namespace === a.namespace);
    case "argowf_sensors":
      return SENSORS.filter((s) => !a.namespace || s.namespace === a.namespace);
    case "argowf_resource_logs":
      return sendLines(a, [
        { pod: `${a.name}-7d9f`, text: '{"level":"info","msg":"dependency resolved","dependency":"release"}' },
        { pod: `${a.name}-7d9f`, text: '{"level":"info","msg":"trigger fired","trigger":"release-workflow"}' },
      ]);
    case "argowf_plugins":
      return [
        {
          namespace: "argo",
          name: "slack-executor-plugin",
          description: "Slack으로 알림을 보내는 실행기 플러그인",
          image: "example.registry/argo-slack-plugin:0.3.1",
        },
      ];
    default:
      return null;
  }
}

export const ARGOWF_DEMO_SERVER = { name: "demo", url: URL, context: "demo-eks" };
