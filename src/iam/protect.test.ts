import { alice, appRole, BADGES, badge, principal, supportRole } from "./fixtures";
import { changeBlockReason } from "./protect";

describe("changeBlockReason", () => {
  test("ordinary users, groups and roles can be changed", () => {
    expect(changeBlockReason(alice)).toBeNull();
    expect(changeBlockReason(appRole)).toBeNull();
    expect(changeBlockReason(principal("group", "dev-team"))).toBeNull();
  });

  test("a service-linked role is refused, found by its badge or by its path", () => {
    expect(changeBlockReason(supportRole)).toBe("서비스 연결 역할은 AWS가 관리해서 바꿀 수 없어요");
    expect(changeBlockReason(principal("role", "x", { path: "/aws-service-role/x.amazonaws.com/" }))).toBe("서비스 연결 역할은 AWS가 관리해서 바꿀 수 없어요");
    expect(changeBlockReason(principal("role", "y", { badges: [BADGES.serviceLinked] }))).toBe("서비스 연결 역할은 AWS가 관리해서 바꿀 수 없어요");
  });

  test("an Identity Center role is refused by badge, path or name", () => {
    const reason = "Identity Center가 관리하는 역할이라 바꿀 수 없어요";
    expect(changeBlockReason(principal("role", "a", { badges: [badge("sso", "Identity Center", "info")] }))).toBe(reason);
    expect(changeBlockReason(principal("role", "b", { path: "/aws-reserved/sso.amazonaws.com/ap-northeast-2/" }))).toBe(reason);
    expect(changeBlockReason(principal("role", "AWSReservedSSO_Admin_0123456789abcdef"))).toBe(reason);
  });

  test("the name rule applies to roles only", () => {
    expect(changeBlockReason(principal("user", "AWSReservedSSO_lookalike"))).toBeNull();
  });
});
