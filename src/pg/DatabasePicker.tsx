import type { PgDatabaseInfo } from "./types";

/**
 * 화면이 보여 줄 데이터베이스. 기억해 둔 선택(경로의 database)이 연결할 수 있으면 그것, 아니면 대상의 기본 데이터베이스,
 * 그것도 연결할 수 없으면 연결할 수 있는 첫 데이터베이스다. 연결할 수 있는 데이터베이스가 없으면 null.
 * 권한 표, 기본 권한, 누가 할 수 있나가 함께 쓴다.
 */
export function pickDatabase(databases: PgDatabaseInfo[], remembered: string | undefined, defaultDatabase: string): string | null {
  const open = databases.filter((d) => d.allowConn).map((d) => d.name);
  if (remembered !== undefined && open.includes(remembered)) return remembered;
  if (open.includes(defaultDatabase)) return defaultDatabase;
  return open[0] ?? null;
}

interface Props {
  /** 클러스터의 모든 데이터베이스. 연결할 수 있는 것만 고를 수 있게 보인다. */
  databases: PgDatabaseInfo[];
  value: string;
  onChange: (database: string) => void;
}

/** 데이터베이스 선택. 연결할 수 없는 데이터베이스(datallowconn=false)는 목록에 넣지 않는다. */
export function DatabasePicker({ databases, value, onChange }: Props) {
  return (
    <label className="sel pg-picker">
      <small>데이터베이스</small>
      <select aria-label="데이터베이스" value={value} onChange={(e) => onChange(e.target.value)}>
        {databases
          .filter((d) => d.allowConn)
          .map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
            </option>
          ))}
      </select>
    </label>
  );
}
