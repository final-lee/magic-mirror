import { fireEvent, render, screen } from "@testing-library/react";
import { ROLES, alice, appRead, iamAdmin, rdsSuperuser } from "./fixtures";
import { DEFAULT_KINDS, RoleKinds, filterRoles, roleShown, type RoleKindsValue } from "./RoleKinds";

describe("roleShown", () => {
  test("by default users and groups are shown and system roles are not", () => {
    expect(DEFAULT_KINDS).toEqual({ users: true, groups: true, system: false });
    expect(roleShown(iamAdmin, DEFAULT_KINDS)).toBe(true);
    expect(roleShown(appRead, DEFAULT_KINDS)).toBe(true);
    expect(roleShown(rdsSuperuser, DEFAULT_KINDS)).toBe(false);
  });

  test("the chips hide a whole kind", () => {
    expect(roleShown(iamAdmin, { ...DEFAULT_KINDS, users: false })).toBe(false);
    expect(roleShown(appRead, { ...DEFAULT_KINDS, users: false })).toBe(true);
    expect(roleShown(appRead, { ...DEFAULT_KINDS, groups: false })).toBe(false);
    expect(roleShown(iamAdmin, { ...DEFAULT_KINDS, groups: false })).toBe(true);
  });

  test("system roles show up when the toggle is on, but still follow the chips", () => {
    const withSystem = { ...DEFAULT_KINDS, system: true };
    expect(roleShown(rdsSuperuser, withSystem)).toBe(true);
    expect(roleShown(rdsSuperuser, { ...withSystem, groups: false })).toBe(false);
  });
});

describe("filterRoles", () => {
  const names = (roles: { name: string }[]) => roles.map((r) => r.name);

  test("without a filter it is the roles the chips and the toggle show, in the order they come", () => {
    expect(names(filterRoles(ROLES, DEFAULT_KINDS, ""))).toEqual(["alice", "app_owner", "app_read", "app_write", "bob", "iam_admin", "postgres"]);
    expect(names(filterRoles(ROLES, { users: false, groups: true, system: true }, ""))).toEqual(["app_read", "app_write", "pg_read_all_data", "rds_iam", "rds_superuser"]);
  });

  test("the filter matches the name, ignoring case and the spaces around it", () => {
    expect(names(filterRoles(ROLES, DEFAULT_KINDS, "APP_"))).toEqual(["app_owner", "app_read", "app_write"]);
    expect(names(filterRoles(ROLES, DEFAULT_KINDS, "  iam_  "))).toEqual(["iam_admin"]);
    expect(names(filterRoles(ROLES, DEFAULT_KINDS, "   "))).toHaveLength(7);
  });

  test("the filter matches nothing but the name: not the comment, not a badge", () => {
    expect(filterRoles(ROLES, DEFAULT_KINDS, "orders")).toEqual([]);
    expect(filterRoles(ROLES, DEFAULT_KINDS, "관리자급")).toEqual([]);
  });

  test("the filter and the chips both have to agree, and the filter reaches the system roles that were switched on", () => {
    expect(filterRoles(ROLES, { ...DEFAULT_KINDS, groups: false }, "app_")).toEqual([ROLES.find((r) => r.name === "app_owner")]);
    expect(names(filterRoles(ROLES, { ...DEFAULT_KINDS, system: true }, "rds"))).toEqual(["rds_iam", "rds_superuser"]);
    expect(filterRoles(ROLES, DEFAULT_KINDS, "rds")).toEqual([]);
  });

  test("it keeps the very objects it was given", () => {
    expect(filterRoles([alice], DEFAULT_KINDS, "")[0]).toBe(alice);
  });
});

function setup(value: RoleKindsValue = DEFAULT_KINDS) {
  const onChange = vi.fn();
  const view = render(<RoleKinds value={value} onChange={onChange} />);
  return { onChange, ...view };
}

test("has the chips 사용자 and 그룹, both on by default, and the system roles toggle, off", () => {
  setup();
  expect(screen.getByRole("checkbox", { name: "사용자" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "그룹" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "시스템 역할 보기" })).not.toBeChecked();
  expect(screen.getByRole("group", { name: "종류" })).toContainElement(screen.getByRole("checkbox", { name: "사용자" }));
});

test("each control flips only its own flag", () => {
  const { onChange } = setup();
  fireEvent.click(screen.getByRole("checkbox", { name: "사용자" }));
  expect(onChange).toHaveBeenLastCalledWith({ users: false, groups: true, system: false });
  fireEvent.click(screen.getByRole("checkbox", { name: "그룹" }));
  expect(onChange).toHaveBeenLastCalledWith({ users: true, groups: false, system: false });
  fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
  expect(onChange).toHaveBeenLastCalledWith({ users: true, groups: true, system: true });
});

test("shows the value it is given and marks the chips that are on", () => {
  setup({ users: false, groups: true, system: true });
  expect(screen.getByRole("checkbox", { name: "사용자" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "사용자" }).closest("label")).not.toHaveClass("on");
  expect(screen.getByRole("checkbox", { name: "그룹" }).closest("label")).toHaveClass("on");
  expect(screen.getByRole("checkbox", { name: "시스템 역할 보기" })).toBeChecked();
});
