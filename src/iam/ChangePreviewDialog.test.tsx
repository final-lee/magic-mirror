import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { alice, attachReadOnlyToBob, bob, cappedImpact, deactivateBobKey, devTeam, impactOf, permDelta, PLAN_DRIFTED, previewOf } from "./fixtures";
import { ChangePreviewDialog } from "./ChangePreviewDialog";
import type { PendingChange } from "./useIamChange";
import type { ChangePreview } from "./types";

// 영향 줄을 그릴 때마다 접근 수준 이름을 읽는다. 읽은 횟수로 영향 목록을 다시 그렸는지 본다(값은 그대로 돌려준다)
const labelReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("./labels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./labels")>();
  const LEVEL_LABEL = new Proxy(actual.LEVEL_LABEL, {
    get(target, key, receiver) {
      labelReads.count++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { ...actual, LEVEL_LABEL };
});

function pendingOf(preview: ChangePreview | null, extra: Partial<PendingChange> = {}): PendingChange {
  return {
    profile: "prod",
    change: preview?.change ?? attachReadOnlyToBob,
    undoOf: null,
    rev: 1,
    phase: "ready",
    preview,
    error: null,
    stale: false,
    ...extra,
  };
}

function setup(preview: ChangePreview | null, extra: Partial<PendingChange> = {}) {
  const props = { onApply: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn() };
  const utils = render(<ChangePreviewDialog pending={pendingOf(preview, extra)} {...props} />);
  const rerender = (next: PendingChange) => utils.rerender(<ChangePreviewDialog pending={next} {...props} />);
  return { props, ...utils, rerender };
}

const applyButton = () => screen.getByRole("button", { name: /^적용/ });
const cancelButton = () => screen.getByRole("button", { name: "취소" });
const confirmInput = (name: string) => screen.getByLabelText(`확인하려면 ${name}를 입력하세요`);
const confirmPreview = (extra: Partial<ChangePreview> = {}) =>
  previewOf(attachReadOnlyToBob, { warnings: [{ level: "confirm", message: "지금 쓰는 자격 증명의 권한이 줄어요" }], confirmText: "bob", ...extra });

describe("content", () => {
  test("shows the summary, the API calls with their parameters and that the change can be undone", () => {
    setup(
      previewOf(attachReadOnlyToBob, {
        summary: "bob에 ReadOnlyAccess를 붙여요",
        calls: [
          { api: "iam:AttachUserPolicy", params: { UserName: "bob", PolicyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess" } },
          { api: "iam:ListAttachedUserPolicies", params: {} },
        ],
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "변경 미리보기" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByText("bob에 ReadOnlyAccess를 붙여요")).toBeInTheDocument();
    const calls = within(screen.getByRole("list", { name: "호출할 API" })).getAllByRole("listitem");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveTextContent("iam:AttachUserPolicy");
    expect(calls[0]).toHaveTextContent("UserName");
    expect(calls[0]).toHaveTextContent("bob");
    expect(calls[0]).toHaveTextContent("arn:aws:iam::aws:policy/ReadOnlyAccess");
    expect(screen.getByText("되돌릴 수 있어요")).toBeInTheDocument();
  });

  test("says clearly when the change cannot be undone, without claiming the change log cannot undo it either", () => {
    setup(previewOf({ op: "deleteAccessKey", userName: "bob", accessKeyId: "AKIA" }, { reversible: false }));
    expect(screen.getByText("되돌릴 수 없어요")).toBeInTheDocument();
    expect(screen.queryByText("되돌릴 수 있어요")).not.toBeInTheDocument();
    expect(screen.queryByText(/변경 기록에서도/)).not.toBeInTheDocument();
  });

  test("an undo is labelled as one", () => {
    setup(previewOf(deactivateBobKey), { undoOf: "log-1" });
    expect(screen.getByRole("dialog", { name: "되돌리기 미리보기" })).toBeInTheDocument();
  });

  test("a very long parameter value (a policy document) is shown whole but scrolls inside its own box", () => {
    const doc = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "*" }] });
    setup(previewOf(attachReadOnlyToBob, { calls: [{ api: "iam:PutUserPolicy", params: { PolicyName: "p", PolicyDocument: doc } }] }));
    expect(screen.getByText(doc)).toHaveClass("cp-val");
  });
});

describe("warnings", () => {
  test("groups warnings by level: blocking first, then confirm, then warn", () => {
    setup(
      previewOf(attachReadOnlyToBob, {
        warnings: [
          { level: "warn", message: "영향받는 주체가 5명 이상이에요" },
          { level: "block", message: "서비스 연결 역할은 바꿀 수 없어요" },
          { level: "confirm", message: "지금 쓰는 자격 증명의 권한이 줄어요" },
          { level: "warn", message: "CloudFormation 스택이 되돌릴 수 있어요" },
        ],
        confirmText: "bob",
      }),
    );
    const groups = screen.getAllByTestId("cp-warnings").map((g) => g.getAttribute("data-level"));
    expect(groups).toEqual(["block", "confirm", "warn"]);
    const block = screen.getByRole("alert");
    expect(block).toHaveTextContent("서비스 연결 역할은 바꿀 수 없어요");
    expect(block).toHaveClass("block");
    const warn = screen.getAllByTestId("cp-warnings")[2];
    expect(warn).toHaveClass("warn");
    expect(within(warn).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "영향받는 주체가 5명 이상이에요",
      "CloudFormation 스택이 되돌릴 수 있어요",
    ]);
    expect(screen.getAllByTestId("cp-warnings")[1]).toHaveClass("confirm");
  });

  test("a preview without warnings shows no warning area and no confirm field", () => {
    setup(previewOf(attachReadOnlyToBob));
    expect(screen.queryByTestId("cp-warnings")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("applying", () => {
  test("a clean preview can be applied with one click, in the primary style", () => {
    const { props } = setup(previewOf(attachReadOnlyToBob));
    expect(applyButton()).toBeEnabled();
    expect(applyButton()).toHaveClass("primary");
    expect(applyButton()).not.toHaveClass("danger");
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledWith("");
  });

  test("a warn warning keeps the apply enabled but turns it into the danger style", () => {
    const { props } = setup(previewOf(attachReadOnlyToBob, { warnings: [{ level: "warn", message: "5명 이상" }] }));
    expect(applyButton()).toBeEnabled();
    expect(applyButton()).toHaveClass("danger");
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledTimes(1);
  });

  test("a block warning disables the apply, explains why, and ignores clicks", () => {
    const { props } = setup(previewOf(attachReadOnlyToBob, { warnings: [{ level: "block", message: "서비스 연결 역할이에요" }] }));
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("막힘 경고가 있어서 적용할 수 없어요")).toBeInTheDocument();
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("a block warning stays disabled even with the confirm text typed correctly", () => {
    const { props } = setup(
      previewOf(attachReadOnlyToBob, {
        warnings: [
          { level: "block", message: "막혔어요" },
          { level: "confirm", message: "확인하세요" },
        ],
        confirmText: "bob",
      }),
    );
    fireEvent.change(confirmInput("bob"), { target: { value: "bob" } });
    expect(applyButton()).toBeDisabled();
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();
  });
});

describe("type to confirm", () => {
  test("asks for the name and keeps the apply disabled until it matches exactly", () => {
    const { props } = setup(confirmPreview());
    expect(applyButton()).toBeDisabled();
    expect(applyButton()).toHaveClass("danger");
    const input = confirmInput("bob");
    for (const wrong of ["b", "Bob", "BOB", "bob ", " bob", "bobb", "alice"]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(applyButton()).toBeDisabled();
    }
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "bob" } });
    expect(applyButton()).toBeEnabled();
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledTimes(1);
    expect(props.onApply).toHaveBeenCalledWith("bob");
  });

  test("hints when what was typed differs, but not before anything was typed or while a correct start is being typed", () => {
    setup(confirmPreview());
    const hint = () => screen.queryByText("입력한 이름이 달라요");
    expect(hint()).not.toBeInTheDocument();
    fireEvent.change(confirmInput("bob"), { target: { value: "bo" } });
    expect(hint()).not.toBeInTheDocument();
    for (const wrong of ["bx", "Bo", " b", "bobb"]) {
      fireEvent.change(confirmInput("bob"), { target: { value: wrong } });
      expect(hint()).toBeInTheDocument();
    }
    fireEvent.change(confirmInput("bob"), { target: { value: "bob" } });
    expect(hint()).not.toBeInTheDocument();
  });

  test("Enter in the field never applies, not even with the right text", () => {
    const { props } = setup(confirmPreview());
    const input = confirmInput("bob");
    fireEvent.change(input, { target: { value: "bob" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  test("a confirm text with no confirm warning still has to be typed", () => {
    const { props } = setup(previewOf(attachReadOnlyToBob, { confirmText: "bob" }));
    expect(applyButton()).toBeDisabled();
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("a confirm warning without any text to type cannot be applied", () => {
    const { props } = setup(confirmPreview({ confirmText: null }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("확인 문구를 받지 못해서 적용할 수 없어요")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("what was typed is dropped when a fresh preview arrives", () => {
    const { rerender } = setup(confirmPreview());
    fireEvent.change(confirmInput("bob"), { target: { value: "bob" } });
    expect(applyButton()).toBeEnabled();
    rerender(pendingOf(confirmPreview(), { rev: 2 }));
    expect(confirmInput("bob")).toHaveValue("");
    expect(applyButton()).toBeDisabled();
  });
});

describe("keyboard and focus", () => {
  test("the focus starts on 취소, never on the apply, and Escape cancels", async () => {
    const { props } = setup(confirmPreview());
    expect(cancelButton()).toHaveFocus();
    expect(applyButton()).not.toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  test("Enter on the focused 취소 cancels instead of applying", async () => {
    const { props } = setup(previewOf(attachReadOnlyToBob));
    await userEvent.keyboard("{Enter}");
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("Tab stays inside the dialog", async () => {
    setup(confirmPreview());
    // 순서: 입력 → 취소 → (적용은 꺼져 있어서 건너뜀) → 다시 입력
    await userEvent.tab();
    expect(confirmInput("bob")).toHaveFocus();
    await userEvent.tab();
    expect(cancelButton()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirmInput("bob")).toHaveFocus();
    await userEvent.tab({ shift: true }); // 맨 앞에서 거꾸로 가면 마지막(취소)으로 돈다
    expect(cancelButton()).toHaveFocus();
  });

  test("a dialog inside a hidden tab does not react to Escape, and a hidden dialog does not shadow a visible one", async () => {
    const { props } = setup(previewOf(attachReadOnlyToBob));
    const hiddenCancel = vi.fn();
    const hiddenHost = render(
      <div hidden>
        <ChangePreviewDialog pending={pendingOf(previewOf(attachReadOnlyToBob))} onApply={vi.fn()} onRetry={vi.fn()} onCancel={hiddenCancel} />
      </div>,
    );
    // 숨겨진 탭의 창이 DOM에서 더 뒤에 있어도 보이는 창이 Esc를 받고, 숨겨진 창은 받지 않는다
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(hiddenCancel).not.toHaveBeenCalled();
    hiddenHost.unmount();
  });

  test("only the topmost dialog reacts to Escape", async () => {
    const { props } = setup(previewOf(attachReadOnlyToBob));
    const other = document.body.appendChild(document.createElement("div"));
    other.className = "modal";
    await userEvent.keyboard("{Escape}");
    expect(props.onCancel).not.toHaveBeenCalled();
    other.remove();
    await userEvent.keyboard("{Escape}");
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("loading, errors and progress", () => {
  test("while the preview loads, only cancel works", () => {
    const { props } = setup(null, { phase: "loading" });
    expect(screen.getByText("미리보기를 불러오는 중이에요…")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(cancelButton());
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  test("a failed preview shows the error and offers to ask again; there is nothing to apply", () => {
    const { props } = setup(null, { error: { kind: "preview", message: "권한 없음 (iam:GetPolicy)" } });
    expect(screen.getByText("권한 없음 (iam:GetPolicy)")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 다시 받기" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  test("when IAM changed after the preview, the backend's refusal asks for a fresh preview", () => {
    const { props } = setup(previewOf(attachReadOnlyToBob), { error: { kind: "apply", message: PLAN_DRIFTED }, stale: true });
    expect(within(screen.getByRole("alert")).getByText(PLAN_DRIFTED)).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 다시 받기" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("a failed apply keeps the preview, shows the error, and needs a fresh preview before applying again", () => {
    const { props } = setup(previewOf(attachReadOnlyToBob, { summary: "bob에 붙여요" }), {
      error: { kind: "apply", message: "정책이 이미 붙어 있어요" },
      stale: true,
    });
    expect(screen.getByText("정책이 이미 붙어 있어요")).toBeInTheDocument();
    expect(screen.getByText("bob에 붙여요")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText(/상태가 바뀌었을 수 있어서/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 다시 받기" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  test("errors sit next to the buttons, outside the scrolling body, so a long preview cannot hide them", () => {
    setup(previewOf(attachReadOnlyToBob), { error: { kind: "apply", message: "실패했어요" }, stale: true });
    const alert = screen.getByText("실패했어요").closest('[role="alert"]') as HTMLElement;
    expect(alert).toBeInTheDocument();
    expect(alert.closest(".cp-body")).toBeNull();
    expect(screen.getByText("바뀌었을 수 있어서", { exact: false }).closest(".cp-body")).toBeNull();
  });

  test("after a failed apply the focus moves to 미리보기 다시 받기 instead of being lost with the locked buttons", () => {
    const { rerender } = setup(previewOf(attachReadOnlyToBob), { phase: "applying" });
    expect(cancelButton()).toBeDisabled();
    rerender(pendingOf(previewOf(attachReadOnlyToBob), { phase: "ready", error: { kind: "apply", message: "실패" }, stale: true }));
    expect(screen.getByRole("button", { name: "미리보기 다시 받기" })).toHaveFocus();
  });

  test("while applying, the confirm field is locked too", () => {
    setup(confirmPreview(), { phase: "applying" });
    expect(confirmInput("bob")).toBeDisabled();
  });

  test("while applying, the buttons are locked and Escape does nothing", async () => {
    const { props } = setup(previewOf(attachReadOnlyToBob), { phase: "applying" });
    expect(screen.getByRole("button", { name: "적용 중…" })).toBeDisabled();
    expect(cancelButton()).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});

describe("impacts", () => {
  const impactPreview = () =>
    previewOf(attachReadOnlyToBob, {
      impacts: [
        {
          principal: bob,
          gained: [permDelta("s3", "read", 40, ["s3:GetObject", "s3:ListBucket"]), permDelta("ec2", "list", 3)],
          lost: [permDelta("iam", "write", 12, ["iam:CreateUser", "iam:DeleteUser", "iam:PutUserPolicy", "iam:TagUser", "iam:UntagUser"])],
        },
        { principal: devTeam, gained: [permDelta("sqs", "write", 1, ["sqs:SendMessage"])], lost: [] },
      ],
    });

  test("lists each affected principal with what it gains (green) and loses (red)", () => {
    setup(impactPreview());
    expect(screen.getByRole("list", { name: "영향받는 주체" })).toBeInTheDocument();
    const bobItem = screen.getByTestId(`impact-${bob.arn}`);
    expect(within(bobItem).getByText("bob")).toBeInTheDocument();
    expect(within(bobItem).getByText("사용자")).toBeInTheDocument();
    const gained = within(bobItem).getByTestId("gained");
    expect(gained).toHaveClass("cp-gain");
    expect(gained).toHaveTextContent("s3");
    expect(gained).toHaveTextContent("읽기");
    expect(gained).toHaveTextContent("40개");
    expect(gained).toHaveTextContent("s3:GetObject, s3:ListBucket");
    expect(gained).toHaveTextContent("ec2");
    expect(gained).toHaveTextContent("목록");
    expect(gained).toHaveTextContent("3개");
    const lost = within(bobItem).getByTestId("lost");
    expect(lost).toHaveClass("cp-lose");
    expect(lost).toHaveTextContent("iam");
    expect(lost).toHaveTextContent("쓰기");
    expect(lost).toHaveTextContent("12개");
    expect(lost).toHaveTextContent("iam:CreateUser, iam:DeleteUser, iam:PutUserPolicy, iam:TagUser, iam:UntagUser");
    expect(lost).toHaveTextContent("외 7개"); // 12 - 샘플 5

    const groupItem = screen.getByTestId(`impact-${devTeam.arn}`);
    expect(within(groupItem).getByText("그룹")).toBeInTheDocument();
    expect(within(groupItem).queryByTestId("lost")).not.toBeInTheDocument();
  });

  test("says when no principal's permissions change, and that changes limited to some resources do not show here", () => {
    setup(previewOf(attachReadOnlyToBob, { impacts: [] }));
    const empty = screen.getByText(/권한이 달라지는 주체가 없어요/);
    expect(empty).toHaveTextContent("서비스·접근 수준 단위로는 권한이 달라지는 주체가 없어요");
    expect(empty).toHaveTextContent("일부 리소스에만 걸리는 변화는 이 목록에 나오지 않아요");
  });

  test("a principal with neither gains nor losses says so", () => {
    setup(previewOf(attachReadOnlyToBob, { impacts: [{ principal: alice, gained: [], lost: [] }] }));
    expect(within(screen.getByTestId(`impact-${alice.arn}`)).getByText("권한 변화 없음")).toBeInTheDocument();
  });

  test("caps a long list of principals and tells how many were left out", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ principal: { ...bob, arn: `arn:aws:iam::123456789012:user/u${i}`, name: `u${i}` }, gained: [permDelta("s3", "read", 1)], lost: [] }));
    setup(previewOf(attachReadOnlyToBob, { impacts: many }));
    expect(screen.getByText("외 10명")).toBeInTheDocument();
    expect(screen.getByText("u29")).toBeInTheDocument();
    expect(screen.queryByText("u30")).not.toBeInTheDocument();
  });

  const thirty = () => Array.from({ length: 30 }, (_, i) => impactOf({ ...bob, arn: `arn:aws:iam::123456789012:user/u${i}`, name: `u${i}` }, { gained: [permDelta("s3", "read", 1)] }));
  const lastRow = (list: HTMLElement) => {
    const rows = within(list).getAllByRole("listitem");
    return rows[rows.length - 1];
  };

  test("counts the principals the backend did not send in detail", () => {
    setup(previewOf(attachReadOnlyToBob, { impacts: thirty(), impactsOmitted: 20 }));
    expect(screen.getByRole("heading", { name: /영향받는 주체/ })).toHaveTextContent("50");
    expect(screen.getByText("외 20명")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "영향받는 주체" })).getAllByTestId(/^impact-/)).toHaveLength(30);
  });

  test("a preview without the omitted count shows every principal it got", () => {
    setup(previewOf(attachReadOnlyToBob, { impacts: thirty() }));
    expect(screen.getByRole("heading", { name: /영향받는 주체/ })).toHaveTextContent("30");
    expect(screen.queryByText(/^외 \d+명$/)).not.toBeInTheDocument();
  });

  test("tells how many rows were left out in each direction", () => {
    const big = cappedImpact(alice);
    setup(previewOf(attachReadOnlyToBob, { impacts: [{ ...big, lost: [permDelta("ec2", "write", 300)], lostOmitted: 7 }] }));
    const item = screen.getByTestId(`impact-${alice.arn}`);
    const gained = within(item).getByTestId("gained");
    expect(within(gained).getAllByRole("listitem")).toHaveLength(21);
    // 줄마다 붙는 "외 N개"(그 줄의 작업 수)와 다르게, 빠진 것은 (서비스, 수준) 줄이라고 적는다
    expect(lastRow(gained)).toHaveTextContent(/^서비스·수준 1630개 더$/);
    expect(lastRow(within(item).getByTestId("lost"))).toHaveTextContent(/^서비스·수준 7개 더$/);
  });

  test("shows actions that become conditional under their own label", () => {
    const restricted = [permDelta("s3", "read", 40, ["s3:GetObject"]), permDelta("ec2", "write", 300)];
    setup(previewOf(attachReadOnlyToBob, { impacts: [impactOf(alice, { restricted, restrictedOmitted: 3 })] }));
    const item = screen.getByTestId(`impact-${alice.arn}`);
    expect(within(item).getByText("조건부로 바뀜", { selector: "div" })).toBeInTheDocument();
    const list = within(item).getByRole("list", { name: "조건부로 바뀜" });
    expect(list).toHaveClass("cp-cond");
    expect(list).toHaveTextContent("s3");
    expect(list).toHaveTextContent("40개");
    expect(list).toHaveTextContent("s3:GetObject");
    expect(lastRow(list)).toHaveTextContent(/^서비스·수준 3개 더$/);
    expect(within(item).queryByText("권한 변화 없음")).not.toBeInTheDocument();
    expect(within(item).queryByTestId("gained")).not.toBeInTheDocument();
  });

  test("typing the confirm text does not redraw the impact list", () => {
    labelReads.count = 0;
    setup(confirmPreview({ impacts: [cappedImpact(alice), impactOf(bob, { restricted: [permDelta("s3", "read", 4)] })] }));
    const drawn = labelReads.count;
    expect(drawn).toBeGreaterThanOrEqual(21); // 줄 21개를 한 번은 그렸다
    for (const value of ["b", "bo", "bob"]) fireEvent.change(confirmInput("bob"), { target: { value } });
    expect(applyButton()).toBeEnabled();
    expect(labelReads.count).toBe(drawn);
  });
});
