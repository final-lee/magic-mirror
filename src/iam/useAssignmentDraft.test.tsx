import { act, render, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { MAX_DRAFT, type DraftItem } from "./assignments";
import {
  adminPolicy,
  alice,
  attachReadOnlyToBob,
  bob,
  ciBot,
  deployPolicy,
  detachReadOnlyFromAlice,
  principal,
  readOnlyPolicy,
  sampleOverview,
  supportRole,
} from "./fixtures";
import type { IamOverview, PrincipalSummary } from "./types";
import { useAssignmentDraft } from "./useAssignmentDraft";

const ADMIN = adminPolicy.arn;
const READ = readOnlyPolicy.arn;
const FULL = "한 번에 50개까지 담을 수 있어요";

const ov = sampleOverview();
type Props = { profile: string; ov: IamOverview | undefined };

function setup(props: Props = { profile: "prod", ov }) {
  return renderHook((p: Props) => useAssignmentDraft(p.profile, p.ov), { initialProps: props });
}

const labels = (items: DraftItem[]) => items.map((d) => d.label);

/** 개요를 다시 불러온 결과: 주체 하나의 필드만 다르다 */
function reloaded(who: PrincipalSummary, extra: Partial<PrincipalSummary>): IamOverview {
  return sampleOverview({ users: ov.users.map((u) => (u.arn === who.arn ? { ...u, ...extra } : u)) });
}

/** 사용자가 MAX_DRAFT+1명 있는 개요 */
function crowd() {
  const users = Array.from({ length: MAX_DRAFT + 1 }, (_, i) => principal("user", `user-${String(i).padStart(2, "0")}`));
  return { users, big: sampleOverview({ users }), cells: users.map((row) => ({ row, column: READ })) };
}

test("starts with an empty tray and no notices", () => {
  const { result } = setup();
  expect(result.current.items).toEqual([]);
  expect(result.current.notices).toEqual([]);
});

describe("queueing", () => {
  test("two toggles in one act compose: the second sees the first", () => {
    const { result } = setup();
    act(() => {
      result.current.toggle("policies", bob, READ);
      result.current.toggle("policies", ciBot, READ);
    });
    expect(labels(result.current.items)).toEqual(["ReadOnlyAccess 붙이기 · bob", "ReadOnlyAccess 붙이기 · ci-bot"]);
  });

  test("a toggle and the same toggle again in one act cancel out", () => {
    const { result } = setup();
    act(() => {
      result.current.toggle("policies", bob, READ);
      result.current.toggle("policies", bob, READ);
    });
    expect(result.current.items).toEqual([]);
  });

  test("a toggle on a locked row or an inherited-only cell queues nothing", () => {
    const { result } = setup();
    act(() => {
      result.current.toggle("policies", supportRole, READ);
      result.current.toggle("policies", alice, deployPolicy.arn); // alice only gets app-deploy through dev-team
    });
    expect(result.current.items).toEqual([]);
  });

  test("paint sets a run of cells to the wanted state in one go", () => {
    const { result } = setup();
    const run = [{ row: bob, column: READ }, { row: ciBot, column: READ }, { row: alice, column: READ }];
    act(() => result.current.paint("policies", run, true));
    // alice already has it, so only the other two are queued
    expect(labels(result.current.items)).toEqual(["ReadOnlyAccess 붙이기 · bob", "ReadOnlyAccess 붙이기 · ci-bot"]);
    // painting the same run off cancels those two and queues the one that is really attached
    act(() => result.current.paint("policies", run, false));
    expect(labels(result.current.items)).toEqual(["ReadOnlyAccess 떼기 · alice"]);
  });

  test("match queues the attaches and the chosen detaches for the target", () => {
    const { result } = setup();
    act(() => result.current.match("policies", alice, [ADMIN], [READ]));
    expect(labels(result.current.items)).toEqual(["AdministratorAccess 붙이기 · alice", "ReadOnlyAccess 떼기 · alice"]);
  });

  test("the members tab queues into and out of groups", () => {
    const { result } = setup();
    act(() => {
      result.current.toggle("members", bob, "admins");
      result.current.toggle("members", alice, "dev-team");
    });
    expect(labels(result.current.items)).toEqual(["admins에 넣기 · bob", "dev-team에서 빼기 · alice"]);
  });

  test("remove takes out one item by key and clear takes out all of them", () => {
    const { result } = setup();
    act(() => {
      result.current.toggle("policies", bob, READ);
      result.current.toggle("policies", ciBot, READ);
      result.current.toggle("policies", alice, READ);
    });
    act(() => result.current.remove(result.current.items[1].key));
    expect(labels(result.current.items)).toEqual(["ReadOnlyAccess 붙이기 · bob", "ReadOnlyAccess 떼기 · alice"]);
    act(() => result.current.remove("policies|nobody|nothing"));
    expect(result.current.items).toHaveLength(2);
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
  });

  test("removeApplied removes the items whose keys match the applied changes", () => {
    const { result } = setup();
    act(() => {
      result.current.toggle("policies", bob, READ);
      result.current.toggle("policies", ciBot, READ);
      result.current.toggle("policies", alice, READ);
    });
    act(() => result.current.removeApplied([attachReadOnlyToBob, detachReadOnlyFromAlice]));
    expect(labels(result.current.items)).toEqual(["ReadOnlyAccess 붙이기 · ci-bot"]);
  });

  test("without an overview nothing is queued; once it arrives the tray works", () => {
    const { result, rerender } = setup({ profile: "prod", ov: undefined });
    act(() => result.current.toggle("policies", bob, READ));
    expect(result.current.items).toEqual([]);
    expect(result.current.notices).toEqual([]);
    rerender({ profile: "prod", ov });
    act(() => result.current.toggle("policies", bob, READ));
    expect(labels(result.current.items)).toEqual(["ReadOnlyAccess 붙이기 · bob"]);
  });
});

describe("the 50 limit", () => {
  test("the full notice appears once, however many cells did not fit", () => {
    const { users, big, cells } = crowd();
    const { result } = setup({ profile: "prod", ov: big });
    act(() => result.current.paint("policies", cells, true)); // one cell more than the tray holds
    expect(result.current.items).toHaveLength(MAX_DRAFT);
    expect(result.current.items[0].label).toBe("ReadOnlyAccess 붙이기 · user-00");
    expect(result.current.items.some((d) => d.label.endsWith(users[MAX_DRAFT].name))).toBe(false);
    expect(result.current.notices).toEqual([FULL]);
  });

  test("a toggle that does not fit says so, and a second one does not stack the same notice", () => {
    const { users, big, cells } = crowd();
    const { result } = setup({ profile: "prod", ov: big });
    act(() => result.current.paint("policies", cells.slice(0, MAX_DRAFT), true));
    expect(result.current.notices).toEqual([]);
    act(() => result.current.toggle("policies", users[MAX_DRAFT], READ));
    expect(result.current.items).toHaveLength(MAX_DRAFT);
    expect(result.current.notices).toEqual([FULL]);
    act(() => result.current.toggle("policies", users[MAX_DRAFT], READ));
    expect(result.current.notices).toEqual([FULL]);
    // once the user has dismissed it, the next overflow says so again
    act(() => result.current.dismissNotice(0));
    expect(result.current.notices).toEqual([]);
    act(() => result.current.toggle("policies", users[MAX_DRAFT], READ));
    expect(result.current.notices).toEqual([FULL]);
  });
});

describe("when the overview is loaded again", () => {
  test("a pending attach that is now attached is dropped, with a notice", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle("policies", bob, READ));
    rerender({ profile: "prod", ov: reloaded(bob, { attached: [READ] }) });
    expect(result.current.items).toEqual([]);
    expect(result.current.notices).toEqual(["이미 붙어 있어서 뺐어요: ReadOnlyAccess 붙이기 · bob"]);
  });

  test("what is still to be done stays, and later notices are added after earlier ones", () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.toggle("policies", bob, READ);
      result.current.toggle("policies", ciBot, READ);
      result.current.toggle("members", alice, "dev-team");
    });
    rerender({ profile: "prod", ov: reloaded(bob, { attached: [READ] }) });
    expect(labels(result.current.items)).toEqual(["ReadOnlyAccess 붙이기 · ci-bot", "dev-team에서 빼기 · alice"]);
    rerender({ profile: "prod", ov: sampleOverview({ users: [{ ...alice, groups: [] }, bob, ciBot] }) });
    expect(labels(result.current.items)).toEqual(["ReadOnlyAccess 붙이기 · ci-bot"]);
    expect(result.current.notices).toEqual(["이미 붙어 있어서 뺐어요: ReadOnlyAccess 붙이기 · bob", "이미 그룹에 없어서 뺐어요: dev-team에서 빼기 · alice"]);
  });

  test("a change whose principal is gone is dropped as not found", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle("policies", bob, READ));
    rerender({ profile: "prod", ov: sampleOverview({ users: [alice, ciBot] }) });
    expect(result.current.items).toEqual([]);
    expect(result.current.notices).toEqual(["찾을 수 없어서 뺐어요: ReadOnlyAccess 붙이기 · bob"]);
  });

  test("a pending attach of a customer policy the new overview no longer lists is dropped as not found", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle("policies", ciBot, deployPolicy.arn));
    expect(labels(result.current.items)).toEqual(["app-deploy 붙이기 · ci-bot"]);
    rerender({ profile: "prod", ov: sampleOverview({ policies: ov.policies.filter((p) => p.arn !== deployPolicy.arn) }) });
    expect(result.current.items).toEqual([]);
    expect(result.current.notices).toEqual(["찾을 수 없어서 뺐어요: app-deploy 붙이기 · ci-bot"]);
  });

  test("children never see a change the new overview made redundant, not even for one render", () => {
    const seen: string[][] = [];
    let latest!: ReturnType<typeof useAssignmentDraft>;
    function Consumer({ items }: { items: DraftItem[] }) {
      seen.push(labels(items));
      return null;
    }
    function Harness(p: Props) {
      latest = useAssignmentDraft(p.profile, p.ov);
      return <Consumer items={latest.items} />;
    }
    const { rerender } = render(<Harness profile="prod" ov={ov} />);
    act(() => latest.toggle("policies", bob, READ));
    expect(seen[seen.length - 1]).toEqual(["ReadOnlyAccess 붙이기 · bob"]);

    seen.length = 0;
    rerender(<Harness profile="prod" ov={reloaded(bob, { attached: [READ] })} />);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((items) => items.length === 0)).toBe(true);
    expect(latest.notices).toEqual(["이미 붙어 있어서 뺐어요: ReadOnlyAccess 붙이기 · bob"]);
  });

  test("changes made after the cleanup build on the cleaned tray, not on the dropped item", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle("policies", bob, READ));
    rerender({ profile: "prod", ov: reloaded(bob, { attached: [READ] }) });
    act(() => result.current.toggle("policies", ciBot, READ));
    expect(labels(result.current.items)).toEqual(["ReadOnlyAccess 붙이기 · ci-bot"]);
  });

  test("a new overview is applied once when React renders twice (StrictMode)", () => {
    const { result, rerender } = renderHook((p: Props) => useAssignmentDraft(p.profile, p.ov), {
      initialProps: { profile: "prod", ov } as Props,
      wrapper: StrictMode,
    });
    act(() => {
      result.current.toggle("policies", bob, READ);
      result.current.toggle("policies", ciBot, READ);
    });
    rerender({ profile: "prod", ov: reloaded(bob, { attached: [READ] }) });
    expect(labels(result.current.items)).toEqual(["ReadOnlyAccess 붙이기 · ci-bot"]);
    expect(result.current.notices).toEqual(["이미 붙어 있어서 뺐어요: ReadOnlyAccess 붙이기 · bob"]);
  });

  test("an overview that changes nothing for the tray leaves it untouched", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle("policies", bob, READ));
    const before = result.current.items;
    rerender({ profile: "prod", ov: sampleOverview() }); // a new object with the same content
    expect(result.current.items).toBe(before);
    expect(result.current.notices).toEqual([]);
  });

  test("while the overview is missing the tray is kept as it is", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle("policies", bob, READ));
    const before = result.current.items;
    rerender({ profile: "prod", ov: undefined });
    expect(result.current.items).toBe(before);
    expect(result.current.notices).toEqual([]);
  });

  test("dismissNotice removes the notice at that index only", () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.toggle("policies", bob, READ);
      result.current.toggle("members", alice, "dev-team");
    });
    rerender({ profile: "prod", ov: sampleOverview({ users: [{ ...alice, groups: [] }, { ...bob, attached: [READ] }, ciBot] }) });
    expect(result.current.notices).toHaveLength(2);
    act(() => result.current.dismissNotice(0));
    expect(result.current.notices).toEqual(["이미 그룹에 없어서 뺐어요: dev-team에서 빼기 · alice"]);
    act(() => result.current.dismissNotice(5)); // no such notice
    expect(result.current.notices).toHaveLength(1);
  });

  test("clearing the tray leaves the notices to the user to dismiss", () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.toggle("policies", bob, READ);
      result.current.toggle("policies", ciBot, READ);
    });
    rerender({ profile: "prod", ov: reloaded(bob, { attached: [READ] }) });
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
    expect(result.current.notices).toHaveLength(1);
  });
});

describe("the tray belongs to one profile", () => {
  const other = sampleOverview({ users: [alice, ciBot] }); // the other account has no bob

  test("rerendering with another profile empties the tray and shows no notices", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle("policies", bob, READ));
    expect(result.current.items).toHaveLength(1);
    rerender({ profile: "dev", ov: other });
    expect(result.current.items).toEqual([]);
    // bob is not in the other account, but the old item is gone before it can be looked for there
    expect(result.current.notices).toEqual([]);
  });

  test("the old tray is never seen under the new profile, not even for one render", () => {
    const seen: { profile: string; items: number; notices: number }[] = [];
    const { result, rerender } = renderHook(
      (p: Props) => {
        const draft = useAssignmentDraft(p.profile, p.ov);
        seen.push({ profile: p.profile, items: draft.items.length, notices: draft.notices.length });
        return draft;
      },
      { initialProps: { profile: "prod", ov } as Props },
    );
    act(() => result.current.toggle("policies", bob, READ));
    seen.length = 0;
    rerender({ profile: "dev", ov: other });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.profile === "dev" && r.items === 0 && r.notices === 0)).toBe(true);
  });

  test("notices of the old profile go with its tray", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle("policies", bob, READ));
    rerender({ profile: "prod", ov: reloaded(bob, { attached: [READ] }) });
    expect(result.current.notices).toHaveLength(1);
    rerender({ profile: "dev", ov: other });
    expect(result.current.notices).toEqual([]);
  });

  test("the new profile's tray works as usual, and going back does not bring the old one back", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle("policies", bob, READ));
    rerender({ profile: "dev", ov: other });
    act(() => result.current.toggle("policies", ciBot, READ));
    expect(labels(result.current.items)).toEqual(["ReadOnlyAccess 붙이기 · ci-bot"]);
    rerender({ profile: "prod", ov });
    expect(result.current.items).toEqual([]);
  });

  test("a switch while the new overview is still loading also starts empty", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggle("policies", bob, READ));
    rerender({ profile: "dev", ov: undefined });
    expect(result.current.items).toEqual([]);
    rerender({ profile: "dev", ov: other });
    expect(result.current.items).toEqual([]);
    expect(result.current.notices).toEqual([]);
  });
});
