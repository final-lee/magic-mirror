import { useMemo } from "react";
import { DatabasePicker, pickDatabase } from "./DatabasePicker";
import { PgError } from "./PgError";
import { usePgDatabase } from "./queries";
import { ALL_SCHEMAS, BUILTIN_NOTE, DEFAULT_OBJECT_LABEL, DEFAULT_OBJECT_ORDER, defaultPrivilegeSentence, granteeLabel } from "./sentences";
import type { PgDefaultAclRow, PgDefaultObjectType, PgOverview, PgTarget } from "./types";

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
  /** 경로에 기억된 데이터베이스 선택. 없거나 연결할 수 없으면 대상의 기본 데이터베이스 */
  database: string | undefined;
  onDatabase: (database: string) => void;
}

/**
 * 기본 권한(데이터베이스 하나): 앞으로 만들 객체가 받을 권한(ALTER DEFAULT PRIVILEGES).
 * 행은 (만드는 역할, 스키마 또는 모든 스키마), 열은 객체 종류이고, 각 행 아래에 받는 역할마다 문장으로 풀어 쓴다.
 * 표에 없는 PostgreSQL의 기본값은 표 위에 안내한다.
 */
export function DefaultPrivileges({ target, overview, database, onDatabase }: Props) {
  const db = pickDatabase(overview.databases, database, overview.target.defaultDatabase);
  return (
    <section className="center pg-screen">
      <div className="pg-bar">{db !== null && <DatabasePicker databases={overview.databases} value={db} onChange={onDatabase} />}</div>
      {db === null ? <div className="empty small">연결할 수 있는 데이터베이스가 없어요</div> : <DatabaseDefaults key={db} target={target} database={db} />}
    </section>
  );
}

function DatabaseDefaults({ target, database }: { target: PgTarget; database: string }) {
  const q = usePgDatabase(target, database);
  const view = q.data;
  const groups = useMemo(() => groupRows(view?.defaultPrivileges ?? []), [view]);

  if (!view) return q.isError ? <PgError error={q.error} target={target} /> : <div className="empty">불러오는 중…</div>;

  return (
    <>
      {q.isError && <PgError compact error={q.error} target={target} />}
      <p className="iam-hint pg-builtin">{BUILTIN_NOTE}</p>
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
              <GroupRows key={JSON.stringify([group.creator, group.schema])} group={group} />
            ))}
          </table>
        </div>
      )}
    </>
  );
}

/** 표의 한 행과 그 아래의 문장들 */
function GroupRows({ group }: { group: Group }) {
  const where = group.schema ?? ALL_SCHEMAS;
  const sentences = DEFAULT_OBJECT_ORDER.flatMap((objectType) =>
    (group.grants.get(objectType) ?? []).map((grant) => defaultPrivilegeSentence({ creator: group.creator, schema: group.schema, objectType }, grant)),
  );
  return (
    <tbody className="pg-def-group">
      <tr>
        <th scope="row" className="pg-def-who">
          <b>{group.creator}</b> · {where}
        </th>
        {DEFAULT_OBJECT_ORDER.map((type) => {
          const grants = group.grants.get(type) ?? [];
          return (
            <td key={type}>
              {grants.length > 0 && (
                <ul className="pg-grants">
                  {grants.map((g, i) => (
                    <li key={`${g.grantee}:${i}`}>
                      <span className="pg-grantee">{granteeLabel(g.grantee)}</span> <span className="mono">{g.privileges.join(", ")}</span>
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
