import { source } from "./fixtures";
import {
  ALL_SCHEMAS,
  BUILTIN_NOTE,
  DEFAULT_OBJECT_LABEL,
  DEFAULT_OBJECT_ORDER,
  PUBLIC_LABEL,
  defaultPrivilegeSentence,
  granteeLabel,
  objectPhrase,
  sourceText,
} from "./sentences";
import type { PgDefaultAclRow, PgDefaultObjectType } from "./types";

const row = (extra: Partial<PgDefaultAclRow> = {}): PgDefaultAclRow => ({ creator: "app_owner", schema: "app", objectType: "tables", grants: [], ...extra });
const grant = (grantee: string, ...privileges: string[]) => ({ grantee, privileges, grantable: false });

describe("the object kinds", () => {
  test("are in the order of the columns of the table", () => {
    expect(DEFAULT_OBJECT_ORDER).toEqual(["tables", "sequences", "functions", "types", "schemas"]);
  });

  test("have their Korean names", () => {
    expect(DEFAULT_OBJECT_LABEL).toEqual({ tables: "테이블", sequences: "시퀀스", functions: "함수", types: "타입", schemas: "스키마" });
  });

  test.each<[PgDefaultObjectType, string]>([
    ["tables", "테이블을"],
    ["sequences", "시퀀스를"],
    ["functions", "함수를"],
    ["types", "타입을"],
    ["schemas", "스키마를"],
  ])("%s takes its particle by the last syllable: %s", (type, phrase) => {
    expect(objectPhrase(type)).toBe(phrase);
  });
});

describe("granteeLabel", () => {
  test("PUBLIC reads as 모든 역할(PUBLIC)", () => {
    expect(PUBLIC_LABEL).toBe("모든 역할(PUBLIC)");
    expect(granteeLabel("PUBLIC")).toBe("모든 역할(PUBLIC)");
  });

  test("any other grantee is its own name, also when it only looks like PUBLIC", () => {
    expect(granteeLabel("app_read")).toBe("app_read");
    expect(granteeLabel("public")).toBe("public");
    expect(granteeLabel("PUBLIC_READ")).toBe("PUBLIC_READ");
  });
});

describe("defaultPrivilegeSentence", () => {
  test("says who creates what where, and who gets which privileges", () => {
    expect(defaultPrivilegeSentence(row(), grant("app_read", "SELECT"))).toBe("app_owner 역할이 app에 새 테이블을 만들면 app_read 역할이 SELECT 권한을 받아요");
  });

  test("several privileges are listed in the order they come, with commas", () => {
    expect(defaultPrivilegeSentence(row(), grant("app_write", "INSERT", "UPDATE", "DELETE"))).toBe(
      "app_owner 역할이 app에 새 테이블을 만들면 app_write 역할이 INSERT, UPDATE, DELETE 권한을 받아요",
    );
  });

  test("a default for every schema (no schema) says 모든 스키마", () => {
    expect(ALL_SCHEMAS).toBe("모든 스키마");
    expect(defaultPrivilegeSentence(row({ schema: null, objectType: "types" }), grant("app_read", "USAGE"))).toBe(
      "app_owner 역할이 모든 스키마에 새 타입을 만들면 app_read 역할이 USAGE 권한을 받아요",
    );
  });

  test("PUBLIC is named 모든 역할(PUBLIC) in the place of the grantee", () => {
    expect(defaultPrivilegeSentence(row({ objectType: "functions" }), grant("PUBLIC", "EXECUTE"))).toBe(
      "app_owner 역할이 app에 새 함수를 만들면 모든 역할(PUBLIC) 역할이 EXECUTE 권한을 받아요",
    );
  });

  test.each<[PgDefaultObjectType, string]>([
    ["tables", "새 테이블을 만들면"],
    ["sequences", "새 시퀀스를 만들면"],
    ["functions", "새 함수를 만들면"],
    ["types", "새 타입을 만들면"],
    ["schemas", "새 스키마를 만들면"],
  ])("%s: the particle matches the object", (objectType, phrase) => {
    expect(defaultPrivilegeSentence(row({ objectType }), grant("app_read", "USAGE"))).toContain(` ${phrase} `);
  });

  test("the grant option is not part of the sentence", () => {
    expect(defaultPrivilegeSentence(row(), { grantee: "iam_admin", privileges: ["SELECT"], grantable: true })).toBe(
      "app_owner 역할이 app에 새 테이블을 만들면 iam_admin 역할이 SELECT 권한을 받아요",
    );
  });
});

test("the note about what PostgreSQL grants by default is the exact text", () => {
  expect(BUILTIN_NOTE).toBe("PostgreSQL 기본값: 함수는 모든 역할(PUBLIC)이 EXECUTE, 타입은 USAGE를 받아요. 위 표에서 바꾸지 않았다면 그대로예요");
});

describe("sourceText", () => {
  test("a direct grant, the owner and PUBLIC are named as such", () => {
    expect(sourceText(source("direct", [], "app_owner"), "alice")).toBe("직접 받음");
    expect(sourceText(source("owner"), "app_owner")).toBe("소유자");
    expect(sourceText(source("public"), "alice")).toBe("모든 역할(PUBLIC)");
  });

  test("a group names the way to it, from the role to the group that was granted", () => {
    expect(sourceText(source("group", ["app_read"]), "app_write")).toBe("app_read 그룹에서 받음");
    expect(sourceText(source("group", ["app_write", "app_read"]), "alice")).toBe("app_write ← app_read 그룹에서 받음");
    expect(sourceText(source("group", ["a", "b", "c"]), "alice")).toBe("a ← b ← c 그룹에서 받음");
  });

  test("a predefined role is named, with the way to it when it is not a direct membership", () => {
    expect(sourceText(source("predefined", ["pg_read_all_data"]), "iam_admin")).toBe("pg_read_all_data");
    expect(sourceText(source("predefined", ["reporting", "pg_write_all_data"]), "alice")).toBe("reporting ← pg_write_all_data");
  });

  test("the predefined role itself has nothing between: the role is the source", () => {
    expect(sourceText(source("predefined"), "pg_read_all_data")).toBe("pg_read_all_data");
  });

  test("a superuser is just that", () => {
    expect(sourceText(source("superuser"), "postgres")).toBe("superuser");
  });
});
