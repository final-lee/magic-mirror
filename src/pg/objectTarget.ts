import type { PgGrantTarget, PgObjectRef } from "./types";

/**
 * 객체를 권한을 주고 빼는 대상으로 바꾼다. 테이블, 뷰, 구체화 뷰, 파티션 테이블, 외부 테이블은 relation이다.
 * 스키마 이름이 없는 relation·sequence·function은 대상이 될 수 없어 null이다(데이터베이스와 스키마는 이름만으로 충분하다).
 */
export function grantTargetOf(object: PgObjectRef): PgGrantTarget | null {
  switch (object.kind) {
    case "database":
    case "schema":
      return { kind: object.kind, name: object.name };
    case "sequence":
      return object.schema === null ? null : { kind: "sequence", schema: object.schema, name: object.name };
    case "function":
      return object.schema === null || object.signature === null ? null : { kind: "function", schema: object.schema, name: object.name, signature: object.signature };
    default:
      return object.schema === null ? null : { kind: "relation", schema: object.schema, name: object.name };
  }
}
