import { Fragment, useState } from "react";
import { desktop } from "../api/desktop";
import { ErrorState } from "../components/ErrorState";
import { ActionDrilldown } from "./ActionDrilldown";
import { BadgeList } from "./Badges";
import { formatAgo, formatDay } from "./format";
import { KIND_LABEL } from "./labels";
import { PermissionMatrix } from "./PermissionMatrix";
import { SCOPE_LABEL } from "./PolicyList";
import { useAccessKeys, usePrincipal } from "./queries";
import { policyRoute, principalRoute, type IamRoute, type MatrixCell } from "./route";
import type { AccessKeyInfo, AttachedPolicy, IamChange, IamOverview, PrincipalSummary, PrincipalView, TrustEntry } from "./types";
import { UnusedPermissions } from "./UnusedPermissions";

export type PrincipalTab = "permissions" | "policies" | "groups" | "members" | "keys" | "trust" | "unused";

interface Props {
  profile: string;
  arn: string;
  /** 그룹·구성원 이름을 ARN으로 바꿔 상세로 이동하는 데 쓴다 */
  overview: IamOverview;
  onOpen: (route: IamRoute) => void;
  /** 뒤로 가기로 돌아왔을 때 보던 하위 탭과 열어 둔 칸을 되살린다 */
  initialTab?: string;
  initialCell?: MatrixCell | null;
  onViewState?: (state: { tab: string; cell: MatrixCell | null }) => void;
  /** 안 쓰는 권한 탭의 [떼기]·[저장]이 만든 변경을 넘긴다. 없으면 그 버튼들은 꺼져 있다 */
  onFix?: (change: IamChange) => void;
}

interface TabSpec {
  id: PrincipalTab;
  label: string;
  count?: number;
}

/** 하위 탭 목록. 종류마다 다르다. 새 탭은 여기에 항목을 더하고 아래 PrincipalPane에 화면을 연결한다. */
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

  const findGroup = (name: string) => overview.groups.find((g) => g.name === name);
  const openGroup = (name: string) => {
    const g = findGroup(name);
    if (g) onOpen(principalRoute("group", g.arn));
  };
  const toggleCell = (c: MatrixCell) => commit({ cell: cell && cell.prefix === c.prefix && cell.level === c.level ? null : c });

  return (
    <>
      <section className="center iam-detail">
        {q.isError && <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />}
        <Header summary={view.summary} tags={view.tags} />
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
          {active === "policies" && <PoliciesPane policies={view.policies} overview={overview} onOpen={onOpen} />}
          {active === "groups" && (
            <NamesPane label="소속 그룹" empty="소속된 그룹이 없어요" names={view.groups} find={findGroup} onOpen={onOpen} />
          )}
          {active === "members" && (
            <NamesPane
              label="구성원"
              empty="구성원이 없어요"
              names={view.groups}
              find={(name) => overview.users.find((u) => u.name === name)}
              onOpen={onOpen}
            />
          )}
          {active === "keys" && <KeysPane profile={profile} userName={view.summary.name} />}
          {active === "trust" && <TrustPane trust={view.trust} />}
          {active === "unused" && (
            <UnusedPermissions profile={profile} arn={arn} onOpenPolicy={(id) => onOpen(policyRoute(id))} onOpenGroup={openGroup} onFix={onFix} />
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

function Header({ summary, tags }: { summary: PrincipalSummary; tags: Record<string, string> }) {
  const tagList = Object.entries(tags);
  return (
    <header className="iam-head">
      <div className="iam-title">
        <h2>{summary.name}</h2>
        <span className="iam-kind">{KIND_LABEL[summary.kind]}</span>
        {summary.path !== "/" && <span className="iam-path mono">{summary.path}</span>}
      </div>
      <div className="iam-arn">
        <span className="mono">{summary.arn}</span>
        <button className="link" aria-label="ARN 복사" onClick={() => void desktop.copy(summary.arn)}>
          복사
        </button>
      </div>
      <BadgeList badges={summary.badges} />
      <div className="iam-meta dim">
        {summary.createdAt && <span>만든 날 {formatDay(summary.createdAt)}</span>}
        {summary.kind !== "group" &&
          (summary.lastUsed ? (
            <span>
              마지막 사용 {formatDay(summary.lastUsed)} ({formatAgo(summary.lastUsed)})
            </span>
          ) : (
            <span>마지막 사용 기록 없음</span>
          ))}
      </div>
      {tagList.length > 0 && (
        <div>
          {tagList.map(([k, v]) => (
            <span className="tag" key={k}>
              {k}={v}
            </span>
          ))}
        </div>
      )}
    </header>
  );
}

function PermissionsPane({ view, cell, onSelect }: { view: PrincipalView; cell: MatrixCell | null; onSelect: (c: MatrixCell) => void }) {
  return (
    <>
      {view.notes.map((n) => (
        <div className="iam-hint" key={n}>
          <span aria-hidden="true">ⓘ</span> <span>{n}</span>
        </div>
      ))}
      <PermissionMatrix
        services={view.services}
        adminLike={view.adminLike}
        selected={cell ? { prefix: cell.prefix, level: cell.level } : null}
        onSelect={onSelect}
      />
      {view.unknownActions.length > 0 && (
        <section className="iam-unknown">
          <div className="sect">카탈로그에 없는 작업 {view.unknownActions.length}개</div>
          <p className="dim">접근 수준을 알 수 없어 위 표에는 넣지 않았어요.</p>
          <div>
            {view.unknownActions.map((a) => (
              <span className="tag mono" key={a}>
                {a}
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

const POLICY_SECTIONS: { id: string; label: string; match: (p: AttachedPolicy) => boolean }[] = [
  { id: "direct", label: "직접 연결", match: (p) => p.kind === "managed" && !p.via },
  { id: "inherited", label: "그룹에서 상속", match: (p) => !!p.via },
  { id: "inline", label: "인라인", match: (p) => p.kind === "inline" && !p.via },
  { id: "boundary", label: "권한 경계", match: (p) => p.kind === "boundary" },
];

function policyType(p: AttachedPolicy): string {
  if (p.kind === "inline") return "인라인";
  if (p.kind === "boundary") return "권한 경계";
  return p.scope ? SCOPE_LABEL[p.scope] : "관리형";
}

function PoliciesPane({ policies, overview, onOpen }: { policies: AttachedPolicy[]; overview: IamOverview; onOpen: (r: IamRoute) => void }) {
  if (policies.length === 0) return <div className="empty small">붙은 정책이 없어요</div>;
  // 한 정책은 처음 맞는 구역에만 나온다
  const taken = new Set<AttachedPolicy>();
  const sections = POLICY_SECTIONS.map((sec) => {
    const rows = policies.filter((p) => !taken.has(p) && sec.match(p));
    rows.forEach((p) => taken.add(p));
    return { ...sec, rows };
  }).filter((sec) => sec.rows.length > 0);

  return (
    <table className="iam-policies" aria-label="붙은 정책">
      <tbody>
        {sections.map((sec) => (
          <Fragment key={sec.id}>
            <tr className="sec">
              <th colSpan={4}>
                {sec.label} <span className="dim">{sec.rows.length}</span>
              </th>
            </tr>
            {sec.rows.map((p) => {
              const group = p.via ? overview.groups.find((g) => g.name === p.via) : undefined;
              return (
                <tr key={`${p.id}|${p.via ?? ""}`}>
                  <td>
                    <button className="link" onClick={() => onOpen(policyRoute(p.id))}>
                      {p.name}
                    </button>
                  </td>
                  <td>
                    <span className="iam-chip">{policyType(p)}</span>
                  </td>
                  <td>
                    {p.via && (
                      <span className="dim">
                        그룹{" "}
                        {group ? (
                          <button className="link" onClick={() => onOpen(principalRoute("group", group.arn))}>
                            {p.via}
                          </button>
                        ) : (
                          p.via
                        )}
                        에서 상속
                      </span>
                    )}
                  </td>
                  <td>
                    {/* 종류 칸이 이미 알려 주는 배지는 되풀이하지 않는다 */}
                    <BadgeList badges={p.badges} hide={["awsManaged", "boundary"]} />
                  </td>
                </tr>
              );
            })}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function NamesPane({
  label,
  empty,
  names,
  find,
  onOpen,
}: {
  label: string;
  empty: string;
  names: string[];
  find: (name: string) => PrincipalSummary | undefined;
  onOpen: (r: IamRoute) => void;
}) {
  if (names.length === 0) return <div className="empty small">{empty}</div>;
  return (
    <ul className="iam-names" aria-label={label}>
      {names.map((name) => {
        const p = find(name);
        return (
          <li key={name}>
            {p ? (
              <button className="link" onClick={() => onOpen(principalRoute(p.kind, p.arn))}>
                {name}
              </button>
            ) : (
              <span>{name}</span>
            )}
            {p && <BadgeList badges={p.badges} />}
          </li>
        );
      })}
    </ul>
  );
}

function KeyRow({ k }: { k: AccessKeyInfo }) {
  const where = [k.lastUsedService, k.lastUsedRegion].filter(Boolean).join(" · ");
  return (
    <tr>
      <td className="mono">{k.id}</td>
      <td>
        <span className={`dot ${k.status === "Active" ? "green" : ""}`} />
        {k.status}
      </td>
      <td>{formatDay(k.createdAt) || "—"}</td>
      <td>{k.ageDays === null ? "—" : `${k.ageDays}일`}</td>
      <td>{k.lastUsedAt ? formatDay(k.lastUsedAt) : <span className="dim">사용 기록 없음</span>}</td>
      <td>{where || <span className="dim">—</span>}</td>
    </tr>
  );
}

function KeysPane({ profile, userName }: { profile: string; userName: string }) {
  const q = useAccessKeys(profile, userName);
  if (q.isError) return <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />;
  if (!q.data) return <div className="empty small">불러오는 중…</div>;
  if (q.data.length === 0) return <div className="empty small">액세스 키가 없어요</div>;
  return (
    <table aria-label="액세스 키">
      <thead>
        <tr>
          <th className="nosort">키 ID</th>
          <th className="nosort">상태</th>
          <th className="nosort">만든 날</th>
          <th className="nosort">나이</th>
          <th className="nosort">마지막 사용</th>
          <th className="nosort">서비스 · 리전</th>
        </tr>
      </thead>
      <tbody>
        {q.data.map((k) => (
          <KeyRow key={k.id} k={k} />
        ))}
      </tbody>
    </table>
  );
}

const TRUST_LABEL: Record<TrustEntry["kind"], string> = {
  service: "서비스",
  account: "계정",
  federated: "연동",
  anyone: "누구나",
  principal: "주체",
};

function TrustPane({ trust }: { trust: TrustEntry[] }) {
  if (trust.length === 0) return <div className="empty small">이 역할을 맡을 수 있는 대상이 없어요</div>;
  return (
    <ul className="iam-trust" aria-label="신뢰 관계">
      {trust.map((t, i) => (
        <li key={i} className={t.warning ? "warn" : undefined}>
          <div className="tr-top">
            <span className={`iam-chip trust-${t.kind}`}>{TRUST_LABEL[t.kind]}</span>
            <span className="mono tr-value">{t.value}</span>
            {t.external && <span className="iam-chip conditional">외부</span>}
            {t.conditional && <span className="iam-chip">조건 있음</span>}
          </div>
          <div className="tr-actions">
            {t.actions.map((a) => (
              <span key={a} className="mono dim">
                {a}
              </span>
            ))}
          </div>
          {t.warning && (
            <div className="tr-warning">
              <span aria-hidden="true">⚠</span> <span>{t.warning}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
