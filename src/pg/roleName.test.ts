import { ROLES } from "./fixtures";
import { BAD_NAME_TEXT, RESERVED_NAME_TEXT, nameTakenText, roleNameProblem } from "./roleName";

const problem = (name: string) => roleNameProblem(name, ROLES);

describe("roleNameProblem (the backend's rules and texts)", () => {
  test("the texts are the backend's", () => {
    expect(BAD_NAME_TEXT).toBe("역할 이름이 올바르지 않아요. 1~63바이트이고 pg_로 시작하지 않아야 해요");
    expect(RESERVED_NAME_TEXT).toBe("이 이름은 PostgreSQL이 예약해 둬서 쓸 수 없어요");
    expect(nameTakenText("alice")).toBe("이미 있는 역할이에요: alice");
  });

  test("a good name has no problem", () => {
    expect(problem("carol")).toBeNull();
    expect(problem("Carol-2")).toBeNull();
  });

  test("empty, pg_ prefix and control characters are bad", () => {
    expect(problem("")).toBe(BAD_NAME_TEXT);
    expect(problem("pg_custom")).toBe(BAD_NAME_TEXT);
    expect(problem("a\nb")).toBe(BAD_NAME_TEXT);
    expect(problem("a\u007fb")).toBe(BAD_NAME_TEXT);
    expect(problem("PG_custom")).toBeNull(); // 접두사는 글자 그대로 본다
  });

  test("the limit is 63 bytes, not characters", () => {
    expect(problem("a".repeat(63))).toBeNull();
    expect(problem("a".repeat(64))).toBe(BAD_NAME_TEXT);
    expect(problem("가".repeat(21))).toBeNull(); // 63바이트
    expect(problem("가".repeat(22))).toBe(BAD_NAME_TEXT); // 66바이트
  });

  test("reserved words are refused whatever the case", () => {
    for (const name of ["public", "PUBLIC", "None", "current_user", "SESSION_USER", "current_role"]) expect(problem(name)).toBe(RESERVED_NAME_TEXT);
  });

  test("an existing role is refused by its exact name", () => {
    expect(problem("alice")).toBe(nameTakenText("alice"));
    expect(problem("Alice")).toBeNull();
  });
});
