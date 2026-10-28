// 할당 표의 순수 로직: 개요(주체 요약의 attached·groups)에서 칸 상태를 만들고, 칸 누르기·칠하기·"다른 주체와 같게"를 장바구니 변경으로 바꾼다.
import { changeBlockReason } from "./protect";
import type { Badge, IamChange, IamOverview, PrincipalSummary } from "./types";

export const MAX_DRAFT = 50;
export type AssignmentTab = "policies" | "members";

/** 표의 열. 정책 탭은 정책 ARN, 그룹 구성원 탭은 그룹 이름이 id다 */
export interface Column { id: string; name: string; scope: "aws" | "local" | null; badges: Badge[] }
/** 정책 탭의 칸. via: 그 정책을 준 그룹 이름(이름순) */
export interface PolicyCell { direct: boolean; via: string[] }
/** 장바구니 한 줄. key는 칸을 가리키고, 같은 칸의 변경은 하나만 있다 */
export interface DraftItem { key: string; change: IamChange; label: string }

export function changeKey(c: IamChange): string | null {
  switch (c.op) {
    case "attachPolicy":
    case "detachPolicy":
      return `policies|${c.target}|${c.policyArn}`;
    case "addToGroup":
    case "removeFromGroup":
      return `members|${c.userName}|${c.groupName}`;
    default:
      return null;
  }
}

/** 칸의 키. 정책 탭은 주체 ARN, 그룹 구성원 탭은 사용자 이름으로 가리킨다(변경이 쓰는 값과 같다) */
export function rowKey(tab: AssignmentTab, row: PrincipalSummary, column: string): string {
  return tab === "policies" ? `policies|${row.arn}|${column}` : `members|${row.name}|${column}`;
}

const lastSegment = (arn: string) => arn.slice(arn.lastIndexOf("/") + 1);

/** AWS 관리형 정책의 ARN인지(arn:aws:iam::aws:policy/…). 고객 관리형은 그 자리에 계정 번호가 들어간다 */
const isAwsManaged = (arn: string) => arn.includes(":aws:policy/");

export function policyName(ov: IamOverview, arn: string): string {
  return ov.policies.find((p) => p.arn === arn)?.name ?? lastSegment(arn);
}

export function policyColumns(ov: IamOverview, extra: string[]): Column[] {
  const count = new Map<string, number>();
  for (const p of [...ov.users, ...ov.groups, ...ov.roles]) for (const arn of p.attached ?? []) count.set(arn, (count.get(arn) ?? 0) + 1);
  const byArn = new Map(ov.policies.map((p) => [p.arn, p]));
  const column = (arn: string): Column => {
    const p = byArn.get(arn);
    return p ? { id: arn, name: p.name, scope: p.scope, badges: p.badges } : { id: arn, name: lastSegment(arn), scope: isAwsManaged(arn) ? "aws" : "local", badges: [] };
  };
  const used = [...count.keys()].sort((a, b) => count.get(b)! - count.get(a)! || column(a).name.localeCompare(column(b).name));
  const added = extra.filter((arn, i) => !count.has(arn) && extra.indexOf(arn) === i);
  return [...used, ...added].map(column);
}

export function groupColumns(ov: IamOverview): Column[] {
  return [...ov.groups].sort((a, b) => a.name.localeCompare(b.name)).map((g) => ({ id: g.name, name: g.name, scope: null, badges: g.badges }));
}

export function policyCell(ov: IamOverview, row: PrincipalSummary, policyArn: string): PolicyCell {
  const via = row.kind === "user" ? (row.groups ?? []).filter((g) => ov.groups.find((x) => x.name === g)?.attached?.includes(policyArn)).sort() : [];
  return { direct: (row.attached ?? []).includes(policyArn), via };
}

/** 칸이 실제로 붙어(속해) 있는지 */
export function isActual(ov: IamOverview, tab: AssignmentTab, row: PrincipalSummary, column: string): boolean {
  return tab === "policies" ? (row.attached ?? []).includes(column) : (row.groups ?? []).includes(column);
}

/** 보이는 상태 = 실제 상태에 대기 변경을 반영한 것 */
export function isShown(draft: DraftItem[], ov: IamOverview, tab: AssignmentTab, row: PrincipalSummary, column: string): boolean {
  const pending = draft.some((d) => d.key === rowKey(tab, row, column));
  return isActual(ov, tab, row, column) !== pending;
}

/** 바꿀 수 있는 칸인지: 잠긴 행과(정책 탭) 그룹으로만 받은 칸은 못 바꾼다 */
export function isEditable(ov: IamOverview, tab: AssignmentTab, row: PrincipalSummary, column: string): boolean {
  if (changeBlockReason(row)) return false;
  if (tab === "members") return true;
  const cell = policyCell(ov, row, column);
  return cell.direct || cell.via.length === 0;
}

export function draftLabel(ov: IamOverview, change: IamChange, principal: string): string {
  switch (change.op) {
    case "attachPolicy":
      return `${policyName(ov, change.policyArn)} 붙이기 · ${principal}`;
    case "detachPolicy":
      return `${policyName(ov, change.policyArn)} 떼기 · ${principal}`;
    case "addToGroup":
      return `${change.groupName}에 넣기 · ${principal}`;
    case "removeFromGroup":
      return `${change.groupName}에서 빼기 · ${principal}`;
    default:
      return change.op;
  }
}

function itemFor(ov: IamOverview, tab: AssignmentTab, row: PrincipalSummary, column: string, want: boolean): DraftItem {
  const change: IamChange =
    tab === "policies"
      ? { op: want ? "attachPolicy" : "detachPolicy", target: row.arn, policyArn: column }
      : { op: want ? "addToGroup" : "removeFromGroup", userName: row.name, groupName: column };
  return { key: rowKey(tab, row, column), change, label: draftLabel(ov, change, row.name) };
}

/** 칸을 목표 상태로: 실제 상태가 이미 want면 그 칸의 대기 변경을 지우고, 아니면 want로 가는 대기 변경을 둔다. 꽉 찼으면 full */
export function setCell(draft: DraftItem[], ov: IamOverview, tab: AssignmentTab, row: PrincipalSummary, column: string, want: boolean): { draft: DraftItem[]; full: boolean } {
  if (!isEditable(ov, tab, row, column)) return { draft, full: false };
  const key = rowKey(tab, row, column);
  const pending = draft.some((d) => d.key === key);
  if (isActual(ov, tab, row, column) === want) return { draft: pending ? draft.filter((d) => d.key !== key) : draft, full: false };
  if (pending) return { draft, full: false };
  if (draft.length >= MAX_DRAFT) return { draft, full: true };
  return { draft: [...draft, itemFor(ov, tab, row, column, want)], full: false };
}

export function toggleCell(draft: DraftItem[], ov: IamOverview, tab: AssignmentTab, row: PrincipalSummary, column: string) {
  return setCell(draft, ov, tab, row, column, !isShown(draft, ov, tab, row, column));
}

export function paintCells(draft: DraftItem[], ov: IamOverview, tab: AssignmentTab, cells: { row: PrincipalSummary; column: string }[], want: boolean) {
  let full = false;
  let next = draft;
  for (const { row, column } of cells) {
    const r = setCell(next, ov, tab, row, column, want);
    next = r.draft;
    full ||= r.full;
  }
  return { draft: next, full };
}

/** "다른 주체와 같게": 원본에만 있는 것(add)과 대상에만 있는 것(extra). 그룹으로 받은 것은 보지 않고, 대상에서 바꿀 수 없는 칸(잠긴 대상, 그룹으로만 받는 정책)은 내놓지 않는다 */
export function matchPrincipal(ov: IamOverview, tab: AssignmentTab, source: PrincipalSummary, target: PrincipalSummary): { add: string[]; extra: string[] } {
  const of = (p: PrincipalSummary) => (tab === "policies" ? p.attached ?? [] : p.groups ?? []);
  const [s, t] = [of(source), of(target)];
  const editable = (column: string) => isEditable(ov, tab, target, column);
  return { add: s.filter((x) => !t.includes(x) && editable(x)), extra: t.filter((x) => !s.includes(x) && editable(x)) };
}

export function matchChanges(draft: DraftItem[], ov: IamOverview, tab: AssignmentTab, target: PrincipalSummary, add: string[], remove: string[]) {
  const on = paintCells(draft, ov, tab, add.map((column) => ({ row: target, column })), true);
  const off = paintCells(on.draft, ov, tab, remove.map((column) => ({ row: target, column })), false);
  return { draft: off.draft, full: on.full || off.full };
}

function rowOf(ov: IamOverview, c: IamChange): PrincipalSummary | undefined {
  if (c.op === "attachPolicy" || c.op === "detachPolicy") return [...ov.users, ...ov.groups, ...ov.roles].find((p) => p.arn === c.target);
  if (c.op === "addToGroup" || c.op === "removeFromGroup") return ov.groups.some((g) => g.name === c.groupName) ? ov.users.find((u) => u.name === c.userName) : undefined;
  return undefined;
}

/** 붙이려는 고객 관리형 정책이 개요에 없으면 지워진 것이다(개요는 고객 관리형을 모두 담는다). AWS 관리형은 어디에도 안 붙은 것이 목록에 없을 수 있어서 보지 않는다 */
function policyGone(ov: IamOverview, c: IamChange): boolean {
  return c.op === "attachPolicy" && !isAwsManaged(c.policyArn) && !ov.policies.some((p) => p.arn === c.policyArn);
}

const DONE: Record<string, string> = {
  attachPolicy: "이미 붙어 있어서 뺐어요",
  detachPolicy: "이미 떨어져 있어서 뺐어요",
  addToGroup: "이미 그룹에 있어서 뺐어요",
  removeFromGroup: "이미 그룹에 없어서 뺐어요",
};

/** 개요를 다시 불러온 뒤 장바구니 정리: 이미 그 상태가 된 변경과 대상(주체·그룹·붙일 정책)이 없어진 변경을 빼고 알린다. 바뀐 것이 없으면 같은 배열을 돌려준다 */
export function normalizeDraft(ov: IamOverview, draft: DraftItem[]): { draft: DraftItem[]; notices: string[] } {
  const notices: string[] = [];
  const kept = draft.filter((d) => {
    const row = rowOf(ov, d.change);
    if (!row || policyGone(ov, d.change)) {
      notices.push(`찾을 수 없어서 뺐어요: ${d.label}`);
      return false;
    }
    const tab: AssignmentTab = d.change.op === "attachPolicy" || d.change.op === "detachPolicy" ? "policies" : "members";
    const column = d.change.op === "attachPolicy" || d.change.op === "detachPolicy" ? d.change.policyArn : (d.change as { groupName: string }).groupName;
    const want = d.change.op === "attachPolicy" || d.change.op === "addToGroup";
    if (isActual(ov, tab, row, column) === want) {
      notices.push(`${DONE[d.change.op]}: ${d.label}`);
      return false;
    }
    return true;
  });
  return kept.length === draft.length ? { draft, notices } : { draft: kept, notices };
}

export function removeApplied(draft: DraftItem[], applied: IamChange[]): DraftItem[] {
  const keys = new Set(applied.map(changeKey).filter((k): k is string => k !== null));
  return draft.filter((d) => !keys.has(d.key));
}
