import { useMemo, useState } from "react";
import { DefaultPrivilegeForm } from "./DefaultPrivilegeForm";
import { DatabaseScreen } from "./DatabaseScreen";
import { PgError } from "./PgError";
import { putChange } from "./putChange";
import { usePgDatabase } from "./queries";
import { ALL_SCHEMAS, BUILTIN_NOTE, DEFAULT_OBJECT_LABEL, DEFAULT_OBJECT_ORDER, GRANT_OPTION_NOTE, defaultPrivilegeSentence, granteeLabel, noGrantSentence } from "./sentences";
import { draftKey } from "./draft";
import type { PgChange, PgDefaultAclRow, PgDefaultObjectType, PgOverview, PgTarget } from "./types";
import type { GridDraft } from "./useChangeMode";

type Grants = PgDefaultAclRow["grants"];

/** 같은 (만드는 역할, 스키마)의 기본 권한들. 표의 행 하나다. */
interface Group {
  creator: string;
  schema: string | null;
  grants: Map<PgDefaultObjectType, Grants>;
}

/** 백엔드가 보낸 순서(처음 나온 순서)를 지키면서 같은 (만드는 역할, 스키마)를 한 행으로 묶는다 */
function groupRows(rows: PgDefaultAclRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const key = JSON.stringify([row.creator, row.schema]);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { creator: row.creator, schema: row.schema, grants: new Map() }));
    group.grants.set(row.objectType, [...(group.grants.get(row.objectType) ?? []), ...row.grants]);
  }
  return [...groups.values()];
}

interface Props {
  target: PgTarget;
  overview: PgOverview;
  /** 이 탭에서 고른 데이터베이스(PgTab이 들고 있다). 없거나 연결할 수 없으면 대상의 기본 데이터베이스 */
  database: string | undefined;
  onDatabase: (database: string) => void;
  /** 바꾸기 모드(탭이 든다). 켜면 줄마다 [빼기]가 붙고 [기본 권한 추가]가 보인다. 장바구니(draft)가 있어야 켜진다 */
  editing?: boolean;
  draft?: GridDraft;
}

/** 바꾸기 모드에서 이 화면이 쓰는 것 */
interface Edit {
  draft: GridDraft;
  overview: PgOverview;
}

/**
 * 기본 권한(데이터베이스 하나): 앞으로 만들 객체가 받을 권한(ALTER DEFAULT PRIVILEGES).
 * 행은 (만드는 역할, 스키마 또는 모든 스키마), 열은 객체 종류이고, 각 행 아래에 받는 역할마다 문장으로 풀어 쓴다.
 * 표에 없는 PostgreSQL의 기본값은 표 위에 안내한다.
 */
export function DefaultPrivileges({ target, overview, database, onDatabase, editing = false, draft }: Props) {
  const edit = editing && draft ? { draft, overview } : null;
  return (
    <DatabaseScreen overview={overview} database={database} onDatabase={onDatabase}>
      {(db) => <DatabaseDefaults target={target} database={db} edit={edit} />}
    </DatabaseScreen>
  );
}

function DatabaseDefaults({ target, database, edit }: { target: PgTarget; database: string; edit: Edit | null }) {
  const [adding, setAdding] = useState(false);
  const q = usePgDatabase(target, database);
  const view = q.data;
  const groups = useMemo(() => groupRows(view?.defaultPrivileges ?? []), [view]);

  if (!view) return q.isError ? <PgError error={q.error} target={target} /> : <div className="empty">불러오는 중…</div>;

  return (
    <>
      {q.isError && <PgError compact error={q.error} target={target} />}
      <p className="iam-hint pg-builtin">{BUILTIN_NOTE}</p>
      {edit && (
        <div className="pg-def-act">
          <button type="button" className="btn small" onClick={() => setAdding(true)}>
            기본 권한 추가
          </button>
        </div>
      )}
      {adding && edit && (
        <DefaultPrivilegeForm
          database={database}
          creators={edit.overview.roles.filter((r) => !r.system).map((r) => r.name)}
          grantees={edit.overview.roles.filter((r) => !r.system).map((r) => r.name)}
          schemas={view.schemas.map((s) => s.name)}
          draft={edit.draft}
          onClose={() => setAdding(false)}
        />
      )}
      {groups.length === 0 ? (
        <div className="empty small">설정한 기본 권한이 없어요</div>
      ) : (
        <div className="pg-def-scroll">
          <table className="pg-defaults" aria-label="기본 권한">
            <thead>
              <tr>
                <th scope="col" className="nosort">
                  만드는 역할 · 스키마
                </th>
                {DEFAULT_OBJECT_ORDER.map((type) => (
                  <th key={type} scope="col" className="nosort">
                    {DEFAULT_OBJECT_LABEL[type]}
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((group) => (
              <GroupRows key={JSON.stringify([group.creator, group.schema])} group={group} database={database} edit={edit} />
            ))}
          </table>
        </div>
      )}
    </>
  );
}

/** 표의 한 행과 그 아래의 문장들 */
function GroupRows({ group, database, edit }: { group: Group; database: string; edit: Edit | null }) {
  const where = group.schema ?? ALL_SCHEMAS;
  // 설정한 적 없는 종류(grants에 없다)는 말하지 않는다. 설정은 했는데 받는 역할이 없는 종류는 아무도 받지 않는다고 말한다.
  const sentences = DEFAULT_OBJECT_ORDER.flatMap((objectType) => {
    const grants = group.grants.get(objectType);
    const row = { creator: group.creator, schema: group.schema, objectType };
    if (grants === undefined) return [];
    return grants.length === 0 ? [noGrantSentence(row)] : grants.map((grant) => defaultPrivilegeSentence(row, grant));
  });
  return (
    <tbody className="pg-def-group">
      <tr>
        <th scope="row" className="pg-def-who">
          <b>{group.creator}</b> · {where}
        </th>
        {DEFAULT_OBJECT_ORDER.map((type) => {
          const grants = group.grants.get(type);
          return (
            <td key={type}>
              {grants === undefined ? null : grants.length === 0 ? (
                <span className="dim">없음</span>
              ) : (
                <ul className="pg-grants">
                  {grants.map((g, i) => (
                    <li key={`${g.grantee}:${i}`}>
                      <span className="pg-grantee">{granteeLabel(g.grantee)}</span> <span className="mono">{g.privileges.join(", ")}</span>
                      {g.grantable && <span className="dim">{GRANT_OPTION_NOTE}</span>}
                      {edit && <RevokeLine draft={edit.draft} change={revokeOf(database, group, type, g)} />}
                    </li>
                  ))}
                </ul>
              )}
            </td>
          );
        })}
      </tr>
      <tr className="pg-sentences">
        <td colSpan={DEFAULT_OBJECT_ORDER.length + 1}>
          <ul aria-label={`${group.creator} · ${where} 문장`}>
            {sentences.map((sentence, i) => (
              <li key={i}>{sentence}</li>
            ))}
          </ul>
        </td>
      </tr>
    </tbody>
  );
}

/** 기본 권한 한 줄을 빼는 변경 */
const revokeOf = (database: string, group: Group, objectType: PgDefaultObjectType, grant: Grants[number]): PgChange => ({
  kind: "defaultPrivilege",
  database,
  creator: group.creator,
  schema: group.schema,
  objectType,
  grantee: grant.grantee,
  privileges: grant.privileges,
  add: false,
});

/** 줄의 [빼기]. 담아 둔 뺄 변경이 있으면 눌린 모양이고, 다시 누르면 거둔다 */
function RevokeLine({ draft, change }: { draft: GridDraft; change: PgChange }) {
  const key = draftKey(change);
  const queued = draft.items.find((d) => d.key === key);
  const pressed = !!queued && queued.change.kind === "defaultPrivilege" && !queued.change.add;
  return (
    <button
      type="button"
      className={`link pg-revoke${pressed ? " on" : ""}`}
      aria-pressed={pressed}
      onClick={() => {
        if (pressed && key !== null) draft.remove(key);
        else putChange(draft, change);
      }}
    >
      빼기
    </button>
  );
}
