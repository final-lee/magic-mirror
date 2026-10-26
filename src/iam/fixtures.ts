// 테스트(와 이후 데모)용 IAM 계정 샘플. 시각은 TZ에 상관없이 같은 날짜가 되도록 정오(UTC)로 둔다.
import type {
  AccessKeyInfo,
  AccessLevel,
  ActionGrant,
  Badge,
  BadgeKind,
  ChangeLogEntry,
  ChangePreview,
  FindingGroup,
  FindingItem,
  FindingKind,
  Findings,
  GrantSource,
  IamChange,
  IamOverview,
  Impact,
  LastAccessed,
  Level,
  LevelCell,
  PermDelta,
  PolicySummary,
  PolicyView,
  PrincipalKind,
  PrincipalSummary,
  PrincipalView,
  ServicePermissions,
  SimulateResult,
  TrustEntry,
  WhoCanResult,
} from "./types";

export const ACCOUNT = "123456789012";

export const arnOf = (kind: PrincipalKind, name: string, path = "/") => `arn:aws:iam::${ACCOUNT}:${kind}${path}${name}`;
export const policyArn = (name: string, aws = false) => `arn:aws:iam::${aws ? "aws" : ACCOUNT}:policy/${name}`;
export const inlineId = (ownerArn: string, name: string) => `inline:${ownerArn}:${name}`;

export const badge = (kind: BadgeKind, label: string, level: Level): Badge => ({ kind, label, level });
export const BADGES = {
  admin: badge("admin", "관리자급", "danger"),
  privesc: badge("privesc", "권한 상승 위험", "warn"),
  noMfa: badge("noMfa", "MFA 없음", "danger"),
  oldKey: badge("oldKey", "오래된 키", "warn"),
  // 백엔드: 누구나 맡을 수 있으면 danger, 외부 계정만 열려 있으면 warn
  externalTrust: badge("externalTrust", "외부 신뢰", "warn"),
  externalTrustOpen: badge("externalTrust", "외부 신뢰", "danger"),
  serviceLinked: badge("serviceLinked", "서비스 연결", "info"),
  awsManaged: badge("awsManaged", "AWS 관리형", "info"),
  unattached: badge("unattached", "안 붙음", "info"),
  boundary: badge("boundary", "권한 경계", "info"),
};

export function principal(kind: PrincipalKind, name: string, extra: Partial<PrincipalSummary> = {}): PrincipalSummary {
  const path = extra.path ?? "/";
  return {
    arn: arnOf(kind, name, path),
    name,
    kind,
    path,
    createdAt: "2025-01-10T12:00:00Z",
    lastUsed: null,
    policyCount: 0,
    memberCount: kind === "group" ? 0 : null,
    badges: [],
    ...extra,
  };
}

export const alice = principal("user", "alice", { lastUsed: "2026-10-20T12:00:00Z", policyCount: 3 });
export const bob = principal("user", "bob", { lastUsed: "2026-05-02T12:00:00Z", policyCount: 1, badges: [BADGES.noMfa, BADGES.oldKey] });
export const ciBot = principal("user", "ci-bot", { policyCount: 1, badges: [BADGES.admin] });
export const devTeam = principal("group", "dev-team", { policyCount: 1, memberCount: 2 });
export const admins = principal("group", "admins", { policyCount: 1, memberCount: 1, badges: [BADGES.admin] });
export const appRole = principal("role", "app-role", { lastUsed: "2026-10-25T12:00:00Z", policyCount: 2 });
export const partnerRole = principal("role", "partner-access", { policyCount: 1, badges: [BADGES.externalTrust] });
export const supportRole = principal("role", "AWSServiceRoleForSupport", {
  path: "/aws-service-role/support.amazonaws.com/",
  policyCount: 1,
  badges: [BADGES.serviceLinked],
});

export const adminPolicy: PolicySummary = {
  id: policyArn("AdministratorAccess", true),
  arn: policyArn("AdministratorAccess", true),
  name: "AdministratorAccess",
  scope: "aws",
  attachmentCount: 2,
  defaultVersionId: "v1",
  updatedAt: "2025-02-01T12:00:00Z",
  badges: [BADGES.awsManaged, BADGES.admin],
};
export const readOnlyPolicy: PolicySummary = {
  id: policyArn("ReadOnlyAccess", true),
  arn: policyArn("ReadOnlyAccess", true),
  name: "ReadOnlyAccess",
  scope: "aws",
  attachmentCount: 1,
  defaultVersionId: "v9",
  updatedAt: "2026-03-05T12:00:00Z",
  badges: [BADGES.awsManaged],
};
export const deployPolicy: PolicySummary = {
  id: policyArn("app-deploy"),
  arn: policyArn("app-deploy"),
  name: "app-deploy",
  scope: "local",
  attachmentCount: 2,
  defaultVersionId: "v2",
  updatedAt: "2026-08-01T12:00:00Z",
  badges: [],
};
export const orphanPolicy: PolicySummary = {
  id: policyArn("legacy-unused"),
  arn: policyArn("legacy-unused"),
  name: "legacy-unused",
  scope: "local",
  attachmentCount: 0,
  defaultVersionId: "v1",
  updatedAt: null,
  badges: [BADGES.unattached],
};

export function sampleOverview(extra: Partial<IamOverview> = {}): IamOverview {
  return {
    accountId: ACCOUNT,
    caller: { arn: `arn:aws:sts::${ACCOUNT}:assumed-role/dev/me`, principalArn: null },
    fetchedAt: "2026-10-26T03:04:05Z",
    users: [alice, bob, ciBot],
    groups: [devTeam, admins],
    roles: [appRole, partnerRole, supportRole],
    policies: [adminPolicy, readOnlyPolicy, deployPolicy, orphanPolicy],
    findingCount: 4,
    warnings: [],
    ...extra,
  };
}

// ── 권한 표 ──
export const cell = (total: number, allowed = 0, conditional = 0, denied = 0): LevelCell => ({ total, allowed, conditional, denied });
export const levels = (list: LevelCell, read: LevelCell, write: LevelCell, permissions: LevelCell, tagging: LevelCell): Record<AccessLevel, LevelCell> => ({
  list,
  read,
  write,
  permissions,
  tagging,
});

export const s3Perms: ServicePermissions = {
  prefix: "s3",
  name: "Amazon S3",
  danger: false,
  levels: levels(cell(5, 5), cell(40, 40), cell(60, 6, 2, 1), cell(12), cell(8)),
};
export const ec2Perms: ServicePermissions = {
  prefix: "ec2",
  name: "Amazon EC2",
  danger: false,
  levels: levels(cell(20, 20), cell(90, 90), cell(300, 10), cell(0), cell(0)),
};
export const iamPerms: ServicePermissions = {
  prefix: "iam",
  name: "IAM",
  danger: true,
  levels: levels(cell(10, 10), cell(30, 30), cell(60, 4), cell(25, 3), cell(6)),
};

export const readOnlyAttached = {
  id: readOnlyPolicy.id,
  name: "ReadOnlyAccess",
  kind: "managed" as const,
  scope: "aws" as const,
  via: null,
  badges: [BADGES.awsManaged],
  detachable: true,
};
export const deployAttached = {
  id: deployPolicy.id,
  name: "app-deploy",
  kind: "managed" as const,
  scope: "local" as const,
  via: "dev-team",
  badges: [],
  detachable: false,
};
// 백엔드의 detachable은 "주체에 직접 붙은 관리형 정책"일 때만 true다. 인라인(편집·삭제)과 권한 경계(변경 범위 밖)는 false.
export const scratchInline = {
  id: inlineId(alice.arn, "s3-scratch"),
  name: "s3-scratch",
  kind: "inline" as const,
  scope: null,
  via: null,
  badges: [],
  detachable: false,
};
export const devBoundary = {
  id: policyArn("dev-boundary"),
  name: "dev-boundary",
  kind: "boundary" as const,
  scope: "local" as const,
  via: null,
  badges: [BADGES.boundary],
  detachable: false,
};

export function aliceView(extra: Partial<PrincipalView> = {}): PrincipalView {
  return {
    summary: alice,
    policies: [readOnlyAttached, deployAttached, scratchInline, devBoundary],
    groups: ["dev-team"],
    trust: [],
    services: [ec2Perms, iamPerms, s3Perms],
    adminLike: false,
    unknownActions: [],
    tags: { team: "platform" },
    notes: [],
    ...extra,
  };
}

export const appRoleTrust: TrustEntry[] = [
  { kind: "service", value: "lambda.amazonaws.com", actions: ["sts:AssumeRole"], conditional: false, external: false, warning: null },
  {
    kind: "account",
    value: "999988887777",
    actions: ["sts:AssumeRole"],
    conditional: false,
    external: true,
    warning: "외부 계정이고 ExternalId 조건이 없어요",
  },
  { kind: "anyone", value: "*", actions: ["sts:AssumeRole"], conditional: true, external: true, warning: "누구나 이 역할을 맡을 수 있어요" },
];

export function appRoleView(extra: Partial<PrincipalView> = {}): PrincipalView {
  return {
    summary: appRole,
    policies: [
      { ...readOnlyAttached },
      { id: inlineId(appRole.arn, "queue-access"), name: "queue-access", kind: "inline", scope: null, via: null, badges: [], detachable: false },
    ],
    groups: [],
    trust: appRoleTrust,
    services: [s3Perms],
    adminLike: false,
    unknownActions: [],
    tags: {},
    notes: [],
    ...extra,
  };
}

export function devTeamView(extra: Partial<PrincipalView> = {}): PrincipalView {
  return {
    summary: devTeam,
    policies: [{ ...deployAttached, via: null, detachable: true }],
    groups: ["alice", "bob"],
    trust: [],
    services: [s3Perms],
    adminLike: false,
    unknownActions: [],
    tags: {},
    notes: [],
    ...extra,
  };
}

export const s3WriteGrants: ActionGrant[] = [
  {
    action: "s3:PutObject",
    status: "allowed",
    resources: ["arn:aws:s3:::assets/*"],
    sources: [
      { policyId: deployPolicy.id, policyName: "app-deploy", via: "dev-team", effect: "Allow", sid: "Deploy", statementIndex: 0, conditional: false, boundary: false },
    ],
    danger: null,
  },
  {
    action: "s3:PutBucketPolicy",
    status: "conditional",
    resources: ["*"],
    sources: [
      { policyId: scratchInline.id, policyName: "s3-scratch", via: null, effect: "Allow", sid: null, statementIndex: 1, conditional: true, boundary: false },
    ],
    danger: "버킷 정책을 바꿔 외부에 공개할 수 있어요",
  },
  {
    action: "s3:DeleteObject",
    status: "denied",
    resources: ["*"],
    sources: [
      { policyId: deployPolicy.id, policyName: "app-deploy", via: "dev-team", effect: "Allow", sid: "Deploy", statementIndex: 0, conditional: false, boundary: false },
      { policyId: scratchInline.id, policyName: "s3-scratch", via: null, effect: "Deny", sid: "NoDelete", statementIndex: 2, conditional: false, boundary: false },
    ],
    danger: null,
  },
  {
    action: "s3:PutBucketAcl",
    status: "boundary",
    resources: ["*"],
    sources: [
      { policyId: devBoundary.id, policyName: "dev-boundary", via: null, effect: "Allow", sid: null, statementIndex: 0, conditional: false, boundary: true },
    ],
    danger: null,
  },
];

// ── 정책 상세 ──
export function deployPolicyView(extra: Partial<PolicyView> = {}): PolicyView {
  const doc = {
    Version: "2012-10-17",
    Statement: [
      { Sid: "Deploy", Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject"], Resource: "arn:aws:s3:::assets/*" },
      { Sid: "DenyInsecure", Effect: "Deny", NotAction: "s3:ListAllMyBuckets", Resource: "*", Condition: { Bool: { "aws:SecureTransport": "false" } } },
    ],
  };
  return {
    id: deployPolicy.id,
    name: "app-deploy",
    scope: "local",
    arn: deployPolicy.arn,
    document: JSON.stringify(doc),
    statements: [
      {
        sid: "Deploy",
        effect: "Allow",
        notAction: false,
        actionPatterns: ["s3:PutObject", "s3:GetObject"],
        services: [{ prefix: "s3", name: "Amazon S3", levels: ["read", "write"], count: 2 }],
        notResource: false,
        resources: ["arn:aws:s3:::assets/*"],
        conditions: [],
      },
      {
        sid: "DenyInsecure",
        effect: "Deny",
        notAction: true,
        actionPatterns: ["s3:ListAllMyBuckets"],
        services: [{ prefix: "s3", name: "Amazon S3", levels: ["list", "read", "write", "permissions", "tagging"], count: 124 }],
        notResource: false,
        resources: ["*"],
        conditions: ["aws:SecureTransport · Bool · false"],
      },
    ],
    versions: [
      { id: "v2", isDefault: true, createdAt: "2026-08-01T12:00:00Z" },
      { id: "v1", isDefault: false, createdAt: "2026-01-02T12:00:00Z" },
    ],
    attachedTo: [
      { arn: devTeam.arn, name: "dev-team", kind: "group" },
      { arn: appRole.arn, name: "app-role", kind: "role" },
    ],
    editable: true,
    badges: [],
    ...extra,
  };
}

export const bobKeys: AccessKeyInfo[] = [
  {
    id: "AKIAIOSFODNN7EXAMPLE",
    status: "Active",
    createdAt: "2025-01-10T12:00:00Z",
    ageDays: 289,
    lastUsedAt: "2026-09-01T12:00:00Z",
    lastUsedService: "s3",
    lastUsedRegion: "ap-northeast-2",
  },
  {
    id: "AKIAI44QH8DHBEXAMPLE",
    status: "Inactive",
    createdAt: "2024-02-03T12:00:00Z",
    ageDays: 700,
    lastUsedAt: null,
    lastUsedService: null,
    lastUsedRegion: null,
  },
  // 마지막 사용을 읽을 권한이 없었던 키: 비어 있어도 "한 번도 안 씀"이 아니다
  {
    id: "AKIAI7UNKNOWNEXAMPLE",
    status: "Active",
    createdAt: "2026-03-01T12:00:00Z",
    ageDays: 239,
    lastUsedAt: null,
    lastUsedService: null,
    lastUsedRegion: null,
    lastUsedUnknown: true,
  },
];

// ── 점검 ──
export const rootArn = `arn:aws:iam::${ACCOUNT}:root`;
export const deactivateBobKey: IamChange = { op: "setAccessKeyStatus", userName: "bob", accessKeyId: "AKIAIOSFODNN7EXAMPLE", status: "Inactive" };
export const activateBobKey: IamChange = { op: "setAccessKeyStatus", userName: "bob", accessKeyId: "AKIAIOSFODNN7EXAMPLE", status: "Active" };

// 설계 문서 "보안 점검 규칙" 표의 순서
const FINDING_META: Record<FindingKind, { title: string; level: Level }> = {
  rootAccessKey: { title: "루트 액세스 키", level: "danger" },
  rootNoMfa: { title: "루트 MFA 없음", level: "danger" },
  consoleNoMfa: { title: "MFA 없는 콘솔 사용자", level: "danger" },
  oldAccessKey: { title: "오래된 액세스 키", level: "warn" },
  unusedAccessKey: { title: "안 쓰는 액세스 키", level: "warn" },
  inactiveUser: { title: "안 쓰는 사용자", level: "info" },
  inactiveRole: { title: "안 쓰는 역할", level: "info" },
  adminPrincipal: { title: "관리자급 주체", level: "warn" },
  privescPrincipal: { title: "권한 상승 위험 주체", level: "warn" },
  externalTrust: { title: "외부에 열린 신뢰", level: "danger" },
  unattachedPolicy: { title: "붙은 곳 없는 정책", level: "info" },
};

/** 표 순서대로 11개 그룹을 만든다. items를 주지 않은 그룹은 빈 그룹으로 포함된다. */
export function findingGroups(items: Partial<Record<FindingKind, FindingItem[]>> = {}): FindingGroup[] {
  return (Object.keys(FINDING_META) as FindingKind[]).map((kind) => ({ kind, ...FINDING_META[kind], items: items[kind] ?? [] }));
}

export const finding = (targetArn: string, targetName: string, detail: string, extra: Partial<FindingItem> = {}): FindingItem => ({
  targetArn,
  targetName,
  detail,
  cli: null,
  fix: null,
  ...extra,
});

export function sampleFindings(extra: Partial<Findings> = {}): Findings {
  return {
    generatedAt: "2026-10-26T03:00:00Z",
    warnings: [],
    groups: findingGroups({
      rootNoMfa: [finding(rootArn, "루트 계정", "루트 계정에 MFA가 없어요. 콘솔에서 MFA를 켜세요")],
      consoleNoMfa: [
        finding(bob.arn, "bob", "콘솔 비밀번호를 쓰는데 MFA가 없어요", { cli: "aws iam list-mfa-devices --user-name bob" }),
      ],
      oldAccessKey: [
        finding(bob.arn, "bob", "AKIAIOSFODNN7EXAMPLE 키를 만든 지 289일 지났어요", {
          cli: "aws iam update-access-key --user-name bob --access-key-id AKIAIOSFODNN7EXAMPLE --status Inactive",
          fix: deactivateBobKey,
        }),
      ],
      externalTrust: [
        finding(partnerRole.arn, "partner-access", "외부 계정 999988887777이 ExternalId 없이 맡을 수 있어요", {
          cli: "aws iam get-role --role-name partner-access",
        }),
      ],
    }),
    ...extra,
  };
}

// ── 누가 할 수 있나 ──
export const catalogActions = [
  "ec2:DescribeInstances",
  "iam:PassRole",
  "s3:DeleteObject",
  "s3:GetObject",
  "s3:GetObjectAcl",
  "s3:ListBucket",
  "s3:PutObject",
  "sqs:SendMessage",
];

export const grantSource = (extra: Partial<GrantSource> = {}): GrantSource => ({
  policyId: deployPolicy.id,
  policyName: "app-deploy",
  via: null,
  effect: "Allow",
  sid: "Deploy",
  statementIndex: 0,
  conditional: false,
  boundary: false,
  ...extra,
});

export function whoCanResult(extra: Partial<WhoCanResult> = {}): WhoCanResult {
  return {
    action: "s3:PutObject",
    resource: null,
    notes: ["사용자와 역할만 보여줘요. 그룹으로 받은 권한은 구성원에 합쳐서 계산해요"],
    hits: [
      { principal: alice, status: "allowed", sources: [grantSource({ via: "dev-team" })] },
      {
        principal: appRole,
        status: "conditional",
        sources: [grantSource({ policyId: scratchInline.id, policyName: "s3-scratch", sid: null, statementIndex: 1, conditional: true })],
      },
      {
        principal: ciBot,
        status: "boundary",
        sources: [grantSource({ policyId: devBoundary.id, policyName: "dev-boundary", sid: null, boundary: true })],
      },
      {
        principal: bob,
        status: "denied",
        sources: [
          grantSource(),
          grantSource({ policyId: scratchInline.id, policyName: "s3-scratch", effect: "Deny", sid: "NoPut", statementIndex: 2 }),
        ],
      },
    ],
    ...extra,
  };
}

export const simulateResults: SimulateResult[] = [
  { principalArn: alice.arn, decision: "allowed", matchedStatements: ["app-deploy#Deploy"], missingContext: [] },
  { principalArn: appRole.arn, decision: "allowed", matchedStatements: ["s3-scratch"], missingContext: ["aws:SourceIp"] },
  { principalArn: ciBot.arn, decision: "implicitDeny", matchedStatements: [], missingContext: [] },
  { principalArn: bob.arn, decision: "explicitDeny", matchedStatements: ["s3-scratch#NoPut"], missingContext: [] },
];

// ── 안 쓰는 권한 ──
export function sampleLastAccessed(extra: Partial<LastAccessed> = {}): LastAccessed {
  return {
    completedAt: "2026-10-26T03:10:00Z",
    trackingDays: 400,
    services: [
      {
        prefix: "s3",
        name: "Amazon S3",
        lastUsed: "2026-10-20T12:00:00Z",
        actions: [{ action: "s3:GetObject", lastUsed: "2026-10-20T12:00:00Z" }],
      },
      { prefix: "ec2", name: "Amazon EC2", lastUsed: "2026-02-01T12:00:00Z", actions: null },
      { prefix: "sqs", name: "Amazon SQS", lastUsed: null, actions: null },
      { prefix: "iam", name: "IAM", lastUsed: null, actions: null },
    ],
    unusedPolicies: [
      { policyId: readOnlyPolicy.id, name: "ReadOnlyAccess", via: null, reason: "허용하는 서비스를 400일 동안 하나도 안 썼어요" },
      { policyId: deployPolicy.id, name: "app-deploy", via: "dev-team", reason: "허용하는 서비스를 400일 동안 하나도 안 썼어요" },
    ],
    draft: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "arn:aws:s3:::assets/*" }],
    }),
    draftNotes: ["조건(Condition)은 초안에 넣지 않았어요", "작업 단위 기록이 없는 서비스는 서비스 전체(예: ec2:*)로 남겼어요"],
    ...extra,
  };
}

// ── 직접 변경 ──
export const attachReadOnlyToBob: IamChange = { op: "attachPolicy", target: bob.arn, policyArn: readOnlyPolicy.arn };
export const detachReadOnlyFromAlice: IamChange = { op: "detachPolicy", target: alice.arn, policyArn: readOnlyPolicy.arn };

/** 미리보기 응답. change를 그대로 되돌려 주고, 나머지는 경고 없는 가장 단순한 모양이다. */
export function previewOf(change: IamChange, extra: Partial<ChangePreview> = {}): ChangePreview {
  return {
    change,
    summary: `${change.op} 변경`,
    calls: [{ api: "iam:AttachUserPolicy", params: { UserName: "bob", PolicyArn: readOnlyPolicy.arn } }],
    impacts: [],
    warnings: [],
    confirmText: null,
    reversible: true,
    ...extra,
  };
}

export const permDelta = (prefix: string, level: AccessLevel, count: number, sample: string[] = []): PermDelta => ({ prefix, level, count, sample });

/** 영향 하나. 선택 필드(restricted, *Omitted)는 백엔드가 보낼 때처럼 필요할 때만 넣는다 */
export const impactOf = (who: PrincipalSummary, extra: Partial<Impact> = {}): Impact => ({ principal: who, gained: [], lost: [], ...extra });

/** 관리자 정책을 붙인 큰 그룹처럼 백엔드가 줄인 영향: 줄은 방향마다 20개, 나머지는 수만 온다 */
export function cappedImpact(who: PrincipalSummary): Impact {
  const rows = Array.from({ length: 20 }, (_, i) => permDelta(`svc${String(i).padStart(2, "0")}`, "write", 100 - i, [`svc${i}:Do${i}`]));
  return impactOf(who, { gained: rows, gainedOmitted: 1630 });
}

/** 백엔드가 계획이 달라져 적용을 거부할 때의 문구 */
export const PLAN_DRIFTED = "미리보기 뒤에 IAM이 바뀌었어요. 미리보기를 다시 받아 주세요.";

export function logEntry(extra: Partial<ChangeLogEntry> = {}): ChangeLogEntry {
  return {
    id: "log-1",
    at: "2026-10-26T12:00:00Z",
    profile: "prod",
    accountId: ACCOUNT,
    callerArn: `arn:aws:sts::${ACCOUNT}:assumed-role/dev/me`,
    change: deactivateBobKey,
    summary: "bob의 액세스 키 AKIAIOSFODNN7EXAMPLE를 비활성화했어요",
    calls: ["iam:UpdateAccessKey"],
    ok: true,
    error: null,
    inverse: activateBobKey,
    undoOf: null,
    undone: false,
    ...extra,
  };
}

/** 인라인 정책 상세. 소유자는 alice다. */
export function scratchInlineView(extra: Partial<PolicyView> = {}): PolicyView {
  return deployPolicyView({
    id: scratchInline.id,
    name: "s3-scratch",
    scope: "inline",
    arn: null,
    versions: [],
    attachedTo: [{ arn: alice.arn, name: "alice", kind: "user" }],
    ...extra,
  });
}
