import {
  MAX_DRAFT,
  changeKey,
  groupColumns,
  isActual,
  isEditable,
  isShown,
  matchChanges,
  matchPrincipal,
  normalizeDraft,
  paintCells,
  policyCell,
  policyColumns,
  removeApplied,
  rowKey,
  setCell,
  toggleCell,
  type AssignmentTab,
  type DraftItem,
} from "./assignments";
import {
  adminPolicy,
  admins,
  alice,
  appRole,
  attachReadOnlyToBob,
  bob,
  ciBot,
  deactivateBobKey,
  deployPolicy,
  detachReadOnlyFromAlice,
  devTeam,
  orphanPolicy,
  policyArn,
  principal,
  readOnlyPolicy,
  sampleOverview,
  supportRole,
} from "./fixtures";
import type { IamChange, IamOverview, PrincipalSummary } from "./types";

const ov = sampleOverview();
const ADMIN = adminPolicy.arn;
const READ = readOnlyPolicy.arn;
const DEPLOY = deployPolicy.arn;

const labels = (draft: DraftItem[]) => draft.map((d) => d.label);

/** 칸을 차례로 눌러 만든 장바구니 */
function pressed(base: IamOverview, tab: AssignmentTab, ...cells: [PrincipalSummary, string][]): DraftItem[] {
  return cells.reduce<DraftItem[]>((draft, [row, column]) => toggleCell(draft, base, tab, row, column).draft, []);
}

/** 개요에서 주체 하나의 필드만 바꾼 새 개요(개요를 다시 불러온 상황) */
function changed(base: IamOverview, who: PrincipalSummary, extra: Partial<PrincipalSummary>): IamOverview {
  const swap = (list: PrincipalSummary[]) => list.map((p) => (p.arn === who.arn ? { ...p, ...extra } : p));
  return { ...base, users: swap(base.users), groups: swap(base.groups), roles: swap(base.roles) };
}

/** 개요에서 주체 하나를 뺀 새 개요 */
function without(base: IamOverview, who: PrincipalSummary): IamOverview {
  const drop = (list: PrincipalSummary[]) => list.filter((p) => p.arn !== who.arn);
  return { ...base, users: drop(base.users), groups: drop(base.groups), roles: drop(base.roles) };
}

/** 정책이 없는 사용자 MAX_DRAFT+1명(users)과, 거기에 ReadOnlyAccess가 붙어 있는 alice를 더한 개요 */
function crowd() {
  const users = Array.from({ length: MAX_DRAFT + 1 }, (_, i) => principal("user", `user-${String(i).padStart(2, "0")}`));
  return { users, big: sampleOverview({ users: [...users, alice] }) };
}

/** crowd의 앞 MAX_DRAFT명에게 ReadOnlyAccess 붙이기를 담아 꽉 찬 장바구니. 마지막 사용자 한 명이 남는다 */
function fullTray() {
  const { users, big } = crowd();
  const draft = paintCells([], big, "policies", users.slice(0, MAX_DRAFT).map((row) => ({ row, column: READ })), true).draft;
  return { users, big, draft };
}

describe("changeKey and rowKey", () => {
  test("changes to the same cell share a key, whichever way they point", () => {
    expect(changeKey(attachReadOnlyToBob)).toBe(`policies|${bob.arn}|${READ}`);
    expect(changeKey({ op: "detachPolicy", target: bob.arn, policyArn: READ })).toBe(changeKey(attachReadOnlyToBob));
    expect(changeKey({ op: "addToGroup", userName: "bob", groupName: "admins" })).toBe("members|bob|admins");
    expect(changeKey({ op: "removeFromGroup", userName: "bob", groupName: "admins" })).toBe("members|bob|admins");
  });

  test("changes the tray never holds have no key", () => {
    const others: IamChange[] = [
      deactivateBobKey,
      { op: "deleteAccessKey", userName: "bob", accessKeyId: "AKIAIOSFODNN7EXAMPLE" },
      { op: "putInlinePolicy", target: bob.arn, name: "x", document: "{}" },
      { op: "deleteInlinePolicy", target: bob.arn, name: "x" },
      { op: "updateManagedPolicy", policyArn: READ, document: "{}" },
    ];
    expect(others.map(changeKey)).toEqual([null, null, null, null, null]);
  });

  test("a cell's key is the key of the change made there: policies by principal ARN, members by user name", () => {
    expect(rowKey("policies", bob, READ)).toBe(changeKey(attachReadOnlyToBob));
    expect(rowKey("policies", alice, READ)).toBe(changeKey(detachReadOnlyFromAlice));
    expect(rowKey("members", bob, "admins")).toBe(changeKey({ op: "addToGroup", userName: "bob", groupName: "admins" }));
    expect(rowKey("members", alice, "dev-team")).toBe(changeKey({ op: "removeFromGroup", userName: "alice", groupName: "dev-team" }));
  });
});

describe("policyColumns", () => {
  test("lists the policies attached somewhere, most attached first and then by name", () => {
    const cols = policyColumns(ov, []);
    // AdministratorAccess (ci-bot, admins) and ReadOnlyAccess (alice, app-role) tie at 2; app-deploy (dev-team) has 1
    expect(cols.map((c) => c.name)).toEqual(["AdministratorAccess", "ReadOnlyAccess", "app-deploy"]);
    expect(cols.map((c) => c.id)).toEqual([ADMIN, READ, DEPLOY]);
  });

  test("a policy attached to more principals comes first, whatever its name", () => {
    const roles = [1, 2, 3].map((n) => principal("role", `deployer-${n}`, { attached: [DEPLOY] }));
    // app-deploy: dev-team + 3 roles = 4, AdministratorAccess: 2, ReadOnlyAccess: alice = 1
    const cols = policyColumns(sampleOverview({ roles }), []);
    expect(cols.map((c) => c.name)).toEqual(["app-deploy", "AdministratorAccess", "ReadOnlyAccess"]);
  });

  test("a column carries the policy's scope and badges", () => {
    const [admin, , deploy] = policyColumns(ov, []);
    expect(admin).toEqual({ id: ADMIN, name: "AdministratorAccess", scope: "aws", badges: adminPolicy.badges });
    expect(deploy).toEqual({ id: DEPLOY, name: "app-deploy", scope: "local", badges: [] });
  });

  test("a policy attached nowhere is not a column", () => {
    expect(policyColumns(ov, []).map((c) => c.id)).not.toContain(orphanPolicy.arn);
  });

  test("appends extra policies nobody uses after the used ones", () => {
    const cols = policyColumns(ov, [orphanPolicy.arn]);
    expect(cols.map((c) => c.name)).toEqual(["AdministratorAccess", "ReadOnlyAccess", "app-deploy", "legacy-unused"]);
    expect(cols[3]).toEqual({ id: orphanPolicy.arn, name: "legacy-unused", scope: "local", badges: orphanPolicy.badges });
  });

  test("ignores a duplicate extra and an extra that is already a column", () => {
    const cols = policyColumns(ov, [orphanPolicy.arn, READ, orphanPolicy.arn]);
    expect(cols.map((c) => c.id)).toEqual([ADMIN, READ, DEPLOY, orphanPolicy.arn]);
  });

  test("an extra the overview does not list is named by the last segment of its ARN and is aws only under aws:policy/", () => {
    const aws = policyArn("service-role/AmazonSSMManagedInstanceCore", true);
    const local = policyArn("team/custom-access");
    expect(policyColumns(ov, [aws, local]).slice(3)).toEqual([
      { id: aws, name: "AmazonSSMManagedInstanceCore", scope: "aws", badges: [] },
      { id: local, name: "custom-access", scope: "local", badges: [] },
    ]);
  });

  test("a policy attached somewhere but missing from the overview still gets a column", () => {
    const unlisted = policyArn("Unlisted", true);
    const cols = policyColumns(sampleOverview({ roles: [principal("role", "r", { attached: [unlisted] })] }), []);
    expect(cols.find((c) => c.id === unlisted)).toEqual({ id: unlisted, name: "Unlisted", scope: "aws", badges: [] });
  });

  test("leaves the overview's own lists in their order", () => {
    const before = ov.policies.map((p) => p.name);
    policyColumns(ov, [orphanPolicy.arn]);
    expect(ov.policies.map((p) => p.name)).toEqual(before);
  });
});

describe("groupColumns", () => {
  test("lists every group by name, with the group name as the column id", () => {
    expect(groupColumns(ov)).toEqual([
      { id: "admins", name: "admins", scope: null, badges: admins.badges },
      { id: "dev-team", name: "dev-team", scope: null, badges: [] },
    ]);
  });

  test("does not reorder the overview's own list", () => {
    // the sample lists dev-team before admins; sorting in place would corrupt the cached overview
    groupColumns(ov);
    expect(ov.groups.map((g) => g.name)).toEqual(["dev-team", "admins"]);
  });
});

describe("policyCell", () => {
  test("a policy a user only gets through a group is not direct and names the group", () => {
    expect(policyCell(ov, alice, DEPLOY)).toEqual({ direct: false, via: ["dev-team"] });
  });

  test("a directly attached policy is direct with no groups", () => {
    expect(policyCell(ov, alice, READ)).toEqual({ direct: true, via: [] });
  });

  test("a policy nobody gave the user is neither direct nor inherited", () => {
    expect(policyCell(ov, bob, READ)).toEqual({ direct: false, via: [] });
  });

  test("a user can have a policy directly and through a group at once", () => {
    const both = changed(ov, alice, { attached: [READ, DEPLOY] });
    expect(policyCell(both, both.users[0], DEPLOY)).toEqual({ direct: true, via: ["dev-team"] });
  });

  test("groups are listed by name, and a group missing from the overview is ignored", () => {
    const a = principal("group", "a-team", { attached: [READ] });
    const z = principal("group", "z-team", { attached: [READ] });
    const dev = principal("user", "dev", { groups: ["z-team", "gone-team", "a-team"] });
    expect(policyCell(sampleOverview({ users: [dev], groups: [a, z] }), dev, READ)).toEqual({ direct: false, via: ["a-team", "z-team"] });
  });

  test("groups and roles never have via", () => {
    expect(policyCell(ov, devTeam, DEPLOY)).toEqual({ direct: true, via: [] });
    expect(policyCell(ov, appRole, READ)).toEqual({ direct: true, via: [] });
    // even if the data gave a role a groups list, only users receive policies through groups
    const odd = principal("role", "odd", { groups: ["dev-team"] });
    expect(policyCell(ov, odd, DEPLOY)).toEqual({ direct: false, via: [] });
  });
});

describe("isActual and isShown", () => {
  test("actual follows attached on the policies tab and groups on the members tab", () => {
    expect(isActual(ov, "policies", alice, READ)).toBe(true);
    expect(isActual(ov, "policies", bob, READ)).toBe(false);
    expect(isActual(ov, "policies", alice, DEPLOY)).toBe(false); // only inherited
    expect(isActual(ov, "members", alice, "dev-team")).toBe(true);
    expect(isActual(ov, "members", alice, "admins")).toBe(false);
  });

  test("what is shown is the real state flipped by a pending change", () => {
    const detaching = pressed(ov, "policies", [alice, READ]);
    const attaching = pressed(ov, "policies", [bob, READ]);
    expect(isShown([], ov, "policies", alice, READ)).toBe(true);
    expect(isShown(detaching, ov, "policies", alice, READ)).toBe(false);
    expect(isShown([], ov, "policies", bob, READ)).toBe(false);
    expect(isShown(attaching, ov, "policies", bob, READ)).toBe(true);
    // a pending change on one cell does not touch its neighbours
    expect(isShown(attaching, ov, "policies", ciBot, READ)).toBe(false);
    expect(isShown(attaching, ov, "policies", bob, ADMIN)).toBe(false);
  });
});

describe("isEditable", () => {
  test("a locked role is not", () => {
    expect(isEditable(ov, "policies", supportRole, READ)).toBe(false);
  });

  test("a cell that is only inherited is not", () => {
    expect(isEditable(ov, "policies", alice, DEPLOY)).toBe(false);
  });

  test("a direct cell and an empty cell are", () => {
    expect(isEditable(ov, "policies", alice, READ)).toBe(true);
    expect(isEditable(ov, "policies", bob, READ)).toBe(true);
  });

  test("a cell attached directly and also inherited is", () => {
    const both = changed(ov, alice, { attached: [READ, DEPLOY] });
    expect(isEditable(both, "policies", both.users[0], DEPLOY)).toBe(true);
  });

  test("every cell on the members tab is", () => {
    for (const user of ov.users) for (const group of groupColumns(ov)) expect(isEditable(ov, "members", user, group.id)).toBe(true);
  });
});

describe("toggleCell", () => {
  test("pressing an empty cell queues an attach with its label", () => {
    const { draft, full } = toggleCell([], ov, "policies", bob, READ);
    expect(full).toBe(false);
    expect(draft).toEqual([
      { key: `policies|${bob.arn}|${READ}`, change: { op: "attachPolicy", target: bob.arn, policyArn: READ }, label: "ReadOnlyAccess 붙이기 · bob" },
    ]);
  });

  test("pressing it again takes the change back out", () => {
    const once = toggleCell([], ov, "policies", bob, READ).draft;
    expect(toggleCell(once, ov, "policies", bob, READ)).toEqual({ draft: [], full: false });
  });

  test("pressing an attached cell queues a detach, and pressing again cancels it", () => {
    const { draft } = toggleCell([], ov, "policies", alice, READ);
    expect(draft).toEqual([
      { key: `policies|${alice.arn}|${READ}`, change: { op: "detachPolicy", target: alice.arn, policyArn: READ }, label: "ReadOnlyAccess 떼기 · alice" },
    ]);
    expect(toggleCell(draft, ov, "policies", alice, READ).draft).toEqual([]);
  });

  test("on the members tab a non-member is added and a member is removed", () => {
    const add = toggleCell([], ov, "members", bob, "admins").draft;
    expect(add).toEqual([
      { key: "members|bob|admins", change: { op: "addToGroup", userName: "bob", groupName: "admins" }, label: "admins에 넣기 · bob" },
    ]);
    const remove = toggleCell([], ov, "members", alice, "dev-team").draft;
    expect(remove).toEqual([
      { key: "members|alice|dev-team", change: { op: "removeFromGroup", userName: "alice", groupName: "dev-team" }, label: "dev-team에서 빼기 · alice" },
    ]);
    expect(toggleCell(add, ov, "members", bob, "admins").draft).toEqual([]);
  });

  test("groups and roles can be attached to as well, labelled by their own name", () => {
    expect(labels(pressed(ov, "policies", [admins, READ], [appRole, ADMIN]))).toEqual(["ReadOnlyAccess 붙이기 · admins", "AdministratorAccess 붙이기 · app-role"]);
  });

  test("keeps the order things were queued in; cancelling one leaves the others", () => {
    const three = pressed(ov, "policies", [bob, READ], [ciBot, READ], [alice, READ]);
    expect(labels(three)).toEqual(["ReadOnlyAccess 붙이기 · bob", "ReadOnlyAccess 붙이기 · ci-bot", "ReadOnlyAccess 떼기 · alice"]);
    expect(labels(toggleCell(three, ov, "policies", ciBot, READ).draft)).toEqual(["ReadOnlyAccess 붙이기 · bob", "ReadOnlyAccess 떼기 · alice"]);
  });

  test("an inherited-only cell and a locked row change nothing", () => {
    const base = pressed(ov, "policies", [bob, READ]);
    expect(toggleCell(base, ov, "policies", alice, DEPLOY)).toEqual({ draft: base, full: false });
    expect(toggleCell(base, ov, "policies", alice, DEPLOY).draft).toBe(base);
    expect(toggleCell(base, ov, "policies", supportRole, READ).draft).toBe(base);
  });

  test("a policy the overview does not list is labelled by the last segment of its ARN", () => {
    const unlisted = policyArn("Unlisted", true);
    expect(labels(toggleCell([], ov, "policies", bob, unlisted).draft)).toEqual(["Unlisted 붙이기 · bob"]);
  });
});

describe("setCell", () => {
  test("the tray holds 50", () => {
    expect(MAX_DRAFT).toBe(50);
    expect(fullTray().draft).toHaveLength(50);
  });

  test("refuses the 51st item and leaves the draft as it was", () => {
    const { users, big, draft } = fullTray();
    const result = setCell(draft, big, "policies", users[MAX_DRAFT], READ, true);
    expect(result.full).toBe(true);
    expect(result.draft).toBe(draft);
  });

  test("a full tray still lets a pending change be cancelled, which frees a place", () => {
    const { users, big, draft } = fullTray();
    const freed = toggleCell(draft, big, "policies", users[0], READ);
    expect(freed.full).toBe(false);
    expect(freed.draft).toHaveLength(MAX_DRAFT - 1);
    expect(setCell(freed.draft, big, "policies", users[MAX_DRAFT], READ, true)).toMatchObject({ full: false });
  });

  test("a cell that already has the wanted change is not a new item, so a full tray is not reported", () => {
    const { users, big, draft } = fullTray();
    const result = setCell(draft, big, "policies", users[0], READ, true);
    expect(result.full).toBe(false);
    expect(result.draft).toBe(draft);
  });

  test("a cell whose real state is already the wanted one needs no change", () => {
    const base: DraftItem[] = [];
    expect(setCell(base, ov, "policies", alice, READ, true).draft).toBe(base);
    expect(setCell(base, ov, "policies", bob, READ, false).draft).toBe(base);
  });

  test("a cell with a pending change to the opposite of the wanted state drops it", () => {
    const attaching = pressed(ov, "policies", [bob, READ]);
    expect(setCell(attaching, ov, "policies", bob, READ, false).draft).toEqual([]);
  });

  test("a locked row or an inherited-only cell is never changed", () => {
    expect(setCell([], ov, "policies", supportRole, READ, true).draft).toEqual([]);
    expect(setCell([], ov, "policies", alice, DEPLOY, true).draft).toEqual([]);
  });
});

describe("paintCells", () => {
  const cells = (...list: [PrincipalSummary, string][]) => list.map(([row, column]) => ({ row, column }));

  test("painting on queues attaches, cancels a pending detach and skips a locked row", () => {
    const pending = pressed(ov, "policies", [alice, READ]); // alice/ReadOnly is attached, so this is a pending detach
    const { draft, full } = paintCells(pending, ov, "policies", cells([bob, READ], [alice, READ], [supportRole, READ]), true);
    expect(full).toBe(false);
    expect(labels(draft)).toEqual(["ReadOnlyAccess 붙이기 · bob"]);
  });

  test("painting off queues detaches, cancels a pending attach and leaves an already empty cell alone", () => {
    const pending = pressed(ov, "policies", [ciBot, READ]); // ci-bot has no ReadOnly, so this is a pending attach
    const { draft } = paintCells(pending, ov, "policies", cells([alice, READ], [bob, READ], [ciBot, READ], [appRole, READ]), false);
    expect(labels(draft)).toEqual(["ReadOnlyAccess 떼기 · alice", "ReadOnlyAccess 떼기 · app-role"]);
  });

  test("a cell that is only inherited is skipped either way", () => {
    expect(paintCells([], ov, "policies", cells([alice, DEPLOY]), true).draft).toEqual([]);
    expect(paintCells([], ov, "policies", cells([alice, DEPLOY]), false).draft).toEqual([]);
  });

  test("works across the members tab too", () => {
    const { draft } = paintCells([], ov, "members", cells([bob, "admins"], [alice, "admins"], [alice, "dev-team"], [bob, "dev-team"]), true);
    expect(labels(draft)).toEqual(["admins에 넣기 · bob", "admins에 넣기 · alice"]);
  });

  test("an unchanged paint returns the very same draft", () => {
    const base = pressed(ov, "policies", [bob, READ]);
    expect(paintCells(base, ov, "policies", cells([bob, READ], [alice, READ]), true).draft).toBe(base);
  });

  test("reports full when the tray ran out, keeping the cells that fit", () => {
    const { users, big } = crowd(); // one more cell than the tray holds, then a cell that needs no change
    const all = [...users.map((row) => ({ row, column: READ })), { row: alice, column: READ }];
    const { draft, full } = paintCells([], big, "policies", all, true);
    expect(full).toBe(true);
    expect(draft).toHaveLength(MAX_DRAFT);
    expect(draft[0].label).toBe("ReadOnlyAccess 붙이기 · user-00");
    expect(draft[MAX_DRAFT - 1].label).toBe("ReadOnlyAccess 붙이기 · user-49");
  });
});

describe("matchPrincipal", () => {
  test("lists what only the source has to add and what only the target has as extra", () => {
    expect(matchPrincipal(ov, "policies", ciBot, bob)).toEqual({ add: [ADMIN], extra: [] });
    expect(matchPrincipal(ov, "policies", bob, alice)).toEqual({ add: [], extra: [READ] });
  });

  test("does not look at policies that come from groups", () => {
    // alice also gets app-deploy through dev-team, but it is not hers to copy
    expect(matchPrincipal(ov, "policies", alice, ciBot)).toEqual({ add: [READ], extra: [ADMIN] });
    // bob gets app-deploy through dev-team, but it is not a direct policy to take off
    expect(matchPrincipal(ov, "policies", ciBot, bob)).toEqual({ add: [ADMIN], extra: [] });
  });

  test("two principals with the same policies match already", () => {
    expect(matchPrincipal(ov, "policies", alice, appRole)).toEqual({ add: [], extra: [] });
  });

  test("on the members tab it compares group membership", () => {
    expect(matchPrincipal(ov, "members", alice, ciBot)).toEqual({ add: ["dev-team"], extra: [] });
    expect(matchPrincipal(ov, "members", ciBot, alice)).toEqual({ add: [], extra: ["dev-team"] });
    expect(matchPrincipal(ov, "members", alice, bob)).toEqual({ add: [], extra: [] });
  });

  test("leaves out a policy the target already gets through a group, since that cell cannot be changed", () => {
    const source = { ...ciBot, attached: [ADMIN, DEPLOY] }; // has app-deploy directly
    // bob gets app-deploy through dev-team, so only AdministratorAccess is on offer
    expect(matchPrincipal(ov, "policies", source, bob)).toEqual({ add: [ADMIN], extra: [] });
    // a target outside that group is offered it as usual
    expect(matchPrincipal(ov, "policies", source, ciBot)).toEqual({ add: [DEPLOY], extra: [] });
  });

  test("keeps a policy the target has directly and also through a group among the extras", () => {
    const both = { ...bob, attached: [READ, DEPLOY] }; // app-deploy directly and through dev-team: still editable
    expect(matchPrincipal(ov, "policies", ciBot, both)).toEqual({ add: [ADMIN], extra: [READ, DEPLOY] });
  });

  test("offers nothing for a locked target, neither to add nor to take off", () => {
    const locked = { ...supportRole, attached: [READ] };
    expect(matchPrincipal(ov, "policies", ciBot, locked)).toEqual({ add: [], extra: [] });
    expect(matchPrincipal(ov, "policies", locked, ciBot)).toEqual({ add: [READ], extra: [ADMIN] }); // a locked source is fine to copy from
  });
});

describe("matchChanges", () => {
  test("with nothing to remove it adds only the attaches", () => {
    const { draft, full } = matchChanges([], ov, "policies", bob, [ADMIN], []);
    expect(full).toBe(false);
    expect(labels(draft)).toEqual(["AdministratorAccess 붙이기 · bob"]);
  });

  test("adds first and then detaches the chosen extras, keeping what was already queued", () => {
    const queued = pressed(ov, "policies", [ciBot, READ]);
    const { draft } = matchChanges(queued, ov, "policies", alice, [ADMIN], [READ]);
    expect(labels(draft)).toEqual(["ReadOnlyAccess 붙이기 · ci-bot", "AdministratorAccess 붙이기 · alice", "ReadOnlyAccess 떼기 · alice"]);
  });

  test("on the members tab it puts the user into and out of groups", () => {
    const { draft } = matchChanges([], ov, "members", alice, ["admins"], ["dev-team"]);
    expect(labels(draft)).toEqual(["admins에 넣기 · alice", "dev-team에서 빼기 · alice"]);
  });

  test("queues nothing for a locked target", () => {
    expect(matchChanges([], ov, "policies", supportRole, [ADMIN], [])).toEqual({ draft: [], full: false });
  });

  test("reports a full tray when attaches do not fit, keeping the ones that do", () => {
    const { users, big, draft } = fullTray();
    const room = toggleCell(draft, big, "policies", users[0], READ).draft; // one place free
    const result = matchChanges(room, big, "policies", users[MAX_DRAFT], [ADMIN, DEPLOY], []);
    expect(result.full).toBe(true);
    expect(result.draft).toHaveLength(MAX_DRAFT);
    expect(result.draft[MAX_DRAFT - 1].label).toBe("AdministratorAccess 붙이기 · user-50");
  });

  test("reports a full tray when only the detaches do not fit", () => {
    const { big, draft } = fullTray();
    const result = matchChanges(draft, big, "policies", alice, [], [READ]);
    expect(result.full).toBe(true);
    expect(result.draft).toBe(draft);
  });
});

describe("normalizeDraft", () => {
  test("drops a pending attach whose target is now attached", () => {
    const draft = pressed(ov, "policies", [bob, READ]);
    const now = changed(ov, bob, { attached: [READ] });
    expect(normalizeDraft(now, draft)).toEqual({ draft: [], notices: ["이미 붙어 있어서 뺐어요: ReadOnlyAccess 붙이기 · bob"] });
  });

  test("drops a pending detach whose policy is now gone from the target", () => {
    const draft = pressed(ov, "policies", [alice, READ]);
    const now = changed(ov, alice, { attached: [] });
    expect(normalizeDraft(now, draft)).toEqual({ draft: [], notices: ["이미 떨어져 있어서 뺐어요: ReadOnlyAccess 떼기 · alice"] });
  });

  test("drops an add to a group the user is now in", () => {
    const draft = pressed(ov, "members", [bob, "admins"]);
    const now = changed(ov, bob, { groups: ["dev-team", "admins"] });
    expect(normalizeDraft(now, draft)).toEqual({ draft: [], notices: ["이미 그룹에 있어서 뺐어요: admins에 넣기 · bob"] });
  });

  test("drops a remove from a group the user is no longer in", () => {
    const draft = pressed(ov, "members", [alice, "dev-team"]);
    const now = changed(ov, alice, { groups: [] });
    expect(normalizeDraft(now, draft)).toEqual({ draft: [], notices: ["이미 그룹에 없어서 뺐어요: dev-team에서 빼기 · alice"] });
  });

  test("drops a change whose principal has disappeared", () => {
    const draft = pressed(ov, "policies", [bob, READ]);
    expect(normalizeDraft(without(ov, bob), draft)).toEqual({ draft: [], notices: ["찾을 수 없어서 뺐어요: ReadOnlyAccess 붙이기 · bob"] });
    const role = pressed(ov, "policies", [appRole, ADMIN]);
    expect(normalizeDraft(without(ov, appRole), role).notices).toEqual(["찾을 수 없어서 뺐어요: AdministratorAccess 붙이기 · app-role"]);
  });

  test("drops a membership change whose user or group has disappeared", () => {
    const draft = pressed(ov, "members", [bob, "admins"]);
    expect(normalizeDraft(without(ov, bob), draft).notices).toEqual(["찾을 수 없어서 뺐어요: admins에 넣기 · bob"]);
    expect(normalizeDraft(without(ov, admins), draft).notices).toEqual(["찾을 수 없어서 뺐어요: admins에 넣기 · bob"]);
  });

  describe("a policy that is no longer there", () => {
    // app-deploy was deleted: it is gone from the policy list and from everything it was attached to
    const deleted = sampleOverview({ policies: ov.policies.filter((p) => p.arn !== DEPLOY), groups: [{ ...devTeam, attached: [] }, admins] });

    test("drops an attach of a customer-managed policy the overview no longer lists, as not found", () => {
      const draft = pressed(ov, "policies", [ciBot, DEPLOY]);
      expect(labels(draft)).toEqual(["app-deploy 붙이기 · ci-bot"]);
      expect(normalizeDraft(deleted, draft)).toEqual({ draft: [], notices: ["찾을 수 없어서 뺐어요: app-deploy 붙이기 · ci-bot"] });
    });

    test("keeps an attach of a customer-managed policy the overview still lists", () => {
      const draft = pressed(ov, "policies", [ciBot, DEPLOY]);
      const result = normalizeDraft(sampleOverview(), draft);
      expect(result.draft).toBe(draft);
      expect(result.notices).toEqual([]);
    });

    test("keeps an attach of an AWS-managed policy the overview does not list: it may be an unused one added as a column", () => {
      const unlisted = policyArn("AmazonS3ReadOnlyAccess", true);
      const draft = pressed(ov, "policies", [bob, unlisted]);
      expect(labels(draft)).toEqual(["AmazonS3ReadOnlyAccess 붙이기 · bob"]);
      const result = normalizeDraft(ov, draft);
      expect(result.draft).toBe(draft);
      expect(result.notices).toEqual([]);
    });

    test("tells an attach of a deleted policy from the others in the same draft", () => {
      const unlisted = policyArn("AmazonS3ReadOnlyAccess", true);
      const draft = pressed(ov, "policies", [bob, unlisted], [ciBot, DEPLOY], [bob, READ]);
      const result = normalizeDraft(deleted, draft);
      expect(labels(result.draft)).toEqual(["AmazonS3ReadOnlyAccess 붙이기 · bob", "ReadOnlyAccess 붙이기 · bob"]);
      expect(result.notices).toEqual(["찾을 수 없어서 뺐어요: app-deploy 붙이기 · ci-bot"]);
    });

    test("a detach of it is still reported as already detached, not as not found", () => {
      const draft = pressed(ov, "policies", [devTeam, DEPLOY]);
      expect(labels(draft)).toEqual(["app-deploy 떼기 · dev-team"]);
      expect(normalizeDraft(deleted, draft)).toEqual({ draft: [], notices: ["이미 떨어져 있어서 뺐어요: app-deploy 떼기 · dev-team"] });
    });
  });

  test("keeps what is still to be done, in order, and reports only what it dropped", () => {
    const draft = pressed(ov, "policies", [bob, READ], [ciBot, READ], [alice, READ]);
    // bob now has ReadOnlyAccess; the other two are as before
    const now = changed(ov, bob, { attached: [READ] });
    const result = normalizeDraft(now, draft);
    expect(labels(result.draft)).toEqual(["ReadOnlyAccess 붙이기 · ci-bot", "ReadOnlyAccess 떼기 · alice"]);
    expect(result.notices).toEqual(["이미 붙어 있어서 뺐어요: ReadOnlyAccess 붙이기 · bob"]);
  });

  test("an unchanged draft comes back as the same array with no notices", () => {
    const draft = pressed(ov, "policies", [bob, READ], [alice, READ]);
    const result = normalizeDraft(ov, draft);
    expect(result.draft).toBe(draft);
    expect(result.notices).toEqual([]);
    const empty: DraftItem[] = [];
    expect(normalizeDraft(ov, empty).draft).toBe(empty);
  });
});

describe("removeApplied", () => {
  test("drops the items whose cell was changed, keeping the rest in order", () => {
    const draft = pressed(ov, "policies", [bob, READ], [ciBot, READ], [alice, READ]);
    const left = removeApplied(draft, [attachReadOnlyToBob, detachReadOnlyFromAlice]);
    expect(labels(left)).toEqual(["ReadOnlyAccess 붙이기 · ci-bot"]);
  });

  test("works for membership changes", () => {
    const draft = pressed(ov, "members", [bob, "admins"], [alice, "dev-team"]);
    expect(labels(removeApplied(draft, [{ op: "addToGroup", userName: "bob", groupName: "admins" }]))).toEqual(["dev-team에서 빼기 · alice"]);
  });

  test("ignores applied changes that have no cell and those that are not in the tray", () => {
    const draft = pressed(ov, "policies", [bob, READ]);
    expect(removeApplied(draft, [deactivateBobKey, detachReadOnlyFromAlice])).toEqual(draft);
    expect(removeApplied(draft, [])).toEqual(draft);
  });
});
