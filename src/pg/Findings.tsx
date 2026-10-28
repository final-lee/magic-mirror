import { useMemo } from "react";
import { DASH, objectName } from "./labels";
import { PgError } from "./PgError";
import { usePgFindings } from "./queries";
import type { SchemaFocus } from "./route";
import type { PgFinding, PgFindingGroup, PgObjectRef, PgOverview, PgTarget } from "./types";

/** 점검이 보지 못하는 것. 화면 맨 아래에 늘 밝힌다. */
export const FINDINGS_FOOTNOTE = "역할별 비밀번호 해시 방식과 마지막 로그인은 RDS에서 볼 수 없어 점검하지 않아요";

type Level = PgFindingGroup["level"];

/** 높음, 중간, 낮음을 IAM 점검과 같은 말로 쓴다 */
const LEVEL_TEXT: Record<Level, string> = { high: "위험", medium: "주의", low: "참고" };
/** 배지의 색 이름(.iam-badge). 역할 배지와 같은 모양이다 */
const LEVEL_LOOK: Record<Level, string> = { high: "danger", medium: "warn", low: "info" };
const LEVEL_RANK: Record<Level, number> = { high: 0, medium: 1, low: 2 };

/** 항목의 객체가 속한 스키마. 스키마는 자기 자신이고, 데이터베이스는 스키마에 속하지 않는다. */
const schemaOf = (o: PgObjectRef): string | null => (o.kind === "schema" ? o.name : o.kind === "database" ? null : o.schema);

interface Props {
  target: PgTarget;
  /** 항목이 가리키는 역할과 데이터베이스가 지금 있는지 보는 데 쓴다(없으면 누를 수 있는 이름이 아니라 글로만 보인다) */
  overview: PgOverview;
  /** 역할 이름을 누르면: 그 역할의 상세를 연다 */
  onOpenRole: (role: string) => void;
  /** 객체 이름을 누르면: 그 데이터베이스의 권한 표를 그 스키마(와 역할)를 고른 채로 연다 */
  onOpenSchema: (to: SchemaFocus) => void;
}

/**
 * 점검: 읽을 수 있는 모든 데이터베이스를 읽어 찾은 보안 문제를 심각도 높은 순으로 묶어 보인다.
 * 항목의 역할은 역할 상세로, 객체는 권한 표로 이어진다. 읽지 못한 데이터베이스는 이유와 함께 알리고, 점검이 보지 못하는 것은 맨 아래에 밝힌다.
 * 이 화면이 열려 있을 때만 읽는다(PgTab이 같은 쿼리로 메뉴의 건수를 가져간다).
 */
export function Findings({ target, overview, onOpenRole, onOpenSchema }: Props) {
  const q = usePgFindings(target, true);
  const data = q.data;
  // 백엔드가 이미 심각도 순으로 주지만, 순서를 믿지 않고 한 번 더 맞춘다. 같은 수준 안에서는 받은 순서 그대로다.
  const groups = useMemo(() => [...(data?.groups ?? [])].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]), [data]);

  if (!data) {
    return <section className="center">{q.isError ? <PgError error={q.error} target={target} /> : <div className="empty">점검하는 중…</div>}</section>;
  }

  return (
    <section className="center fx">
      {q.isError && <PgError compact error={q.error} target={target} />}
      {groups.length === 0 ? (
        <div className="empty small">발견된 문제가 없어요</div>
      ) : (
        groups.map((group) => <Group key={group.kind} group={group} overview={overview} onOpenRole={onOpenRole} onOpenSchema={onOpenSchema} />)
      )}
      {data.skipped.length > 0 && <Skipped skipped={data.skipped} />}
      <p className="pg-footnote">{FINDINGS_FOOTNOTE}</p>
    </section>
  );
}

type GroupProps = { group: PgFindingGroup } & Pick<Props, "overview" | "onOpenRole" | "onOpenSchema">;

function Group({ group, overview, onOpenRole, onOpenSchema }: GroupProps) {
  return (
    <div className="fx-items pg-fx">
      <h3 className="fx-items-title">
        {group.title} <span className={`iam-badge ${LEVEL_LOOK[group.level]}`}>{LEVEL_TEXT[group.level]}</span> <span className="dim">{group.items.length}건</span>
      </h3>
      <table aria-label={group.title}>
        <thead>
          <tr>
            <th scope="col" className="nosort">
              대상
            </th>
            <th scope="col" className="nosort">
              내용
            </th>
          </tr>
        </thead>
        <tbody>
          {group.items.map((item, i) => (
            <tr key={i}>
              <td>
                <Target item={item} overview={overview} onOpenRole={onOpenRole} onOpenSchema={onOpenSchema} />
              </td>
              <td>{item.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type TargetProps = { item: PgFinding } & Pick<Props, "overview" | "onOpenRole" | "onOpenSchema">;

/**
 * 항목이 가리키는 곳. 역할이 있으면 역할 이름(클러스터에 그 역할이 있으면 상세로 가는 링크)이고,
 * 객체가 있으면 데이터베이스와 객체 이름(연결할 수 있는 데이터베이스의 것이면 권한 표로 가는 링크)이다. 아무것도 없으면 줄표다.
 */
function Target({ item, overview, onOpenRole, onOpenSchema }: TargetProps) {
  const { database, role, object } = item;
  const roleKnown = role !== null && overview.roles.some((r) => r.name === role);
  const connectable = database !== null && overview.databases.some((d) => d.name === database && d.allowConn);
  if (role === null && object === null) return database !== null ? <span>{database}</span> : <span className="dim">{DASH}</span>;
  return (
    <>
      {role !== null && (
        <div>
          {roleKnown ? (
            <button className="link" onClick={() => onOpenRole(role)}>
              {role}
            </button>
          ) : (
            role
          )}
        </div>
      )}
      {object !== null && (
        <div className="pg-fx-obj">
          {database !== null && <span className="dim">{database}</span>}
          {connectable ? (
            <button className="link" onClick={() => onOpenSchema({ database, schema: schemaOf(object), role: roleKnown ? role : null })}>
              {objectName(object)}
            </button>
          ) : (
            <span className="mono">{objectName(object)}</span>
          )}
        </div>
      )}
    </>
  );
}

/** 읽지 못해서 점검에서 빠진 데이터베이스와 그 이유 */
function Skipped({ skipped }: { skipped: { database: string; reason: string }[] }) {
  return (
    <div className="fx-items pg-fx">
      <h3 className="fx-items-title">
        점검하지 못한 데이터베이스 <span className="dim">{skipped.length}</span>
      </h3>
      <table aria-label="점검하지 못한 데이터베이스">
        <thead>
          <tr>
            <th scope="col" className="nosort">
              데이터베이스
            </th>
            <th scope="col" className="nosort">
              이유
            </th>
          </tr>
        </thead>
        <tbody>
          {skipped.map((s) => (
            <tr key={s.database}>
              <td className="mono">{s.database}</td>
              <td>{s.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
