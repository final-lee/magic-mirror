import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PickerSheet, type PickerOption } from "../iam/PickerSheet";
import { useDebounced } from "../lib/useDebounced";
import { DatabaseScreen } from "./DatabaseScreen";
import { OBJECT_KIND_LABEL, ROLE_KIND_LABEL, collate, objectName } from "./labels";
import { PgError } from "./PgError";
import { usePgObjects, usePgWhoCan } from "./queries";
import { RoleKinds, roleShown, type RoleKindsValue } from "./RoleKinds";
import { reasonPath } from "./sentences";
import type { PgObjectKind, PgObjectRef, PgOverview, PgRoleKind, PgTarget, PgWhoCanRow } from "./types";

/** 객체 검색에서 입력이 멈추고 이만큼(ms) 지나면 읽는다 */
export const SEARCH_DELAY_MS = 250;
/** pg_objects가 한 번에 돌려주는 가장 많은 개수. 이만큼 왔으면 더 있을 수 있다. */
const MAX_FOUND = 100;

const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/** 객체 종류마다 물어볼 수 있는 권한. 객체를 고르면 첫 번째 권한이 먼저 골라진다. */
export const OBJECT_PRIVILEGES: Record<PgObjectKind, string[]> = {
  database: ["CONNECT", "CREATE", "TEMPORARY"],
  schema: ["USAGE", "CREATE"],
  table: TABLE_PRIVILEGES,
  view: TABLE_PRIVILEGES,
  matview: TABLE_PRIVILEGES,
  partitioned: TABLE_PRIVILEGES,
  foreign: TABLE_PRIVILEGES,
  sequence: ["USAGE", "SELECT", "UPDATE"],
  function: ["EXECUTE"],
};

interface Props {
  target: PgTarget;
  overview: PgOverview;
  /** 이 탭에서 고른 데이터베이스(PgTab이 들고 있다). 없거나 연결할 수 없으면 대상의 기본 데이터베이스 */
  database: string | undefined;
  onDatabase: (database: string) => void;
  /** 종류 칩과 시스템 역할 토글의 상태. 역할 목록, 권한 표와 같은 것을 쓴다(탭이 들고 있다) */
  kinds: RoleKindsValue;
  onKinds: (next: RoleKindsValue) => void;
}

/**
 * 누가 할 수 있나(데이터베이스 하나): 객체와 권한을 고르면 그 권한을 가진 역할을 이유 경로와 함께 보인다.
 * 객체는 이름의 일부로 찾아 고르고(PickerSheet), 사용자 먼저, 그다음 그룹이다. 시스템 역할은 [시스템 역할 보기]를 켜야 보인다.
 * 데이터베이스가 바뀌면 고른 객체는 사라진다(객체는 데이터베이스의 것이다).
 */
export function WhoCan({ target, overview, database, onDatabase, kinds, onKinds }: Props) {
  return (
    <DatabaseScreen overview={overview} database={database} onDatabase={onDatabase} bar={<RoleKinds value={kinds} onChange={onKinds} />}>
      {(db) => <DatabaseWhoCan target={target} database={db} kinds={kinds} />}
    </DatabaseScreen>
  );
}

function DatabaseWhoCan({ target, database, kinds }: { target: PgTarget; database: string; kinds: RoleKindsValue }) {
  const [object, setObject] = useState<PgObjectRef | null>(null);
  const [privilege, setPrivilege] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const groupName = useId();
  const q = usePgWhoCan(target, database, object, privilege);

  // 검색 창이 닫히면(고르든 취소하든) 초점을 창을 연 버튼으로 돌려 준다
  const wasPicking = useRef(false);
  useEffect(() => {
    if (wasPicking.current && !picking) opener.current?.focus();
    wasPicking.current = picking;
  }, [picking]);

  const choose = (next: PgObjectRef) => {
    const list = OBJECT_PRIVILEGES[next.kind];
    setObject(next);
    // 고르던 권한을 새 객체도 가지고 있으면 그대로 두고, 없으면 그 종류의 첫 권한부터 시작한다
    setPrivilege((current) => (current !== null && list.includes(current) ? current : list[0]));
    setPicking(false);
  };

  let result: ReactNode;
  if (!object || !privilege) {
    result = <div className="empty small">객체를 고르면 그 객체에 권한을 가진 사용자와 그룹을 찾아요</div>;
  } else if (!q.data) {
    result = q.isError ? <PgError error={q.error} target={target} /> : <div className="empty small">찾는 중…</div>;
  } else {
    result = (
      <>
        {q.isError && <PgError compact error={q.error} target={target} />}
        <Allowed rows={q.data.allowed} kinds={kinds} />
      </>
    );
  }

  return (
    <>
      <div className="wc-form" role="search" aria-label="누가 할 수 있나 검색">
        <div className="wc-field">
          <span className="wc-label" aria-hidden="true">
            객체
          </span>
          <button type="button" ref={opener} className="btn small pg-pick" aria-haspopup="dialog" onClick={() => setPicking(true)}>
            {object ? (
              <>
                <span className="mono">{objectName(object)}</span> <span className="dim">{OBJECT_KIND_LABEL[object.kind]}</span>
              </>
            ) : (
              "객체 고르기"
            )}
          </button>
        </div>
        {object && privilege && (
          <div className="wc-field">
            <span className="wc-label" aria-hidden="true">
              권한
            </span>
            <div className="pg-chips" role="radiogroup" aria-label="권한">
              {OBJECT_PRIVILEGES[object.kind].map((name) => (
                <label key={name} className={`pg-chip${name === privilege ? " on" : ""}`}>
                  <input type="radio" name={groupName} checked={name === privilege} onChange={() => setPrivilege(name)} /> {name}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="pg-pane">{result}</div>
      {picking && <ObjectPicker target={target} database={database} onPick={choose} onClose={() => setPicking(false)} />}
    </>
  );
}

/** 객체를 하나로 가리키는 키(같은 이름의 함수도 인자가 다르면 다른 객체다) */
const objectKey = (o: PgObjectRef) => JSON.stringify([o.kind, o.schema, o.name, o.signature]);

interface PickerProps {
  target: PgTarget;
  database: string;
  onPick: (object: PgObjectRef) => void;
  onClose: () => void;
}

/** 객체 검색 창. 입력이 멈추면(SEARCH_DELAY_MS) 데이터베이스에서 이름의 일부로 찾는다. 입력하는 동안에는 이전 목록이 그대로 남는다. */
function ObjectPicker({ target, database, onPick, onClose }: PickerProps) {
  const [query, setQuery] = useState("");
  const text = useDebounced(query.trim(), SEARCH_DELAY_MS);
  const q = usePgObjects(target, database, text);
  const found = q.data ?? [];
  const options: PickerOption[] = found.map((o) => ({
    id: objectKey(o),
    name: objectName(o),
    meta: <span className="iam-chip">{OBJECT_KIND_LABEL[o.kind]}</span>,
  }));
  // 첫 목록이 올 때까지의 상태. 한 번 목록이 있으면 새 검색을 기다리는 동안에도 그 목록을 보인다.
  const status = q.data ? undefined : q.isError ? <PgError error={q.error} target={target} /> : <div className="empty small">찾는 중…</div>;

  return (
    <PickerSheet
      title="객체 고르기"
      intro={`${database} 데이터베이스에서 찾아요. 이름의 일부를 입력하세요(예: app.orders)`}
      searchLabel="객체 검색"
      placeholder="이름으로 찾기"
      query={query}
      onQuery={setQuery}
      options={options}
      onPick={(id) => {
        const picked = found.find((o) => objectKey(o) === id);
        if (picked) onPick(picked);
      }}
      onClose={onClose}
      status={status}
      empty="조건에 맞는 객체가 없어요"
      footnote={found.length >= MAX_FOUND ? `결과가 많아 처음 ${MAX_FOUND}개만 보여요. 이름을 더 입력해 좁혀 보세요` : undefined}
    />
  );
}

/** 찾은 역할들. 칩과 시스템 역할 토글을 지난 것만 보이고, 실제로는 못 쓰는 역할은 따로 묶는다. */
function Allowed({ rows, kinds }: { rows: PgWhoCanRow[]; kinds: RoleKindsValue }) {
  const headingId = useId();
  const shown = rows.filter((r) => roleShown(r, kinds));
  if (shown.length === 0) return <div className="empty small">{rows.length === 0 ? "이 권한을 가진 역할이 없어요" : "조건에 맞는 역할이 없어요"}</div>;
  const usable = shown.filter((r) => r.unusable === null);
  const unusable = shown.filter((r) => r.unusable !== null);
  return (
    <>
      {usable.length > 0 ? <RoleTable label="할 수 있는 역할" rows={usable} /> : <div className="empty small">실제로 쓸 수 있는 역할이 없어요</div>}
      {unusable.length > 0 && (
        <section aria-labelledby={headingId}>
          <h3 id={headingId} className="pg-who-apart">
            권한은 있지만 실제로는 못 써요
          </h3>
          <RoleTable label="못 쓰는 역할" rows={unusable} />
        </section>
      )}
    </>
  );
}

const KIND_ORDER: PgRoleKind[] = ["user", "group"];

/** 역할마다 한 줄: 이름(못 쓰는 까닭이 있으면 함께)과 이유 경로들. 사용자 먼저, 그다음 그룹이고 이름순이다. */
function RoleTable({ label, rows }: { label: string; rows: PgWhoCanRow[] }) {
  return (
    <table className="pg-who" aria-label={label}>
      <thead>
        <tr>
          <th scope="col" className="nosort">
            역할
          </th>
          <th scope="col" className="nosort">
            이유
          </th>
        </tr>
      </thead>
      {KIND_ORDER.map((kind) => {
        const ofKind = rows.filter((r) => r.kind === kind).sort((a, b) => collate(a.role, b.role));
        if (ofKind.length === 0) return null;
        return (
          <tbody key={kind}>
            <tr className="pg-who-kind">
              <th scope="rowgroup" colSpan={2}>
                {ROLE_KIND_LABEL[kind]} <span className="dim">{ofKind.length}</span>
              </th>
            </tr>
            {ofKind.map((row) => (
              <tr key={row.role}>
                <th scope="row">
                  {row.role}
                  {row.unusable && <span className="iam-chip conditional pg-who-why">{row.unusable}</span>}
                </th>
                <td>
                  <ul className="pg-reasons" aria-label={`${row.role} 이유`}>
                    {row.sources.map((source, i) => (
                      <li key={i}>{reasonPath(row.role, source)}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        );
      })}
    </table>
  );
}
