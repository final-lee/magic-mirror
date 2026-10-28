import { objectParticle } from "../iam/previewParts";
import type { PgDefaultAclRow, PgDefaultObjectType, PgSource } from "./types";

/** 계약에서 모든 역할을 가리키는 받는 역할의 이름 */
const PUBLIC_GRANTEE = "PUBLIC";
export const PUBLIC_LABEL = "모든 역할(PUBLIC)";
/** 스키마를 정하지 않은(모든 스키마에 걸린) 기본 권한 */
export const ALL_SCHEMAS = "모든 스키마";

/** 기본 권한 표의 열 순서이자 문장이 나오는 순서 */
export const DEFAULT_OBJECT_ORDER: PgDefaultObjectType[] = ["tables", "sequences", "functions", "types", "schemas"];
export const DEFAULT_OBJECT_LABEL: Record<PgDefaultObjectType, string> = {
  tables: "테이블",
  sequences: "시퀀스",
  functions: "함수",
  types: "타입",
  schemas: "스키마",
};

/** 기본 권한 표에 나오지 않는 PostgreSQL의 기본값. 기본 권한을 바꾸지 않았다면 그대로다. */
export const BUILTIN_NOTE = "PostgreSQL 기본값: 함수는 모든 역할(PUBLIC)이 EXECUTE, 타입은 USAGE를 받아요. 기본 권한을 바꾸지 않았다면 그대로예요";

export const granteeLabel = (grantee: string) => (grantee === PUBLIC_GRANTEE ? PUBLIC_LABEL : grantee);

/** "테이블을", "시퀀스를"처럼 목적격 조사까지 붙인 이름. 조사는 미리보기 창과 같은 규칙(objectParticle)을 따른다. */
export function objectPhrase(type: PgDefaultObjectType): string {
  const label = DEFAULT_OBJECT_LABEL[type];
  return `${label}${objectParticle(label)}`;
}

type SentenceRow = Pick<PgDefaultAclRow, "creator" | "schema" | "objectType">;

/** "<만드는 역할> 역할이 <스키마>에 새 <객체>를"까지의 앞부분. 두 문장이 함께 쓴다. */
const newObject = (row: SentenceRow) => `${row.creator} 역할이 ${row.schema ?? ALL_SCHEMAS}에 새 ${objectPhrase(row.objectType)}`;

/**
 * 기본 권한 한 줄을 문장으로 푼다. 받는 역할 하나, 객체 종류 하나마다 한 문장이다.
 * 모든 역할(PUBLIC)은 이름이 이미 "역할"로 끝나서 "… 모든 역할(PUBLIC)이 …"로 쓰고, 다른 역할은 "… <이름> 역할이 …"로 쓴다.
 * 위임 가능 여부(grantable)는 문장에 넣지 않는다.
 */
export function defaultPrivilegeSentence(row: SentenceRow, grant: PgDefaultAclRow["grants"][number]): string {
  const who = grant.grantee === PUBLIC_GRANTEE ? `${PUBLIC_LABEL}이` : `${grant.grantee} 역할이`;
  return `${newObject(row)} 만들면 ${who} ${grant.privileges.join(", ")} 권한을 받아요`;
}

/** 기본 권한 줄은 있는데 받는 역할이 하나도 없을 때(받는 역할을 모두 회수한 뒤) */
export function noGrantSentence(row: SentenceRow): string {
  return `${newObject(row)} 만들어도 아무 역할도 권한을 받지 않아요`;
}

/**
 * 칸 상세에서 권한 칩에 달아 주는 출처 설명. role은 그 칸의 역할이다.
 * 그룹과 미리 정의된 역할의 via는 역할에서 권한을 받은 역할까지의 경로이고 자기 자신은 빠진다.
 * 미리 정의된 역할 자신의 칸은 via가 비어 있고, 그때는 그 역할이 곧 출처다.
 */
export function sourceText(source: PgSource, role: string): string {
  switch (source.kind) {
    case "direct":
      return "직접 받음";
    case "owner":
      return "소유자";
    case "group":
      return `${source.via.join(" ← ")} 그룹에서 받음`;
    case "public":
      return PUBLIC_LABEL;
    case "predefined":
      return (source.via.length > 0 ? source.via : [role]).join(" ← ");
    case "superuser":
      return "superuser";
  }
}
