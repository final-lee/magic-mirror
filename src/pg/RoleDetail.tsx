import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { formatDateTime, formatDay } from "../iam/format";
import { BadgeList } from "./Badges";
import { COVERAGE_LABEL, OBJECT_KIND_LABEL, ROLE_KIND_LABEL, objectName, unusableText } from "./labels";
import { PgError } from "./PgError";
import { usePgDatabase, usePgRole } from "./queries";
import { roleRoute, type PgRoute } from "./route";
import type { PgRoleDatabase, PgRoleView, PgSession, PgTarget } from "./types";

type Tab = "overview" | "members" | "privileges" | "owned" | "sessions";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "개요" },
  { id: "members", label: "구성원" },
  { id: "privileges", label: "권한" },
  { id: "owned", label: "소유 객체" },
  { id: "sessions", label: "세션" },
];

const DASH = "—";
const yesNo = (v: boolean) => (v ? "예" : "아니요");

interface Props {
  target: PgTarget;
  /** 역할 이름 */
  role: string;
  onOpen: (route: PgRoute) => void;
  /** 뒤로 가기로 돌아왔을 때 보던 하위 탭을 되살린다 */
  initialTab?: string;
  onViewState?: (state: { tab: string }) => void;
}

/** 아직 읽지 않은 데이터베이스를 [불러오기]로 읽는 일. 권한 탭과 소유 객체 탭이 함께 쓴다. */
interface Load {
  target: PgTarget;
  /** [불러오기]를 누른 데이터베이스들 */
  requested: ReadonlySet<string>;
  onRequest: (database: string) => void;
  /** 데이터베이스를 읽었다. 역할을 다시 읽어 그 데이터베이스의 내용을 받는다. */
  onLoaded: () => void;
}

export function RoleDetail({ target, role, onOpen, initialTab, onViewState }: Props) {
  const q = usePgRole(target, role);
  const [tab, setTab] = useState<Tab>(TABS.find((t) => t.id === initialTab)?.id ?? "overview");
  const [requested, setRequested] = useState<ReadonlySet<string>>(new Set());
  const view = q.data;

  if (!view) {
    return (
      <section className="center">
        {q.isError ? <PgError error={q.error} target={target} /> : <div className="empty">불러오는 중…</div>}
      </section>
    );
  }

  const openTab = (id: Tab) => {
    setTab(id);
    onViewState?.({ tab: id });
  };
  const load: Load = {
    target,
    requested,
    onRequest: (database) => setRequested((current) => new Set(current).add(database)),
    onLoaded: () => void q.refetch(),
  };

  return (
    <section className="center iam-detail">
      {q.isError && <PgError compact error={q.error} target={target} />}
      <header className="iam-head">
        <div className="iam-title">
          <h2>{view.summary.name}</h2>
          <span className="iam-kind">{ROLE_KIND_LABEL[view.summary.kind]}</span>
        </div>
        <BadgeList badges={view.summary.badges} />
      </header>
      <div className="iam-tabs" role="tablist" aria-label="상세 항목">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab} className={`iam-tab${t.id === tab ? " on" : ""}`} onClick={() => openTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="iam-pane" role="tabpanel">
        {tab === "overview" && <Overview view={view} />}
        {tab === "members" && <Members view={view} onOpen={onOpen} />}
        {tab === "privileges" && <Privileges view={view} load={load} />}
        {tab === "owned" && <Databases view={view} load={load}>{(db) => <OwnedObjects db={db} />}</Databases>}
        {tab === "sessions" && <Sessions sessions={view.sessions} />}
      </div>
    </section>
  );
}

function Overview({ view }: { view: PgRoleView }) {
  const a = view.summary.attributes;
  const attributes: [string, string][] = [
    ["LOGIN", yesNo(a.login)],
    ["CREATEDB", yesNo(a.createDb)],
    ["CREATEROLE", yesNo(a.createRole)],
    ["INHERIT", yesNo(a.inherit)],
    ["REPLICATION", yesNo(a.replication)],
    ["BYPASSRLS", yesNo(a.bypassRls)],
    ["연결 수 제한", a.connectionLimit < 0 ? "제한 없음" : String(a.connectionLimit)],
    ["만료일", a.validUntil ? formatDay(a.validUntil) : "없음"],
  ];
  return (
    <div className="pg-overview">
      <dl className="kv">
        {attributes.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
      <section aria-label="역할별 설정">
        <h3 className="pg-sect">역할별 설정</h3>
        {view.settings.length === 0 ? (
          <p className="dim">설정한 값이 없어요</p>
        ) : (
          <ul className="pg-settings" aria-label="역할별 설정">
            {view.settings.map((s) => (
              <li key={`${s.database}:${s.setting}`}>
                <span className="dim">{s.database ?? "모든 데이터베이스"}</span>
                <code className="mono">{s.setting}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="주석">
        <h3 className="pg-sect">주석</h3>
        {view.summary.comment ? <p>{view.summary.comment}</p> : <p className="dim">없음</p>}
      </section>
    </div>
  );
}

/** 구성원 관계 하나의 표시: 상속하는지(아니면 SET ROLE로만 쓸 수 있다)와 ADMIN OPTION */
function Marks({ inherit, admin }: { inherit: boolean; admin: boolean }) {
  return (
    <>
      <span className={`iam-chip${inherit ? "" : " conditional"}`}>{inherit ? "상속" : "SET ROLE로만 쓸 수 있음"}</span>
      {admin && <span className="iam-chip">ADMIN OPTION</span>}
    </>
  );
}

function Members({ view, onOpen }: { view: PgRoleView; onOpen: (route: PgRoute) => void }) {
  const groups = view.summary.memberOf.map((m) => ({ name: m.group, inherit: m.inherit, admin: m.admin }));
  const members = view.members.map((m) => ({ name: m.role, inherit: m.inherit, admin: m.admin }));
  const list = (label: string, items: typeof groups, empty: string) =>
    items.length === 0 ? (
      <div className="empty small">{empty}</div>
    ) : (
      <ul className="iam-names" aria-label={label}>
        {items.map((m) => (
          <li key={m.name}>
            <button className="link" onClick={() => onOpen(roleRoute(m.name))}>
              {m.name}
            </button>
            <Marks inherit={m.inherit} admin={m.admin} />
          </li>
        ))}
      </ul>
    );
  return (
    <div className="pg-members">
      <h3 className="pg-sect">속한 그룹</h3>
      {list("속한 그룹", groups, "속한 그룹이 없어요")}
      <h3 className="pg-sect">구성원</h3>
      {list("구성원", members, "구성원이 없어요")}
    </div>
  );
}

function Privileges({ view, load }: { view: PgRoleView; load: Load }) {
  return (
    <>
      {view.setRoleOnly.length > 0 && <div className="iam-hint">SET ROLE을 해야 쓸 수 있는 역할의 권한은 아래에 넣지 않았어요: {view.setRoleOnly.join(", ")}</div>}
      <Databases view={view} load={load}>
        {(db) => <SchemaPrivileges db={db} />}
      </Databases>
    </>
  );
}

/** 연결할 수 있는 데이터베이스마다 한 구역. 읽은 데이터베이스는 내용을, 읽지 않은 데이터베이스는 [불러오기]를 보인다. */
function Databases({ view, load, children }: { view: PgRoleView; load: Load; children: (db: PgRoleDatabase) => ReactNode }) {
  if (view.databases.length === 0) return <div className="empty small">연결할 수 있는 데이터베이스가 없어요</div>;
  return (
    <>
      {view.databases.map((db) => (
        <section key={db.database} className="pg-db" aria-label={db.database}>
          <h3 className="pg-sect">{db.database}</h3>
          {db.loaded ? (
            children(db)
          ) : load.requested.has(db.database) ? (
            <DatabaseLoader target={load.target} database={db.database} onLoaded={load.onLoaded} />
          ) : (
            <div className="pg-unloaded">
              <span className="dim">아직 읽지 않았어요</span>
              <button className="btn small" onClick={() => load.onRequest(db.database)}>
                불러오기
              </button>
            </div>
          )}
        </section>
      ))}
    </>
  );
}

/**
 * [불러오기]를 누른 데이터베이스를 읽는다(usePgDatabase). 다 읽으면 역할을 다시 읽어, 백엔드가 그 데이터베이스를 읽은 것으로 답하게 한다.
 * 이미 다른 화면에서 읽어 둔 데이터베이스면 바로 끝나서 역할만 다시 읽는다.
 */
function DatabaseLoader({ target, database, onLoaded }: { target: PgTarget; database: string; onLoaded: () => void }) {
  const db = usePgDatabase(target, database);
  const latest = useRef(onLoaded);
  latest.current = onLoaded;
  const notified = useRef(false);
  const done = db.isSuccess;
  useEffect(() => {
    if (!done || notified.current) return;
    notified.current = true;
    latest.current();
  }, [done]);
  if (db.isError) return <PgError error={db.error} target={target} />;
  return <div className="empty small">불러오는 중…</div>;
}

function SchemaPrivileges({ db }: { db: PgRoleDatabase }) {
  if (db.cells.length === 0) return <div className="empty small">이 데이터베이스에서 받은 권한이 없어요</div>;
  const cells = [...db.cells].sort((a, b) => a.schema.localeCompare(b.schema));
  const has = (v: boolean) => (v ? "있음" : <span className="dim">없음</span>);
  return (
    <table className="pg-cells" aria-label={`${db.database} 권한`}>
      <thead>
        <tr>
          <th scope="col" className="nosort">
            스키마
          </th>
          <th scope="col" className="nosort">
            사용 <small>USAGE</small>
          </th>
          <th scope="col" className="nosort">
            만들기 <small>CREATE</small>
          </th>
          <th scope="col" className="nosort">
            읽기 <small>SELECT</small>
          </th>
          <th scope="col" className="nosort">
            쓰기 <small>INSERT·UPDATE·DELETE</small>
          </th>
          <th scope="col" className="nosort">
            출처
          </th>
        </tr>
      </thead>
      <tbody>
        {cells.map((c) => (
          <tr key={c.schema}>
            <td>
              <span className="pg-schema">{c.schema}</span>
              {c.unusable && <div className="pg-warn">⚠ {unusableText(c.unusable)}</div>}
            </td>
            <td>{has(c.usage)}</td>
            <td>{has(c.create)}</td>
            <td>{c.read === "none" ? <span className="dim">{COVERAGE_LABEL.none}</span> : COVERAGE_LABEL[c.read]}</td>
            <td>{c.write === "none" ? <span className="dim">{COVERAGE_LABEL.none}</span> : COVERAGE_LABEL[c.write]}</td>
            <td className="dim">{c.inheritedOnly ? "상속으로만 받음" : "직접 받음·소유"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OwnedObjects({ db }: { db: PgRoleDatabase }) {
  if (db.owned.length === 0 && db.ownedOmitted === 0) return <div className="empty small">소유한 객체가 없어요</div>;
  return (
    <>
      <table className="pg-owned" aria-label={`${db.database} 소유 객체`}>
        <thead>
          <tr>
            <th scope="col" className="nosort">
              종류
            </th>
            <th scope="col" className="nosort">
              이름
            </th>
          </tr>
        </thead>
        <tbody>
          {db.owned.map((o) => (
            <tr key={`${o.kind}:${objectName(o)}`}>
              <td>{OBJECT_KIND_LABEL[o.kind]}</td>
              <td className="mono">{objectName(o)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {db.ownedOmitted > 0 && <p className="dim pg-more">외 {db.ownedOmitted}개</p>}
    </>
  );
}

function Sessions({ sessions }: { sessions: PgSession[] }) {
  if (sessions.length === 0) return <div className="empty small">이 역할의 세션이 없어요</div>;
  return (
    <table className="pg-sessions" aria-label="세션 목록">
      <thead>
        <tr>
          {["데이터베이스", "클라이언트", "application_name", "상태", "시작", "대기"].map((label) => (
            <th key={label} scope="col" className="nosort">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.pid}>
            <td>{s.database ?? DASH}</td>
            <td className="mono">{s.clientAddr ?? DASH}</td>
            <td>
              {s.applicationName || DASH}
              {s.own && <span className="iam-chip pg-own">이 앱</span>}
            </td>
            <td>{s.state ?? DASH}</td>
            <td>{formatDateTime(s.backendStart) || DASH}</td>
            <td>{s.waitEvent ?? DASH}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
