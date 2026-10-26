import { admins, adminPolicy, alice, appRole, devTeam, deployPolicy, sampleOverview } from "./fixtures";
import { inlineOwnerFromId, policyNameFromId, principalRoute, routeForFocus, sameRoute } from "./route";

describe("sameRoute", () => {
  test("compares view and id only", () => {
    expect(sameRoute({ view: "users" }, { view: "users" })).toBe(true);
    expect(sameRoute({ view: "users", id: "a", tab: "keys" }, { view: "users", id: "a" })).toBe(true);
    expect(sameRoute({ view: "users", id: "a" }, { view: "users", id: "b" })).toBe(false);
    expect(sameRoute({ view: "users" }, { view: "roles" })).toBe(false);
  });
});

describe("routeForFocus", () => {
  const ov = sampleOverview();

  test("finds users, groups and roles by ARN in the overview lists", () => {
    expect(routeForFocus(ov, alice.arn)).toEqual({ view: "users", id: alice.arn });
    expect(routeForFocus(ov, devTeam.arn)).toEqual({ view: "groups", id: devTeam.arn });
    expect(routeForFocus(ov, appRole.arn)).toEqual({ view: "roles", id: appRole.arn });
    expect(routeForFocus(ov, admins.arn)).toEqual({ view: "groups", id: admins.arn });
  });

  test("uses the policy id from the overview when the ARN matches a policy", () => {
    expect(routeForFocus(ov, deployPolicy.arn)).toEqual({ view: "policies", id: deployPolicy.id });
    expect(routeForFocus(ov, adminPolicy.id)).toEqual({ view: "policies", id: adminPolicy.id });
  });

  test("falls back to the ARN resource type for targets missing from the snapshot", () => {
    const arn = "arn:aws:iam::123456789012:role/team/new-role";
    expect(routeForFocus(ov, arn)).toEqual({ view: "roles", id: arn });
    const user = "arn:aws:iam::123456789012:user/zoe";
    expect(routeForFocus(ov, user)).toEqual({ view: "users", id: user });
    const policy = "arn:aws:iam::123456789012:policy/brand-new";
    expect(routeForFocus(ov, policy)).toEqual({ view: "policies", id: policy });
  });

  test("returns null for ARNs that are not IAM users, groups, roles or policies", () => {
    expect(routeForFocus(ov, "arn:aws:s3:::bucket")).toBeNull();
    expect(routeForFocus(ov, "not-an-arn")).toBeNull();
    expect(routeForFocus(ov, "arn:aws:iam::123456789012:instance-profile/x")).toBeNull();
  });
});

describe("principalRoute", () => {
  test("maps the principal kind to its list view", () => {
    expect(principalRoute("user", "arn:u")).toEqual({ view: "users", id: "arn:u" });
    expect(principalRoute("group", "arn:g")).toEqual({ view: "groups", id: "arn:g" });
    expect(principalRoute("role", "arn:r")).toEqual({ view: "roles", id: "arn:r" });
  });
});

describe("policyNameFromId", () => {
  test("uses the last ARN segment for managed policies", () => {
    expect(policyNameFromId("arn:aws:iam::aws:policy/ReadOnlyAccess")).toBe("ReadOnlyAccess");
    expect(policyNameFromId("arn:aws:iam::123456789012:policy/team/app-deploy")).toBe("app-deploy");
  });

  test("uses the part after the owner ARN for inline policies", () => {
    expect(policyNameFromId("inline:arn:aws:iam::123456789012:user/alice:s3-scratch")).toBe("s3-scratch");
  });
});

describe("inlineOwnerFromId", () => {
  test("returns the user, group or role that owns the inline policy", () => {
    expect(inlineOwnerFromId("inline:arn:aws:iam::123456789012:user/alice:s3-scratch")).toBe("arn:aws:iam::123456789012:user/alice");
    expect(inlineOwnerFromId("inline:arn:aws:iam::123456789012:group/dev-team:notes")).toBe("arn:aws:iam::123456789012:group/dev-team");
    expect(inlineOwnerFromId("inline:arn:aws:iam::123456789012:role/svc/app-role:queue-access")).toBe("arn:aws:iam::123456789012:role/svc/app-role");
  });

  test("is null for a managed policy id or an owner that is not an IAM principal", () => {
    expect(inlineOwnerFromId("arn:aws:iam::123456789012:policy/app-deploy")).toBeNull();
    expect(inlineOwnerFromId("inline:foo")).toBeNull();
    expect(inlineOwnerFromId("inline:arn:aws:s3:::bucket:name")).toBeNull();
    expect(inlineOwnerFromId("")).toBeNull();
  });
});
