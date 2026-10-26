import { useMemo, useState } from "react";
import { desktop } from "../api/desktop";
import { ErrorState } from "../components/ErrorState";
import { BadgeList } from "./Badges";
import { formatDay, prettyJson } from "./format";
import { KIND_LABEL, LEVEL_LABEL } from "./labels";
import { PolicyEditor } from "./PolicyEditor";
import { SCOPE_LABEL } from "./PolicyList";
import { usePolicy } from "./queries";
import { inlineOwnerFromId, principalRoute, type IamRoute } from "./route";
import type { IamChange, PolicyView, StatementView } from "./types";
import type { StartOptions } from "./useIamChange";

export type PolicyTab = "statements" | "json" | "versions" | "attached";

interface Props {
  profile: string;
  /** 관리형 정책 ARN 또는 "inline:<소유자 ARN>:<이름>" */
  policyId: string;
  onOpen: (route: IamRoute) => void;
  /** 뒤로 가기로 돌아왔을 때 보던 하위 탭을 되살린다 */
  initialTab?: string;
  onViewState?: (state: { tab: string }) => void;
  /** [편집]으로 만든 변경을 변경 흐름(미리보기 → 확인 → 적용)에 넘긴다. onApplied는 적용에 성공하면 불린다 */
  onFix: (change: IamChange, opts?: StartOptions) => void;
}

const SCOPE_TEXT: Record<PolicyView["scope"], string> = { ...SCOPE_LABEL, inline: "인라인" };

/**
 * 이 화면에서 고칠 수 있는 정책인지. 백엔드가 editable이라고 해도 AWS 관리형은 고치지 않고(편집 대상이 아니다),
 * 인라인 정책은 가진 주체를 id에서 알아볼 수 있어야 putInlinePolicy를 만들 수 있다.
 */
function canEdit(view: PolicyView): boolean {
  if (!view.editable) return false;
  if (view.scope === "local") return !!view.arn;
  return view.scope === "inline" && inlineOwnerFromId(view.id) !== null;
}

export function PolicyDetail({ profile, policyId, onOpen, initialTab, onViewState, onFix }: Props) {
  const q = usePolicy(profile, policyId);
  const [tab, setTab] = useState(initialTab ?? "statements");
  const [editing, setEditing] = useState(false);
  const view = q.data;

  if (!view) {
    return (
      <section className="center">
        {q.isError ? <ErrorState error={q.error} profile={profile} onRetry={() => void q.refetch()} /> : <div className="empty">불러오는 중…</div>}
      </section>
    );
  }

  const tabs: { id: PolicyTab; label: string; count?: number }[] = [
    { id: "statements", label: "문장", count: view.statements.length },
    { id: "json", label: "JSON" },
    { id: "versions", label: "버전", count: view.versions.length },
    { id: "attached", label: "붙어 있는 대상", count: view.attachedTo.length },
  ];
  const active = (tabs.find((t) => t.id === tab) ?? tabs[0]).id;
  const select = (id: PolicyTab) => {
    setTab(id);
    onViewState?.({ tab: id });
  };

  const inline = view.scope === "inline";
  const submit = (_name: string, document: string) => {
    const opts = { onApplied: () => setEditing(false) };
    if (inline) onFix({ op: "putInlinePolicy", target: inlineOwnerFromId(view.id)!, name: view.name, document }, opts);
    else onFix({ op: "updateManagedPolicy", policyArn: view.arn!, document }, opts);
  };

  return (
    <section className="center iam-detail">
      {q.isError && <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />}
      <header className="iam-head">
        <div className="iam-title">
          <h2>{view.name}</h2>
          <span className="iam-kind">{SCOPE_TEXT[view.scope]}</span>
          {!editing && canEdit(view) && (
            <button className="btn small" onClick={() => setEditing(true)}>
              편집
            </button>
          )}
        </div>
        {view.arn && (
          <div className="iam-arn">
            <span className="mono">{view.arn}</span>
            <button className="link" aria-label="ARN 복사" onClick={() => void desktop.copy(view.arn!)}>
              복사
            </button>
          </div>
        )}
        <BadgeList badges={view.badges} hide={["awsManaged"]} />
      </header>
      {editing ? (
        <div className="iam-pane">
          <PolicyEditor
            profile={profile}
            mode="edit"
            name={view.name}
            title={`${inline ? "인라인 정책" : "정책"} 편집 · ${view.name}`}
            document={prettyJson(view.document)}
            onCancel={() => setEditing(false)}
            onSubmit={submit}
          />
        </div>
      ) : (
        <>
          <div className="iam-tabs" role="tablist" aria-label="정책 항목">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={t.id === active} className={`iam-tab${t.id === active ? " on" : ""}`} onClick={() => select(t.id)}>
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
            {active === "statements" && <StatementsPane statements={view.statements} />}
            {active === "json" && <JsonPane document={view.document} />}
            {active === "versions" && <VersionsPane versions={view.versions} />}
            {active === "attached" && <AttachedPane attachedTo={view.attachedTo} onOpen={onOpen} />}
          </div>
        </>
      )}
    </section>
  );
}

function StatementRow({ s }: { s: StatementView }) {
  return (
    <tr>
      <td>
        <span className={`iam-chip ${s.effect === "Allow" ? "allow" : "deny"}`}>{s.effect}</span>
        {s.sid && <div className="st-sid mono dim">{s.sid}</div>}
      </td>
      <td>
        {s.notAction && <span className="iam-chip conditional">NotAction</span>}
        {s.services.map((svc) => (
          <div className="st-svc" key={svc.prefix}>
            <b>{svc.name}</b> <span className="dim">{svc.levels.map((l) => LEVEL_LABEL[l]).join(" · ")}</span> <span className="dim">{svc.count}개</span>
          </div>
        ))}
        <div className="st-patterns">
          {s.actionPatterns.map((a) => (
            <span key={a} className="mono dim">
              {a}
            </span>
          ))}
        </div>
      </td>
      <td>
        {s.notResource && <span className="iam-chip conditional">NotResource</span>}
        {s.resources.map((r) => (
          <div key={r} className="mono st-res">
            {r}
          </div>
        ))}
      </td>
      <td>
        {s.conditions.length === 0 ? (
          <span className="dim">조건 없음</span>
        ) : (
          s.conditions.map((c) => (
            <div key={c} className="mono st-cond">
              {c}
            </div>
          ))
        )}
      </td>
    </tr>
  );
}

function StatementsPane({ statements }: { statements: StatementView[] }) {
  if (statements.length === 0) return <div className="empty small">문장이 없어요</div>;
  return (
    <table className="iam-statements" aria-label="정책 문장">
      <thead>
        <tr>
          <th className="nosort">효과</th>
          <th className="nosort">작업</th>
          <th className="nosort">대상</th>
          <th className="nosort">조건</th>
        </tr>
      </thead>
      <tbody>
        {statements.map((s, i) => (
          <StatementRow key={i} s={s} />
        ))}
      </tbody>
    </table>
  );
}

function JsonPane({ document }: { document: string }) {
  // 보기 좋게 들여 쓴다. JSON이 아니면 받은 그대로 보여준다.
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(document), null, 2);
    } catch {
      return document;
    }
  }, [document]);
  return (
    <div className="iam-json">
      <div className="iam-json-bar">
        <button className="btn small" aria-label="JSON 복사" onClick={() => void desktop.copy(pretty)}>
          복사
        </button>
      </div>
      <pre className="raw" data-testid="policy-json">
        {pretty}
      </pre>
    </div>
  );
}

function VersionsPane({ versions }: { versions: PolicyView["versions"] }) {
  if (versions.length === 0) return <div className="empty small">버전 정보가 없어요</div>;
  return (
    <table aria-label="정책 버전">
      <thead>
        <tr>
          <th className="nosort">버전</th>
          <th className="nosort">상태</th>
          <th className="nosort">만든 날</th>
        </tr>
      </thead>
      <tbody>
        {versions.map((v) => (
          <tr key={v.id}>
            <td className="mono">{v.id}</td>
            <td>{v.isDefault && <span className="iam-chip allowed">기본</span>}</td>
            <td>{formatDay(v.createdAt) || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AttachedPane({ attachedTo, onOpen }: { attachedTo: PolicyView["attachedTo"]; onOpen: (r: IamRoute) => void }) {
  if (attachedTo.length === 0) return <div className="empty small">붙어 있는 곳이 없어요</div>;
  return (
    <ul className="iam-names" aria-label="붙어 있는 대상">
      {attachedTo.map((a) => (
        <li key={a.arn}>
          <span className="iam-chip">{KIND_LABEL[a.kind]}</span>
          <button className="link" onClick={() => onOpen(principalRoute(a.kind, a.arn))}>
            {a.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
