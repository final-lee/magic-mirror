// README 스크린샷용 IAM 데모 응답. 테스트 픽스처(src/iam/fixtures.ts)의 작은 계정을 쓰고,
// 권한 표의 칸 수는 앱에 들어 있는 작업 카탈로그에서 그대로 센다.
import catalog from "../../src-tauri/src/iam/catalog.json";
import {
  activateBobKey,
  adminPolicy,
  admins,
  alice,
  appRole,
  appRoleView,
  BADGES,
  bob,
  bobKeys,
  cell,
  ciBot,
  deployAttached,
  deployPolicy,
  deployPolicyView,
  devBoundary,
  devTeam,
  devTeamView,
  finding,
  grantSource,
  logEntry,
  orphanPolicy,
  partnerRole,
  policyArn,
  previewOf,
  principal,
  readOnlyPolicy,
  sampleFindings,
  sampleLastAccessed,
  sampleOverview,
  scratchInline,
  scratchInlineView,
  simulateResults,
  supportRole,
  whoCanResult,
} from "../../src/iam/fixtures";
import { LEVELS } from "../../src/iam/labels";
import type {
  AccessLevel,
  ActionGrant,
  FindingItem,
  FindingKind,
  GrantSource,
  IamOverview,
  PolicySummary,
  PrincipalSummary,
  PrincipalView,
  ServicePermissions,
} from "../../src/iam/types";

type Code = "l" | "r" | "w" | "p" | "t";
const SERVICES = (catalog as unknown as { services: Record<string, { name: string; actions: Record<string, Code> }> }).services;
const CODE: Record<AccessLevel, Code> = { list: "l", read: "r", write: "w", permissions: "p", tagging: "t" };

const actionsOf = (prefix: string, level: AccessLevel) =>
  Object.entries(SERVICES[prefix].actions)
    .filter(([, c]) => c === CODE[level])
    .map(([a]) => `${prefix}:${a}`)
    .sort();

/** 수준별 [허용, 조건부, 거부·경계] 수. "all"은 그 수준의 작업 전부 허용 */
type Spec = Partial<Record<AccessLevel, "all" | number[]>>;

function service(prefix: string, spec: Spec, danger = false): ServicePermissions {
  const levels = {} as ServicePermissions["levels"];
  for (const l of LEVELS) {
    const total = actionsOf(prefix, l).length;
    const v = spec[l];
    const [a = 0, c = 0, d = 0] = v === "all" ? [total] : (v ?? []);
    levels[l] = cell(total, a, c, d);
  }
  return { prefix, name: SERVICES[prefix].name, danger, levels };
}

// 백엔드처럼 서비스 이름순(대소문자 무시)
const byName = (list: ServicePermissions[]) => list.sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()));

// ── 계정 ──
const developerBase: PolicySummary = {
  id: policyArn("developer-base"),
  arn: policyArn("developer-base"),
  name: "developer-base",
  scope: "local",
  attachmentCount: 3,
  defaultVersionId: "v4",
  updatedAt: "2026-09-14T12:00:00Z",
  badges: [BADGES.privesc],
};
// 권한 경계로만 쓰이면 AWS의 AttachmentCount는 0이다
const devBoundaryPolicy: PolicySummary = {
  id: devBoundary.id,
  arn: devBoundary.id,
  name: "dev-boundary",
  scope: "local",
  attachmentCount: 0,
  defaultVersionId: "v1",
  updatedAt: "2026-02-01T12:00:00Z",
  badges: [BADGES.boundary],
};

const demoAlice: PrincipalSummary = { ...alice, badges: [BADGES.privesc] };
const dana = principal("user", "dana", { lastUsed: "2026-10-24T12:00:00Z", policyCount: 2 });
const reporting = principal("user", "svc-reporting", { lastUsed: "2026-03-30T12:00:00Z", policyCount: 1, badges: [BADGES.oldKey] });
const dataEng = principal("group", "data-eng", { policyCount: 2, memberCount: 1 });
const ghDeploy = principal("role", "github-actions-deploy", { lastUsed: "2026-10-26T12:00:00Z", policyCount: 1 });
const ordersFn = principal("role", "orders-lambda", { lastUsed: "2026-10-26T12:00:00Z", policyCount: 2 });

const OVERVIEW: IamOverview = sampleOverview({
  caller: { arn: demoAlice.arn, principalArn: demoAlice.arn },
  users: [demoAlice, bob, ciBot, dana, reporting],
  groups: [devTeam, admins, dataEng],
  roles: [appRole, ghDeploy, ordersFn, partnerRole, supportRole],
  policies: [adminPolicy, readOnlyPolicy, deployPolicy, developerBase, devBoundaryPolicy, orphanPolicy],
});

// ── alice의 권한: developer-base + 그룹 dev-team의 app-deploy + 인라인 s3-scratch, 권한 경계 dev-boundary ──
const ALICE_SERVICES = byName([
  service("cloudwatch", { list: "all", read: "all", write: [1] }),
  service("logs", { list: "all", read: "all" }),
  service("dynamodb", { list: "all", read: "all", write: [0, 4] }),
  service("ec2", { list: "all", read: "all", write: [12], tagging: [1] }),
  service("ecr", { list: "all", read: "all", write: [5] }),
  service("iam", { list: "all", read: "all", write: [1] }, true),
  service("kms", { list: "all", read: [2], write: [0, 2] }),
  service("lambda", { list: "all", read: "all", write: [6], tagging: [2] }),
  service("s3", { list: "all", read: "all", write: [5, 2, 2], tagging: [3] }),
  service("secretsmanager", { list: "all", read: [0, 3] }),
  service("sqs", { read: "all", write: [3] }),
  service("sts", { read: [2], write: [1] }, true),
  service("ssm", { list: "all", read: [41, 12] }),
]);

const aliceView: PrincipalView = {
  summary: demoAlice,
  policies: [
    { id: developerBase.id, name: "developer-base", kind: "managed", scope: "local", via: null, badges: [BADGES.privesc], detachable: true },
    deployAttached,
    scratchInline,
    devBoundary,
  ],
  groups: ["dev-team"],
  trust: [],
  services: ALICE_SERVICES,
  adminLike: false,
  unknownActions: [],
  tags: { team: "platform", owner: "alice" },
  notes: [],
};

const baseSrc = (sid: string, statementIndex: number, extra: Partial<GrantSource> = {}) =>
  grantSource({ policyId: developerBase.id, policyName: "developer-base", sid, statementIndex, ...extra });
const deploySrc = grantSource({ via: "dev-team" });
const scratch = (extra: Partial<GrantSource>) => grantSource({ policyId: scratchInline.id, policyName: "s3-scratch", ...extra });
const grant = (action: string, status: ActionGrant["status"], resources: string[], sources: GrantSource[], danger: string | null = null): ActionGrant => ({
  action,
  status,
  resources,
  sources,
  danger,
});

const ASSETS = "arn:aws:s3:::prod-assets/*";
const PRIVESC = "권한 상승에 쓸 수 있는 작업이에요";

// 스크린샷에 쓰는 칸: S3 · 쓰기 (허용 5, 조건부 2, 거부 1, 경계로 차단 1)
const S3_WRITE: ActionGrant[] = [
  grant("s3:AbortMultipartUpload", "allowed", [ASSETS], [deploySrc]),
  grant("s3:DeleteBucket", "boundary", ["*"], [baseSrc("S3Admin", 2)]),
  grant("s3:DeleteObject", "denied", [ASSETS], [deploySrc, scratch({ effect: "Deny", sid: "NoDelete", statementIndex: 2 })]),
  grant("s3:PutBucketCORS", "allowed", ["arn:aws:s3:::prod-assets"], [baseSrc("S3Admin", 2)]),
  grant("s3:PutBucketVersioning", "conditional", ["arn:aws:s3:::scratch-*"], [scratch({ sid: "WithMfa", statementIndex: 1, conditional: true })]),
  grant("s3:PutBucketWebsite", "allowed", ["arn:aws:s3:::prod-assets"], [baseSrc("S3Admin", 2)]),
  grant("s3:PutLifecycleConfiguration", "conditional", ["arn:aws:s3:::scratch-*"], [scratch({ sid: "WithMfa", statementIndex: 1, conditional: true })]),
  grant("s3:PutObject", "allowed", [ASSETS, "arn:aws:s3:::scratch-alice/*"], [deploySrc, scratch({ sid: "Scratch", statementIndex: 0 })]),
  grant("s3:RestoreObject", "allowed", [ASSETS], [deploySrc]),
];

const SPECIAL: Record<string, ActionGrant[]> = {
  "s3/write": S3_WRITE,
  "iam/write": [grant("iam:PassRole", "allowed", [`arn:aws:iam::${OVERVIEW.accountId}:role/app-*`], [baseSrc("PassAppRoles", 4)], PRIVESC)],
  "sts/write": [grant("sts:AssumeRole", "allowed", [`arn:aws:iam::${OVERVIEW.accountId}:role/dev-*`], [baseSrc("AssumeDev", 5)], PRIVESC)],
};

/** 칸의 수에 맞춰 카탈로그 앞쪽 작업으로 목록을 채운다 */
function fillGrants(svc: ServicePermissions, level: AccessLevel): ActionGrant[] {
  const c = svc.levels[level];
  const names = actionsOf(svc.prefix, level);
  const src = baseSrc("ReadAll", 0);
  const at = (from: number, n: number) => names.slice(from, from + n);
  return [
    ...at(0, c.allowed).map((a) => grant(a, "allowed", ["*"], [src])),
    ...at(c.allowed, c.conditional).map((a) => grant(a, "conditional", ["*"], [{ ...src, conditional: true }])),
    ...at(c.allowed + c.conditional, c.denied).map((a) => grant(a, "denied", ["*"], [src, { ...src, effect: "Deny" as const, sid: "Guardrail" }])),
  ].sort((x, y) => x.action.localeCompare(y.action));
}

function genericView(p: PrincipalSummary): PrincipalView {
  const admin = p.badges.some((b) => b.kind === "admin");
  return {
    summary: p,
    policies: admin ? [{ id: adminPolicy.id, name: adminPolicy.name, kind: "managed", scope: "aws", via: null, badges: adminPolicy.badges, detachable: true }] : [],
    groups: [],
    trust: [],
    services: byName(
      admin
        ? ["ec2", "iam", "lambda", "s3", "sts"].map((x) => service(x, { list: "all", read: "all", write: "all", permissions: "all", tagging: "all" }, x === "iam" || x === "sts"))
        : [service("s3", { list: "all", read: "all" }), service("logs", { list: "all", read: "all" })],
    ),
    adminLike: admin,
    unknownActions: [],
    tags: {},
    notes: [],
  };
}

const VIEWS: Record<string, PrincipalView> = {
  [alice.arn]: aliceView,
  [appRole.arn]: appRoleView({ services: byName([service("s3", { list: "all", read: [40] }), service("sqs", { read: "all", write: [3] })]) }),
  [devTeam.arn]: devTeamView({ services: [service("s3", { list: "all", read: [2], write: [3] })] }),
};
const viewOf = (arn: string) => {
  if (VIEWS[arn]) return VIEWS[arn];
  const p = [...OVERVIEW.users, ...OVERVIEW.groups, ...OVERVIEW.roles].find((x) => x.arn === arn);
  return p ? genericView(p) : null;
};

function findings() {
  const f = sampleFindings();
  const extra: Partial<Record<FindingKind, FindingItem[]>> = {
    adminPrincipal: [finding(ciBot.arn, "ci-bot", "AdministratorAccess가 직접 붙어 있어요")],
    privescPrincipal: [finding(alice.arn, "alice", "iam:PassRole, sts:AssumeRole로 더 큰 권한을 얻을 수 있어요")],
    unattachedPolicy: [finding(orphanPolicy.arn, "legacy-unused", "어디에도 붙어 있지 않아요")],
  };
  return { ...f, groups: f.groups.map((g) => ({ ...g, items: [...g.items, ...(extra[g.kind] ?? [])] })) };
}

const ALICE_KEYS = [
  {
    id: "AKIAZ7ALICEEXAMPLE01",
    status: "Active" as const,
    createdAt: "2026-06-02T12:00:00Z",
    ageDays: 147,
    lastUsedAt: "2026-10-26T12:00:00Z",
    lastUsedService: "s3",
    lastUsedRegion: "ap-northeast-2",
  },
];

/** `iam_*` 명령만 처리한다. 모르는 명령이면 undefined */
export function iamMock(cmd: string, a: Record<string, any>): unknown {
  switch (cmd) {
    case "iam_overview":
      return { ...OVERVIEW, findingCount: findings().groups.reduce((n, g) => n + g.items.length, 0) };
    case "iam_principal":
      return viewOf(a.arn);
    case "iam_principal_actions": {
      const special = a.arn === alice.arn ? SPECIAL[`${a.prefix}/${a.level}`] : undefined;
      const svc = viewOf(a.arn)?.services.find((s) => s.prefix === a.prefix);
      return special ?? (svc ? fillGrants(svc, a.level) : []);
    }
    case "iam_policy":
      if (a.policyId === scratchInline.id) return scratchInlineView();
      if (a.policyId === deployPolicy.id) return deployPolicyView();
      return deployPolicyView({ id: a.policyId, arn: a.policyId, name: a.policyId.slice(a.policyId.lastIndexOf("/") + 1), attachedTo: [] });
    case "iam_actions":
      return Object.keys(SERVICES)
        .flatMap((p) => Object.keys(SERVICES[p].actions).map((x) => `${p}:${x}`))
        .sort();
    case "iam_who_can":
      return whoCanResult({ action: a.action, resource: a.resource ?? null });
    case "iam_simulate":
      return simulateResults.filter((r) => (a.principalArns as string[]).includes(r.principalArn));
    case "iam_findings":
      return findings();
    case "iam_access_keys":
      return a.userName === "bob" ? bobKeys : a.userName === "alice" ? ALICE_KEYS : [];
    case "iam_last_accessed":
      return sampleLastAccessed();
    case "iam_list_policies":
      return OVERVIEW.policies
        .filter((p) => p.name.toLowerCase().includes(String(a.query ?? "").toLowerCase()))
        .map((p) => ({ arn: p.arn, name: p.name, scope: p.scope, description: null, badges: p.badges }));
    case "iam_validate_policy":
      return { syntaxError: null, analyzerAvailable: true, findings: [] };
    case "iam_preview":
      return previewOf(a.change);
    case "iam_apply":
      return { logId: "log-2", summary: "적용했어요" };
    case "iam_change_log":
      return [logEntry()];
    case "iam_undo_change":
      return activateBobKey;
    default:
      return undefined;
  }
}
