import { useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { ActionDrilldown } from "./ActionDrilldown";
import { KeysPane } from "./KeysPane";
import { MembershipPane } from "./MembershipPane";
import { PermissionsPane } from "./PermissionsPane";
import { PoliciesPane } from "./PoliciesPane";
import { PrincipalHeader } from "./PrincipalHeader";
import { changeBlockReason } from "./protect";
import { usePrincipal } from "./queries";
import { policyRoute, principalRoute, type IamRoute, type MatrixCell } from "./route";
import { TrustPane } from "./TrustPane";
import type { IamChange, IamOverview, PrincipalView } from "./types";
import type { StartOptions } from "./useIamChange";
import { UnusedPermissions } from "./UnusedPermissions";

export type PrincipalTab = "permissions" | "policies" | "groups" | "members" | "keys" | "trust" | "unused";

interface Props {
  profile: string;
  arn: string;
  /** 그룹·구성원 이름을 ARN으로 바꿔 상세로 이동하고, 그룹·사용자 선택 목록을 만드는 데 쓴다 */
  overview: IamOverview;
  onOpen: (route: IamRoute) => void;
  /** 뒤로 가기로 돌아왔을 때 보던 하위 탭과 열어 둔 칸을 되살린다 */
  initialTab?: string;
  initialCell?: MatrixCell | null;
  onViewState?: (state: { tab: string; cell: MatrixCell | null }) => void;
  /** 이 화면의 모든 변경 버튼(붙이기·떼기·빼기·키·인라인 정책·안 쓰는 권한 조치)이 변경 흐름을 여는 곳 */
  onFix: (change: IamChange, opts?: StartOptions) => void;
}

interface TabSpec {
  id: PrincipalTab;
  label: string;
  count?: number;
}

/** 하위 탭 목록. 종류마다 다르다. 새 탭은 여기에 항목을 더하고 아래 PrincipalDetail에 화면을 연결한다. */
function tabsFor(view: PrincipalView): TabSpec[] {
  const tabs: TabSpec[] = [
    { id: "permissions", label: "권한" },
    { id: "policies", label: "정책", count: view.policies.length },
  ];
  switch (view.summary.kind) {
    case "user":
      tabs.push({ id: "groups", label: "그룹", count: view.groups.length }, { id: "keys", label: "액세스 키" });
      break;
    case "group":
      tabs.push({ id: "members", label: "구성원", count: view.groups.length });
      break;
    case "role":
      tabs.push({ id: "trust", label: "신뢰", count: view.trust.length });
      break;
  }
  // 설계 문서: 안 쓰는 권한 탭은 사용자·역할 상세에만 있다
  if (view.summary.kind !== "group") tabs.push({ id: "unused", label: "안 쓰는 권한" });
  return tabs;
}

/** 이미 있는 이름이면 -2, -3…을 붙여 비어 있는 이름을 찾는다(대소문자는 같은 이름으로 본다) */
function freeName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
  return name;
}

export function PrincipalDetail({ profile, arn, overview, onOpen, initialTab, initialCell = null, onViewState, onFix }: Props) {
  const q = usePrincipal(profile, arn);
  const [tab, setTab] = useState(initialTab ?? "permissions");
  const [cell, setCell] = useState<MatrixCell | null>(initialCell);
  const view = q.data;

  if (!view) {
    return (
      <section className="center">
        {q.isError ? <ErrorState error={q.error} profile={profile} onRetry={() => void q.refetch()} /> : <div className="empty">불러오는 중…</div>}
      </section>
    );
  }

  const tabs = tabsFor(view);
  const active = (tabs.find((t) => t.id === tab) ?? tabs[0]).id;
  const commit = (next: { tab?: string; cell?: MatrixCell | null }) => {
    const nextTab = next.tab ?? active;
    const nextCell = next.cell === undefined ? cell : next.cell;
    setTab(nextTab);
    setCell(nextCell);
    onViewState?.({ tab: nextTab, cell: nextCell });
  };

  const openGroup = (name: string) => {
    const g = overview.groups.find((group) => group.name === name);
    if (g) onOpen(principalRoute("group", g.arn));
  };
  // 안 쓰는 권한 탭이 만든 초안 저장은 이 주체의 기존 인라인 정책을 덮어쓰지 않도록 이름을 비켜 간다
  const ownInline = new Set(view.policies.filter((p) => p.kind === "inline" && !p.via).map((p) => p.name.toLowerCase()));
  const fixUnused = (change: IamChange) => onFix(change.op === "putInlinePolicy" ? { ...change, name: freeName(change.name, ownInline) } : change);
  const toggleCell = (c: MatrixCell) => commit({ cell: cell && cell.prefix === c.prefix && cell.level === c.level ? null : c });

  return (
    <>
      <section className="center iam-detail">
        {q.isError && <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />}
        <PrincipalHeader summary={view.summary} tags={view.tags} />
        <div className="iam-tabs" role="tablist" aria-label="상세 항목">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === active} className={`iam-tab${t.id === active ? " on" : ""}`} onClick={() => commit({ tab: t.id })}>
              {t.label}
              {t.count !== undefined && (
                <>
                  {" "}
                  <span className="iam-tab-n">{t.count}</span>
                </>
              )}
            </button>
          ))}
        </div>
        <div className="iam-pane" role="tabpanel">
          {active === "permissions" && <PermissionsPane view={view} cell={cell} onSelect={toggleCell} />}
          {active === "policies" && (
            <PoliciesPane profile={profile} summary={view.summary} policies={view.policies} overview={overview} onOpen={onOpen} onFix={onFix} />
          )}
          {active === "groups" && <MembershipPane kind="groups" summary={view.summary} names={view.groups} overview={overview} onOpen={onOpen} onFix={onFix} />}
          {active === "members" && <MembershipPane kind="members" summary={view.summary} names={view.groups} overview={overview} onOpen={onOpen} onFix={onFix} />}
          {active === "keys" && <KeysPane profile={profile} userName={view.summary.name} onFix={onFix} />}
          {active === "trust" && <TrustPane trust={view.trust} />}
          {active === "unused" && (
            <UnusedPermissions
              profile={profile}
              arn={arn}
              onOpenPolicy={(id) => onOpen(policyRoute(id))}
              onOpenGroup={openGroup}
              onFix={fixUnused}
              blockedReason={changeBlockReason(view.summary)}
            />
          )}
        </div>
      </section>
      {active === "permissions" && cell && (
        <ActionDrilldown
          profile={profile}
          arn={arn}
          cell={cell}
          onClose={() => commit({ cell: null })}
          onOpenPolicy={(id) => onOpen(policyRoute(id))}
          onOpenGroup={openGroup}
        />
      )}
    </>
  );
}
