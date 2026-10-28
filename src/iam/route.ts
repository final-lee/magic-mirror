import type { AccessLevel, IamOverview, PrincipalKind } from "./types";

export type IamView = "findings" | "users" | "groups" | "roles" | "policies" | "assignments" | "whoCan" | "log";

/** 권한 표에서 고른 칸 */
export interface MatrixCell {
  prefix: string;
  name: string;
  level: AccessLevel;
}

/** 누가 할 수 있나 화면에서 마지막으로 찾은 조건. resource가 빈 문자열이면 대상을 지정하지 않은 검색이다. */
export interface WhoCanSearch {
  action: string;
  resource: string;
}

/**
 * IAM 탭 안의 위치. 정체성은 view와 id뿐이고, tab과 cell과 search는 "그 화면에서 보던 상태"다.
 * 다른 화면으로 갔다가 뒤로 돌아오면 보던 하위 탭, 열어 둔 칸, 찾은 조건을 그대로 되살리려고 기록에 함께 둔다.
 * 점검 화면은 고른 점검 항목을 tab에 둔다.
 */
export interface IamRoute {
  view: IamView;
  /** 사용자·그룹·역할이면 ARN, 정책이면 policyId. 없으면 목록 화면 */
  id?: string;
  tab?: string;
  cell?: MatrixCell | null;
  search?: WhoCanSearch;
}

const VIEW_OF_KIND: Record<PrincipalKind, IamView> = { user: "users", group: "groups", role: "roles" };

export const VIEW_LABEL: Record<IamView, string> = {
  findings: "점검",
  users: "사용자",
  groups: "그룹",
  roles: "역할",
  policies: "정책",
  assignments: "할당",
  whoCan: "누가 할 수 있나",
  log: "변경 기록",
};

export const principalRoute = (kind: PrincipalKind, arn: string): IamRoute => ({ view: VIEW_OF_KIND[kind], id: arn });
export const policyRoute = (id: string): IamRoute => ({ view: "policies", id });

/** 같은 화면인지(하위 탭이나 열어 둔 칸은 보지 않는다) */
export const sameRoute = (a: IamRoute, b: IamRoute) => a.view === b.view && a.id === b.id;

/**
 * 리소스 목록에서 넘어온 ARN(사용자·역할·정책)이 가리키는 화면.
 * 스냅숏 목록에서 먼저 찾고, 없으면(방금 만든 역할 등) ARN의 리소스 종류로 판단한다.
 */
export function routeForFocus(overview: IamOverview, arn: string): IamRoute | null {
  for (const list of [overview.users, overview.groups, overview.roles]) {
    const found = list.find((p) => p.arn === arn);
    if (found) return principalRoute(found.kind, found.arn);
  }
  const policy = overview.policies.find((p) => p.arn === arn || p.id === arn);
  if (policy) return policyRoute(policy.id);
  const type = /^arn:[^:]*:iam::[^:]*:(user|group|role|policy)\//.exec(arn)?.[1];
  if (!type) return null;
  return type === "policy" ? policyRoute(arn) : principalRoute(type as PrincipalKind, arn);
}

/**
 * 정책 id에서 이름만 뽑는다. id는 관리형이면 정책 ARN, 인라인이면 "inline:<소유자 ARN>:<이름>"이다.
 * 이름에는 ':'가 들어갈 수 없으므로 마지막 ':' 뒤가 인라인 정책 이름이다.
 */
export function policyNameFromId(id: string): string {
  if (id.startsWith("inline:")) return id.slice(id.lastIndexOf(":") + 1);
  return id.slice(id.lastIndexOf("/") + 1);
}

/**
 * 인라인 정책 id("inline:<소유자 ARN>:<이름>")에서 정책을 가진 사용자·그룹·역할의 ARN.
 * 소유자를 알아볼 수 없으면 null이다. 이름에는 ':'가 들어갈 수 없으므로 마지막 ':' 앞이 소유자다.
 */
export function inlineOwnerFromId(id: string): string | null {
  if (!id.startsWith("inline:")) return null;
  const owner = id.slice("inline:".length, id.lastIndexOf(":"));
  return /^arn:[^:]*:iam::[^:]*:(user|group|role)\//.test(owner) ? owner : null;
}
