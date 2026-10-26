// 테스트(와 이후 데모)용 IAM 계정 샘플. 시각은 TZ에 상관없이 같은 날짜가 되도록 정오(UTC)로 둔다.
import type {
  AccessKeyInfo,
  AccessLevel,
  ActionGrant,
  Badge,
  BadgeKind,
  IamOverview,
  Level,
  LevelCell,
  PolicySummary,
  PolicyView,
  PrincipalKind,
  PrincipalSummary,
  PrincipalView,
  ServicePermissions,
  TrustEntry,
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
  externalTrust: badge("externalTrust", "외부 신뢰", "danger"),
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
export const scratchInline = {
  id: inlineId(alice.arn, "s3-scratch"),
  name: "s3-scratch",
  kind: "inline" as const,
  scope: null,
  via: null,
  badges: [],
  detachable: true,
};
export const devBoundary = {
  id: policyArn("dev-boundary"),
  name: "dev-boundary",
  kind: "boundary" as const,
  scope: "local" as const,
  via: null,
  badges: [BADGES.boundary],
  detachable: true,
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
      { id: inlineId(appRole.arn, "queue-access"), name: "queue-access", kind: "inline", scope: null, via: null, badges: [], detachable: true },
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
];
