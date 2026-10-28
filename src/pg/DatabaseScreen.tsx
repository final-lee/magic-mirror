import { Fragment, type ReactNode } from "react";
import { DatabasePicker, pickDatabase } from "./DatabasePicker";
import type { PgOverview } from "./types";

interface Props {
  overview: PgOverview;
  /** 이 탭에서 고른 데이터베이스(PgTab이 들고 있다). 아직 안 골랐거나 연결할 수 없게 됐으면 대상의 기본 데이터베이스를 쓴다 */
  database: string | undefined;
  onDatabase: (database: string) => void;
  /** 데이터베이스 선택 옆에 놓을 것(권한 표의 종류 칩 …). 연결할 수 있는 데이터베이스가 없어도 보인다 */
  bar?: ReactNode;
  /** 보여 줄 데이터베이스의 화면 본문 */
  children: (database: string) => ReactNode;
}

/**
 * 데이터베이스 하나를 고르는 화면(권한 표, 기본 권한, 누가 할 수 있나)이 함께 쓰는 틀.
 * 보여 줄 데이터베이스를 정하고(pickDatabase), 위쪽 줄에 선택을 놓고(연결할 수 있는 데이터베이스가 없으면 그렇다고 알린다),
 * 본문을 데이터베이스를 키로 그린다. 데이터베이스가 바뀌면 본문은 상태(고른 칸 …)를 버리고 처음부터 다시 시작한다.
 */
export function DatabaseScreen({ overview, database, onDatabase, bar, children }: Props) {
  const db = pickDatabase(overview.databases, database, overview.target.defaultDatabase);
  return (
    <section className="center pg-screen">
      <div className="pg-bar">
        {db !== null && <DatabasePicker databases={overview.databases} value={db} onChange={onDatabase} />}
        {bar}
      </div>
      {db === null ? <div className="empty small">연결할 수 있는 데이터베이스가 없어요</div> : <Fragment key={db}>{children(db)}</Fragment>}
    </section>
  );
}
