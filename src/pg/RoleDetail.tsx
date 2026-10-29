import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { MEMBERSHIP_SYSTEM_GROUPS, systemGroupText, systemRoleText } from "./canChange";
import { draftKey } from "./draft";
import { BadgeList } from "./Badges";
import { COVERAGE_LABEL, INHERITED_ONLY_TEXT, OBJECT_KIND_LABEL, ROLE_KIND_LABEL, TRUNCATED_TEXT, collate, dayToIso, objectName, unusableText, utcDay } from "./labels";
import { PgError } from "./PgError";
import { usePgDatabase, usePgRole } from "./queries";
import { roleRoute, type PgRoute } from "./route";
import { SessionTable } from "./Sessions";
import type { PgAttributesSet, PgChange, PgObjectKind, PgRoleDatabase, PgRoleSummary, PgRoleView, PgSchemaCell, PgSession, PgTarget } from "./types";
import type { GridDraft } from "./useChangeMode";

type Tab = "overview" | "members" | "privileges" | "owned" | "sessions";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "개요" },
  { id: "members", label: "구성원" },
  { id: "privileges", label: "권한" },
  { id: "owned", label: "소유 객체" },
  { id: "sessions", label: "세션" },
];

const yesNo = (v: boolean) => (v ? "예" : "아니요");

interface Props {
  target: PgTarget;
  /** 역할 이름 */
  role: string;
  onOpen: (route: PgRoute) => void;
  /** 뒤로 가기로 돌아왔을 때 보던 하위 탭을 되살린다 */
  initialTab?: string;
  onViewState?: (state: { tab: string }) => void;
  /** 바꾸기 모드(탭이 든다). 켜면 구성원 탭과 개요 탭에서 바꿀 수 있다. 장바구니(draft)가 있어야 켜진다 */
  editing?: boolean;
  draft?: GridDraft;
  /** 클러스터의 모든 역할(개요). 구성원 탭이 넣을 수 있는 그룹을 고른다 */
  roles?: PgRoleSummary[];
  /** 바꾸기 버튼([비밀번호 재설정], [삭제])을 끄는 이유(changeBlockReason). 있으면 두 버튼이 꺼지고 이 글이 제목이다 */
  blockReason?: string | null;
  /** [비밀번호 재설정]이 부른다. 주지 않으면 버튼이 없다 */
  onChange?: (change: PgChange) => void;
  /** [삭제]가 부른다(역할 삭제 창을 연다). 주지 않으면 버튼이 없다 */
  onDrop?: (role: string) => void;
}

/** 아직 읽지 않은 데이터베이스를 [불러오기]로 읽는 일. 권한 탭과 소유 객체 탭이 함께 쓴다. */
interface Load {
  target: PgTarget;
  /** [불러오기]를 누른 데이터베이스들 */
  requested: ReadonlySet<string>;
  onRequest: (database: string) => void;
}

export function RoleDetail({ target, role, onOpen, initialTab, onViewState, editing = false, draft, roles = [], blockReason = null, onChange, onDrop }: Props) {
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
  };
  // 이 상세에서 [불러오기]를 눌러 읽은 데이터베이스는, 상세가 열려 있는 동안 어느 하위 탭이 보이든 계속 구독한다.
  // 구독해야 refreshPg가 2단계에서 이 데이터베이스들을 다시 읽고, 그다음 3단계에서 역할을 읽는다.
  // 백엔드가 읽은 것으로 답한 나머지(점검 같은 다른 화면이 읽어 둔 것)는 구독하지 않는다. 구독하면 새로 고침마다 클러스터의 데이터베이스를
  // 모두 다시 읽게 된다. 그 데이터베이스들은 pg_open이 스냅숏을 비운 뒤 "아직 읽지 않았어요 [불러오기]"로 돌아오고, 누르면 읽는다.
  const followed = view.databases.filter((d) => requested.has(d.database));
  const reread = () => void q.refetch();
  const edit = editing && draft ? draft : null;
  // 시스템 역할은 지울 수 없다. 바꿀 수 없는 이유가 먼저다
  const dropOff = blockReason ?? (view.summary.system ? systemRoleText(view.summary.name) : null);

  return (
    <section className="center iam-detail">
      {followed.map((d) => (
        <DatabaseWatch key={d.database} target={target} database={d.database} waiting={!d.loaded} onRead={reread} />
      ))}
      {q.isError && <PgError compact error={q.error} target={target} />}
      <header className="iam-head">
        <div className="iam-title">
          <h2>{view.summary.name}</h2>
          <span className="iam-kind">{ROLE_KIND_LABEL[view.summary.kind]}</span>
        </div>
        <BadgeList badges={view.summary.badges} />
        {(onChange || onDrop) && (
          <span className="pg-head-actions">
            {onChange && view.summary.attributes.login && (
              <button type="button" className="btn small" disabled={blockReason !== null} title={blockReason ?? undefined} aria-description={blockReason ?? undefined} onClick={() => onChange({ kind: "password", role: view.summary.name })}>
                비밀번호 재설정
              </button>
            )}
            {onDrop && (
              <button type="button" className="btn small danger" disabled={dropOff !== null} title={dropOff ?? undefined} aria-description={dropOff ?? undefined} onClick={() => onDrop(view.summary.name)}>
                삭제
              </button>
            )}
          </span>
        )}
      </header>
      <div className="iam-tabs" role="tablist" aria-label="상세 항목">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab} className={`iam-tab${t.id === tab ? " on" : ""}`} onClick={() => openTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="iam-pane" role="tabpanel">
        {tab === "overview" && <Overview view={view} draft={edit} />}
        {tab === "members" && <Members view={view} onOpen={onOpen} draft={edit} roles={roles} />}
        {tab === "privileges" && <Privileges view={view} load={load} />}
        {tab === "owned" && <Databases view={view} load={load}>{(db) => <OwnedObjects db={db} />}</Databases>}
        {tab === "sessions" && <Sessions sessions={view.sessions} />}
      </div>
    </section>
  );
}

function Overview({ view, draft }: { view: PgRoleView; draft: GridDraft | null }) {
  const a = view.summary.attributes;
  const attributes: [string, string][] = [
    ["LOGIN", yesNo(a.login)],
    ["CREATEDB", yesNo(a.createDb)],
    ["CREATEROLE", yesNo(a.createRole)],
    ["INHERIT", yesNo(a.inherit)],
    ["REPLICATION", yesNo(a.replication)],
    ["BYPASSRLS", yesNo(a.bypassRls)],
    ["연결 수 제한", a.connectionLimit < 0 ? "제한 없음" : String(a.connectionLimit)],
    ["만료일", a.validUntil ? utcDay(a.validUntil) : "없음"],
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
      {draft && <AttributesForm key={JSON.stringify(attributesOf(view, queuedAttributes(draft, view.summary.name)))} view={view} draft={draft} />}
      <section aria-label="역할별 설정">
        <h3 className="pg-sect">역할별 설정</h3>
        {view.settings.length === 0 ? (
          <p className="dim">설정한 값이 없어요</p>
        ) : (
          <ul className="pg-settings" aria-label="역할별 설정">
            {view.settings.map((s) => (
              <li key={`${s.database}:${s.setting}:${s.allRoles}`}>
                <span className="dim">{s.database ?? "모든 데이터베이스"}</span>
                <code className="mono">{s.setting}</code>
                {s.allRoles && <span className="iam-chip">모든 역할</span>}
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

/**
 * 구성원 관계 하나의 표시: 상속하는지, 상속하지 않으면 SET ROLE로 쓸 수 있는지(PG16부터는 관계마다 SET 옵션이 있어서 둘 다 없을 수 있다)와 ADMIN OPTION.
 * 상속하면 SET 옵션이 있든 없든 권한은 쓰므로 "상속"이다.
 */
function Marks({ inherit, set, admin }: { inherit: boolean; set: boolean; admin: boolean }) {
  return (
    <>
      <span className={`iam-chip${inherit ? "" : " conditional"}`}>{inherit ? "상속" : set ? "SET ROLE로만 쓸 수 있음" : "상속·SET ROLE 없음"}</span>
      {admin && <span className="iam-chip">ADMIN OPTION</span>}
    </>
  );
}

function Members({ view, onOpen, draft, roles }: { view: PgRoleView; onOpen: (route: PgRoute) => void; draft: GridDraft | null; roles: PgRoleSummary[] }) {
  const groups = view.summary.memberOf.map((m) => ({ name: m.group, inherit: m.inherit, set: m.set, admin: m.admin }));
  const members = view.members.map((m) => ({ name: m.role, inherit: m.inherit, set: m.set, admin: m.admin }));
  const list = (label: string, items: typeof groups, empty: string, withAdmin = false) =>
    items.length === 0 ? (
      <div className="empty small">{empty}</div>
    ) : (
      <ul className="iam-names" aria-label={label}>
        {items.map((m) => (
          <li key={m.name}>
            <button className="link" onClick={() => onOpen(roleRoute(m.name))}>
              {m.name}
            </button>
            <Marks inherit={m.inherit} set={m.set} admin={m.admin} />
            {withAdmin && draft && <AdminOption draft={draft} group={m.name} member={view.summary.name} admin={m.admin} lock={view.summary.system ? systemRoleText(view.summary.name) : !groupAllowed(m.name, roles) ? systemGroupText(m.name) : null} />}
          </li>
        ))}
      </ul>
    );
  return (
    <div className="pg-members">
      <h3 className="pg-sect">속한 그룹</h3>
      {list("속한 그룹", groups, "속한 그룹이 없어요", true)}
      {draft && <GroupChecks view={view} draft={draft} roles={roles} />}
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
          {db.loaded && db.truncated && (
            <div className="notice" role="note">
              {TRUNCATED_TEXT}
            </div>
          )}
          {db.loaded ? (
            children(db)
          ) : load.requested.has(db.database) ? (
            <DatabaseStatus target={load.target} database={db.database} />
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
 * 데이터베이스 하나를 구독한다(화면에는 아무것도 그리지 않는다). 역할이 그 데이터베이스를 아직 읽지 않은 것으로 답하는 동안(waiting)에는
 * 읽기가 끝날 때마다 onRead로 역할을 다시 읽게 해서, 백엔드가 그 데이터베이스를 읽은 것으로 답하게 한다.
 * 끝난 읽기만 센다(isSuccess && !isFetching). 낡은 사본이 있는 쿼리는 다시 읽는 중에도 isSuccess라서, 그때 역할을 읽으면 아직 비어 있다.
 * 이미 읽은 데이터베이스(waiting이 아님)는 구독만 하고 알리지 않는다.
 */
function DatabaseWatch({ target, database, waiting, onRead }: { target: PgTarget; database: string; waiting: boolean; onRead: () => void }) {
  const db = usePgDatabase(target, database);
  const latest = useRef(onRead);
  latest.current = onRead;
  const finished = db.isSuccess && !db.isFetching;
  // 읽기 하나(그 읽기가 끝난 시각 dataUpdatedAt)에 한 번만 알린다. React의 strict mode가 효과를 두 번 돌려도,
  // 역할이 여전히 읽지 않은 것으로 답해도 되풀이하지 않고, 다음 읽기가 끝나면 다시 알린다.
  // 읽기가 너무 빨라 "읽는 중"이 화면에 그려지지 않아도 시각은 바뀐다.
  const told = useRef<number | null>(null);
  useEffect(() => {
    if (!finished || !waiting || told.current === db.dataUpdatedAt) return;
    told.current = db.dataUpdatedAt;
    latest.current();
  }, [finished, waiting, db.dataUpdatedAt]);
  return null;
}

/** [불러오기]를 누르고 기다리는 데이터베이스의 모습: 읽는 중이거나, 읽지 못한 까닭 */
function DatabaseStatus({ target, database }: { target: PgTarget; database: string }) {
  const db = usePgDatabase(target, database);
  if (db.isError) return <PgError error={db.error} target={target} />;
  return <div className="empty small">불러오는 중…</div>;
}

/** 칸에 권한이 하나라도 있는가. 백엔드가 빈 칸을 보내더라도 "없음"만 늘어놓은 줄은 보이지 않는다. */
const hasSomething = (c: PgSchemaCell) => c.usage || c.create || c.read !== "none" || c.write !== "none";

function SchemaPrivileges({ db }: { db: PgRoleDatabase }) {
  const cells = db.cells.filter(hasSomething).sort((a, b) => a.schema.localeCompare(b.schema));
  if (cells.length === 0) return <div className="empty small">이 데이터베이스에서 받은 권한이 없어요</div>;
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
            <td className="dim">{c.inheritedOnly ? INHERITED_ONLY_TEXT : "직접 받음·소유"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 소유 객체의 개수를 세는 묶음. 뷰, 구체화 뷰, 파티션 테이블, 외부 테이블은 테이블로 센다. */
const OWNED_COUNTS: { label: string; kinds: ReadonlySet<PgObjectKind> }[] = [
  { label: "스키마", kinds: new Set<PgObjectKind>(["schema"]) },
  { label: "테이블(뷰 포함)", kinds: new Set<PgObjectKind>(["table", "view", "matview", "partitioned", "foreign"]) },
  { label: "시퀀스", kinds: new Set<PgObjectKind>(["sequence"]) },
  { label: "함수", kinds: new Set<PgObjectKind>(["function"]) },
];

function OwnedObjects({ db }: { db: PgRoleDatabase }) {
  if (db.owned.length === 0 && db.ownedOmitted === 0) return <div className="empty small">소유한 객체가 없어요</div>;
  const counts = OWNED_COUNTS.map(({ label, kinds }) => `${label} ${db.owned.filter((o) => kinds.has(o.kind)).length}`).join(" · ");
  return (
    <>
      <p className="pg-counts">
        {counts}
        {db.ownedOmitted > 0 && <span className="dim"> (목록에 있는 객체만 센 수예요)</span>}
      </p>
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
  return <SessionTable sessions={sessions} />;
}

/** 그룹에서 빼기가 담긴 구성원 관계의 ADMIN OPTION은 바꿀 수 없다 */
const REMOVING_TEXT = "그룹에서 빼는 변경이 담겨 있어요. ADMIN OPTION을 바꾸려면 먼저 그 변경을 거둬 주세요";
const pendingText = (add: boolean) => (add ? "넣기 예정" : "빼기 예정");

/** 이 앱이 구성원을 넣고 뺄 수 있는 그룹인가: 시스템이 아닌 그룹과, 허용한 시스템 그룹. roles에 없는 역할은 알 수 없어 false다 */
function groupAllowed(name: string, roles: PgRoleSummary[]): boolean {
  const found = roles.find((r) => r.name === name);
  return !!found && (found.system ? MEMBERSHIP_SYSTEM_GROUPS.includes(name) : true);
}

/** 장바구니에 담긴 구성원 변경 하나(그룹·구성원 쌍과 ADMIN OPTION 여부로 찾는다) */
function queuedMembership(draft: GridDraft, group: string, member: string, admin: boolean) {
  for (const { change } of draft.items) {
    if (change.kind === "membership" && change.group === group && change.member === member && change.admin === admin) return change;
  }
  return undefined;
}

/**
 * 구성원 탭의 바꾸기: 넣을 수 있는 그룹마다 체크박스. 시스템이 아닌 그룹과 허용한 시스템 그룹이 나온다.
 * 체크박스는 담아 둔 변경까지 반영한 상태를 보이고(담아 둔 것은 "넣기 예정", "빼기 예정"), 누르면 담거나 거둔다.
 */
function GroupChecks({ view, draft, roles }: { view: PgRoleView; draft: GridDraft; roles: PgRoleSummary[] }) {
  const member = view.summary.name;
  const locked = view.summary.system;
  const groups = roles
    .filter((r) => r.name !== member && r.kind === "group" && (r.system ? MEMBERSHIP_SYSTEM_GROUPS.includes(r.name) : true))
    .sort((a, b) => collate(a.name, b.name));
  const now = new Set(view.summary.memberOf.map((m) => m.group));
  return (
    <fieldset className="pg-form-checks pg-group-checks" disabled={locked} title={locked ? systemRoleText(member) : undefined}>
      <legend>그룹에 넣기</legend>
      {groups.length === 0 && <span className="dim">넣을 수 있는 그룹이 없어요</span>}
      {groups.map((g) => {
        const queued = queuedMembership(draft, g.name, member, false);
        const checked = queued ? queued.add : now.has(g.name);
        return (
          <label key={g.name} className="pg-form-check">
            <input
              type="checkbox"
              checked={checked}
              onChange={() => {
                const change: PgChange = { kind: "membership", group: g.name, member, add: !checked, admin: false };
                if (queued) draft.remove(draftKey(change) ?? "");
                else draft.put(change);
              }}
            />{" "}
            {g.name}
            {queued && <span className="iam-chip conditional pg-pending">{pendingText(queued.add)}</span>}
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * 속한 그룹 한 줄의 ADMIN OPTION 체크박스. 담아 둔 변경이 있으면 그 뜻이 체크 상태가 된다.
 * 잠긴 까닭(lock)이 있으면 그 글이 제목이다. 그 그룹에서 빼기가 담겨 있으면 체크박스는 꺼 두고 담긴 빼기를 그대로 둔다(구성원 관계 하나에 변경은 하나라서, 켜면 빼기가 말없이 바뀐다).
 */
function AdminOption({ draft, group, member, admin, lock }: { draft: GridDraft; group: string; member: string; admin: boolean; lock: string | null }) {
  const queued = queuedMembership(draft, group, member, true);
  const removing = queuedMembership(draft, group, member, false)?.add === false;
  const checked = queued ? queued.add : admin;
  const title = lock ?? (removing ? REMOVING_TEXT : undefined);
  return (
    <label className="pg-form-check pg-admin-option" title={title}>
      <input
        type="checkbox"
        disabled={!!title}
        checked={checked}
        onChange={() => {
          if (title) return;
          const change: PgChange = { kind: "membership", group, member, add: !checked, admin: true };
          if (queued) draft.remove(draftKey(change) ?? "");
          else draft.put(change);
        }}
      />{" "}
      ADMIN OPTION
      {queued && <span className="iam-chip conditional pg-pending">{pendingText(queued.add)}</span>}
    </label>
  );
}

/** 역할의 지금 속성에서 폼의 바탕 값을 만든다. 담아 둔 속성 변경이 있으면 그 값이 먼저다 */
function attributesOf(view: PgRoleView, queued: PgAttributesSet | undefined): PgAttributesSet {
  if (queued) return queued;
  const a = view.summary.attributes;
  return { login: a.login, createDb: a.createDb, createRole: a.createRole, inherit: a.inherit, connectionLimit: a.connectionLimit, validUntil: a.validUntil };
}

const FLAGS: { key: "login" | "createDb" | "createRole" | "inherit"; label: string }[] = [
  { key: "login", label: "LOGIN" },
  { key: "createDb", label: "CREATEDB" },
  { key: "createRole", label: "CREATEROLE" },
  { key: "inherit", label: "INHERIT" },
];

/** 장바구니에 담긴 이 역할의 속성 변경이 바라는 속성 */
function queuedAttributes(draft: GridDraft, role: string): PgAttributesSet | undefined {
  for (const { change } of draft.items) if (change.kind === "attributes" && change.role === role) return change.set;
  return undefined;
}

/**
 * 개요 탭의 바꾸기: LOGIN, CREATEDB, CREATEROLE, INHERIT, 연결 수 제한, 만료일. [담기]는 이 역할의 속성 변경 하나를 담거나 이미 담긴 것을 바꾼다.
 * REPLICATION과 BYPASSRLS는 위의 목록에서 읽기만 한다. 만료일을 건드리지 않으면 지금 값 그대로 보낸다(날짜만 보이는 값을 다시 쓰지 않는다).
 */
function AttributesForm({ view, draft }: { view: PgRoleView; draft: GridDraft }) {
  const role = view.summary.name;
  const locked = view.summary.system;
  const queued = queuedAttributes(draft, role);
  const start = attributesOf(view, queued);
  const [flags, setFlags] = useState({ login: start.login, createDb: start.createDb, createRole: start.createRole, inherit: start.inherit });
  const [unlimited, setUnlimited] = useState(start.connectionLimit < 0);
  const [limit, setLimit] = useState(start.connectionLimit < 0 ? "" : String(start.connectionLimit));
  const [noExpiry, setNoExpiry] = useState(start.validUntil === null);
  const [day, setDay] = useState(start.validUntil ? utcDay(start.validUntil) : "");

  const limitValue = unlimited ? -1 : /^\d+$/.test(limit.trim()) ? Number(limit.trim()) : null;
  const expiryValue = noExpiry ? null : /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
  const valid = limitValue !== null && expiryValue !== undefined;
  const nowExpiry = view.summary.attributes.validUntil;
  const set: PgAttributesSet | null = valid
    ? { ...flags, connectionLimit: limitValue, validUntil: expiryValue === null ? null : nowExpiry && utcDay(nowExpiry) === expiryValue ? nowExpiry : dayToIso(expiryValue) }
    : null;
  const flagId = (key: string) => `${role}-attr-${key}`;

  return (
    <fieldset className="pg-attr-form" disabled={locked} title={locked ? systemRoleText(role) : undefined}>
      <legend>속성 바꾸기{queued && <span className="iam-chip conditional pg-pending">담김</span>}</legend>
      <div className="pg-form-checks">
        {FLAGS.map(({ key, label }) => (
          <label key={key} className="pg-form-check" htmlFor={flagId(key)}>
            <input id={flagId(key)} type="checkbox" checked={flags[key]} onChange={(e) => setFlags({ ...flags, [key]: e.target.checked })} /> {label}
          </label>
        ))}
      </div>
      <div className="pg-attr-row">
        <label htmlFor={flagId("limit")}>연결 수 제한</label>
        <input id={flagId("limit")} type="number" min={0} step={1} value={limit} disabled={unlimited} onChange={(e) => setLimit(e.target.value)} />
        <label className="pg-form-check">
          <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} /> 제한 없음
        </label>
      </div>
      <div className="pg-attr-row">
        <label htmlFor={flagId("until")}>만료일</label>
        <input id={flagId("until")} type="date" value={day} disabled={noExpiry} onChange={(e) => setDay(e.target.value)} />
        <label className="pg-form-check">
          <input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} /> 없음
        </label>
      </div>
      <div className="foot">
        <button
          type="button"
          className="btn primary"
          disabled={!set}
          onClick={() => {
            if (set) draft.put({ kind: "attributes", role, set });
          }}
        >
          담기
        </button>
      </div>
    </fieldset>
  );
}
