import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { iamApi } from "./api";
import { BatchPreviewDialog } from "./BatchPreviewDialog";
import { alice, attachReadOnlyToBob, batchResult, bob, cappedImpact, ciBot, detachReadOnlyFromAlice, impactOf, permDelta, PLAN_DRIFTED, previewBatchOf, readOnlyPolicy } from "./fixtures";
import type { BatchItem, BatchPreview, BatchResult, IamChange, UndoBatch } from "./types";
import type { PendingBatch } from "./useIamBatch";

vi.mock("./api", () => ({ iamApi: { undoBatch: vi.fn() } }));
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

const m = vi.mocked(iamApi);

const attachBob = attachReadOnlyToBob;
const attachCi: IamChange = { op: "attachPolicy", target: ciBot.arn, policyArn: readOnlyPolicy.arn };
const detachAlice = detachReadOnlyFromAlice;

const item = (change: IamChange, summary: string, extra: Partial<BatchItem> = {}): BatchItem => ({
  change,
  summary,
  calls: [{ api: "iam:AttachUserPolicy", params: { UserName: "bob", PolicyArn: readOnlyPolicy.arn } }],
  warnings: [],
  ...extra,
});
const batchOf = (items: BatchItem[], extra: Partial<BatchPreview> = {}): BatchPreview => ({ ...previewBatchOf([]), changes: items, ...extra });
/** 적용 순서대로: 붙이기 둘, 떼기 하나 */
const threeItems = (): BatchItem[] => [
  item(attachBob, "bob에 ReadOnlyAccess를 붙여요"),
  item(attachCi, "ci-bot에 ReadOnlyAccess를 붙여요"),
  item(detachAlice, "alice에서 ReadOnlyAccess를 떼요", { calls: [{ api: "iam:DetachUserPolicy", params: { UserName: "alice", PolicyArn: readOnlyPolicy.arn } }] }),
];
const preview3 = (extra: Partial<BatchPreview> = {}) => batchOf(threeItems(), extra);
const CONFIRM = "변경 3개 적용";
const confirmPreview = (extra: Partial<BatchPreview> = {}) =>
  preview3({ warnings: [{ level: "confirm", message: "관리자급 권한을 새로 얻는 주체: ci-bot" }], confirmText: CONFIRM, ...extra });

function pendingOf(preview: BatchPreview | null, extra: Partial<PendingBatch> = {}): PendingBatch {
  return {
    profile: "prod",
    changes: preview?.changes.map((i) => i.change) ?? [attachBob],
    undoOf: null,
    rev: 1,
    phase: "ready",
    preview,
    error: null,
    stale: false,
    result: null,
    ...extra,
  };
}

function setup(preview: BatchPreview | null, extra: Partial<PendingBatch> = {}) {
  const props = { onApply: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn(), onStart: vi.fn() };
  const utils = render(<BatchPreviewDialog pending={pendingOf(preview, extra)} {...props} />);
  const rerender = (next: PendingBatch) => utils.rerender(<BatchPreviewDialog pending={next} {...props} />);
  return { props, ...utils, rerender };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

const applyButton = () => screen.getByRole("button", { name: /^적용( 중…)?$/ });
const cancelButton = () => screen.getByRole("button", { name: "취소" });
const confirmInput = (text = CONFIRM) => screen.getByLabelText(`확인하려면 ${text}를 입력하세요`);
const rowsOfList = () => Array.from(screen.getByRole("list", { name: "변경 목록" }).children) as HTMLElement[];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("content", () => {
  test("the title counts the changes", () => {
    setup(preview3());
    const dialog = screen.getByRole("dialog", { name: "변경 3개 미리보기" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("heading", { name: "변경 3개 미리보기" })).toBeInTheDocument();
  });

  test("while the preview loads, the title already counts the queued changes", () => {
    setup(null, { phase: "loading", changes: [attachBob, attachCi] });
    expect(screen.getByRole("dialog", { name: "변경 2개 미리보기" })).toBeInTheDocument();
    expect(screen.getByText("미리보기를 불러오는 중이에요…")).toBeInTheDocument();
  });

  test("lists the changes in the order of the preview, each numbered, with its summary", () => {
    setup(preview3());
    const rows = rowsOfList();
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("bob에 ReadOnlyAccess를 붙여요")).toBeInTheDocument();
    expect(within(rows[1]).getByText("ci-bot에 ReadOnlyAccess를 붙여요")).toBeInTheDocument();
    expect(within(rows[2]).getByText("alice에서 ReadOnlyAccess를 떼요")).toBeInTheDocument();
    expect(rows.map((r) => within(r).getByText(/^\d+$/).textContent)).toEqual(["1", "2", "3"]);
  });

  test("the calls of a change are folded under a toggle, and each toggle opens only its own", () => {
    setup(preview3());
    const rows = rowsOfList();
    expect(screen.queryByRole("list", { name: "호출할 API" })).not.toBeInTheDocument();

    const toggle = within(rows[2]).getByRole("button", { name: "호출할 API 1개" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const calls = within(rows[2]).getByRole("list", { name: "호출할 API" });
    expect(calls).toHaveTextContent("iam:DetachUserPolicy");
    expect(calls).toHaveTextContent("UserName");
    expect(calls).toHaveTextContent("alice");
    expect(calls).toHaveTextContent(readOnlyPolicy.arn);
    expect(within(rows[0]).queryByRole("list", { name: "호출할 API" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("list", { name: "호출할 API" })).toHaveLength(1);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "호출할 API" })).not.toBeInTheDocument();
  });

  test("the toggle says how many calls a change makes, and a change without calls has none", () => {
    setup(
      batchOf([
        item(attachBob, "bob에 붙여요", { calls: [{ api: "iam:ListPolicyVersions", params: {} }, { api: "iam:AttachUserPolicy", params: { UserName: "bob" } }] }),
        item(attachCi, "ci-bot에 붙여요", { calls: [] }),
      ]),
    );
    const rows = rowsOfList();
    expect(within(rows[0]).getByRole("button", { name: "호출할 API 2개" })).toBeInTheDocument();
    expect(within(rows[1]).queryByRole("button")).not.toBeInTheDocument();
  });

  test("each change shows its own warnings inside it, and a change without warnings shows none", () => {
    setup(
      batchOf([
        item(attachBob, "bob에 붙여요", { warnings: [{ level: "warn", message: "bob은 이미 정책이 많아요" }] }),
        item(attachCi, "ci-bot에 붙여요"),
        item(detachAlice, "alice에서 떼요", { warnings: [{ level: "confirm", message: "alice의 권한이 줄어요" }] }),
      ]),
    );
    const rows = rowsOfList();
    expect(within(rows[0]).getByText("bob은 이미 정책이 많아요")).toBeInTheDocument();
    expect(within(rows[1]).queryByTestId("cp-warnings")).not.toBeInTheDocument();
    expect(within(rows[2]).getByText("alice의 권한이 줄어요")).toBeInTheDocument();
    expect(within(rows[2]).getByTestId("cp-warnings")).toHaveAttribute("data-level", "confirm");
  });

  test("the warnings of the batch itself sit above the changes, grouped by level like the single preview", () => {
    setup(
      preview3({
        warnings: [
          { level: "warn", message: "새 관리자급 주체가 생겨요" },
          { level: "block", message: "같은 대상을 바꾸는 변경이 겹쳐요" },
          { level: "confirm", message: "지금 쓰는 자격 증명의 권한이 줄어요" },
        ],
        confirmText: CONFIRM,
      }),
    );
    const groups = screen.getAllByTestId("cp-warnings");
    expect(groups.map((g) => g.getAttribute("data-level"))).toEqual(["block", "confirm", "warn"]);
    expect(screen.getByRole("alert")).toHaveTextContent("같은 대상을 바꾸는 변경이 겹쳐요");
    const list = screen.getByRole("list", { name: "변경 목록" });
    for (const g of groups) {
      expect(list).not.toContainElement(g);
      expect(g.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  test("shows the principals the whole batch affects and what each gains and loses", () => {
    setup(
      preview3({
        impacts: [
          impactOf(bob, { gained: [permDelta("s3", "read", 40, ["s3:GetObject", "s3:ListBucket"])] }),
          impactOf(alice, { lost: [permDelta("ec2", "write", 12, ["ec2:RunInstances"])] }),
        ],
      }),
    );
    expect(screen.getByRole("heading", { name: /영향받는 주체/ })).toHaveTextContent("2");
    const bobItem = screen.getByTestId(`impact-${bob.arn}`);
    expect(within(bobItem).getByTestId("gained")).toHaveTextContent("s3:GetObject, s3:ListBucket");
    expect(within(screen.getByTestId(`impact-${alice.arn}`)).getByTestId("lost")).toHaveTextContent("ec2:RunInstances");
  });

  test("tells how many principals and rows the backend left out, like the single preview", () => {
    setup(preview3({ impacts: [cappedImpact(alice)], impactsOmitted: 20 }));
    expect(screen.getByRole("heading", { name: /영향받는 주체/ })).toHaveTextContent("21");
    expect(screen.getByText("외 20명")).toBeInTheDocument();
    expect(screen.getByText("서비스·수준 1630개 더")).toBeInTheDocument();
  });

  test("says when no principal's permissions change", () => {
    setup(preview3({ impacts: [] }));
    expect(screen.getByText(/권한이 달라지는 주체가 없어요/)).toBeInTheDocument();
  });

  test("says whether the batch can be undone", () => {
    const { unmount } = setup(preview3({ reversible: true }));
    expect(screen.getByText("되돌릴 수 있어요")).toBeInTheDocument();
    unmount();
    setup(preview3({ reversible: false }));
    expect(screen.getByText("되돌릴 수 없어요")).toBeInTheDocument();
    expect(screen.queryByText(/변경 기록에서도/)).not.toBeInTheDocument();
  });

  test("an empty batch has no list of changes, only the reason the backend gave", () => {
    setup(batchOf([], { warnings: [{ level: "block", message: "적용할 변경이 없어요" }] }));
    expect(screen.getByRole("dialog", { name: "변경 0개 미리보기" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "변경 목록" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("적용할 변경이 없어요");
    expect(applyButton()).toBeDisabled();
  });
});

describe("applying", () => {
  test("a clean batch can be applied with one click, in the primary style", () => {
    const { props } = setup(preview3());
    expect(applyButton()).toBeEnabled();
    expect(applyButton()).toHaveClass("primary");
    expect(applyButton()).not.toHaveClass("danger");
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledWith("");
  });

  test("a warn warning, on the batch or on one change, keeps the apply enabled but turns it into the danger style", () => {
    const { unmount } = setup(preview3({ warnings: [{ level: "warn", message: "5명 이상" }] }));
    expect(applyButton()).toBeEnabled();
    expect(applyButton()).toHaveClass("danger");
    unmount();

    const items = threeItems();
    items[1] = { ...items[1], warnings: [{ level: "warn", message: "ci-bot은 관리자급이에요" }] };
    const { props } = setup(batchOf(items));
    expect(applyButton()).toBeEnabled();
    expect(applyButton()).toHaveClass("danger");
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledTimes(1);
  });

  test("a block warning on the batch disables the apply, explains why, and ignores clicks", () => {
    const { props } = setup(preview3({ warnings: [{ level: "block", message: "한 번에 50개까지 적용할 수 있어요" }] }));
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("막힘 경고가 있어서 적용할 수 없어요")).toBeInTheDocument();
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("a block warning on a single change blocks the whole batch", () => {
    const items = threeItems();
    items[2] = { ...items[2], warnings: [{ level: "block", message: "서비스 연결 역할은 바꿀 수 없어요" }] };
    const { props } = setup(batchOf(items));
    expect(within(rowsOfList()[2]).getByRole("alert")).toHaveTextContent("서비스 연결 역할은 바꿀 수 없어요");
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("막힘 경고가 있어서 적용할 수 없어요")).toBeInTheDocument();
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("a block warning stays disabled even with the confirm text typed correctly", () => {
    const { props } = setup(confirmPreview({ warnings: [{ level: "block", message: "막혔어요" }, { level: "confirm", message: "확인하세요" }] }));
    fireEvent.change(confirmInput(), { target: { value: CONFIRM } });
    expect(applyButton()).toBeDisabled();
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();
  });
});

describe("type to confirm", () => {
  test("many targets ask for 변경 N개 적용 and keep the apply disabled until it matches exactly", () => {
    const { props } = setup(confirmPreview());
    expect(applyButton()).toBeDisabled();
    expect(applyButton()).toHaveClass("danger");
    const input = confirmInput();
    for (const wrong of ["변경", "변경 3개 적용 ", " 변경 3개 적용", "변경 2개 적용", "변경 3개 적용!", "BOB"]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(applyButton()).toBeDisabled();
    }
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: CONFIRM } });
    expect(applyButton()).toBeEnabled();
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledTimes(1);
    expect(props.onApply).toHaveBeenCalledWith(CONFIRM);
  });

  test("a single target asks for its name instead", () => {
    const { props } = setup(confirmPreview({ confirmText: "bob" }));
    expect(screen.queryByLabelText(`확인하려면 ${CONFIRM}를 입력하세요`)).not.toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.change(confirmInput("bob"), { target: { value: "Bob" } });
    expect(applyButton()).toBeDisabled();
    fireEvent.change(confirmInput("bob"), { target: { value: "bob" } });
    expect(applyButton()).toBeEnabled();
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledWith("bob");
  });

  test("a confirm warning on one change alone asks for the text of the batch", () => {
    const items = threeItems();
    items[0] = { ...items[0], warnings: [{ level: "confirm", message: "bob의 권한이 줄어요" }] };
    setup(batchOf(items, { confirmText: "변경 3개 적용" }));
    expect(applyButton()).toBeDisabled();
    fireEvent.change(confirmInput(), { target: { value: CONFIRM } });
    expect(applyButton()).toBeEnabled();
  });

  test("hints when what was typed differs, but not before anything was typed or while a correct start is being typed", () => {
    setup(confirmPreview());
    const hint = () => screen.queryByText("입력한 이름이 달라요");
    expect(hint()).not.toBeInTheDocument();
    fireEvent.change(confirmInput(), { target: { value: "변경 3" } });
    expect(hint()).not.toBeInTheDocument();
    fireEvent.change(confirmInput(), { target: { value: "변경 4" } });
    expect(hint()).toBeInTheDocument();
    fireEvent.change(confirmInput(), { target: { value: CONFIRM } });
    expect(hint()).not.toBeInTheDocument();
  });

  test("Enter in the field never applies, not even with the right text", () => {
    const { props } = setup(confirmPreview());
    const input = confirmInput();
    fireEvent.change(input, { target: { value: CONFIRM } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
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
    fireEvent.change(confirmInput(), { target: { value: CONFIRM } });
    expect(applyButton()).toBeEnabled();
    rerender(pendingOf(confirmPreview(), { rev: 2 }));
    expect(confirmInput()).toHaveValue("");
    expect(applyButton()).toBeDisabled();
  });

  test("typing the confirm text does not redraw the changes or the impact list", () => {
    labelReads.count = 0;
    setup(confirmPreview({ impacts: [cappedImpact(alice), impactOf(bob, { restricted: [permDelta("s3", "read", 4)] })] }));
    const rows = rowsOfList();
    fireEvent.click(within(rows[0]).getByRole("button", { name: "호출할 API 1개" }));
    const drawn = labelReads.count;
    expect(drawn).toBeGreaterThanOrEqual(21);
    for (const value of ["변", "변경", CONFIRM]) fireEvent.change(confirmInput(), { target: { value } });
    expect(applyButton()).toBeEnabled();
    expect(labelReads.count).toBe(drawn);
    // 펼쳐 둔 호출은 그대로다
    expect(within(rowsOfList()[0]).getByRole("list", { name: "호출할 API" })).toBeInTheDocument();
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
    const { props } = setup(preview3());
    await userEvent.keyboard("{Enter}");
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("Tab stays inside the dialog", async () => {
    setup(confirmPreview({ changes: [item(attachBob, "bob에 붙여요", { calls: [] })] }));
    // 순서: 입력 → 취소 → (적용은 꺼져 있어서 건너뜀) → 다시 입력
    await userEvent.tab();
    expect(confirmInput()).toHaveFocus();
    await userEvent.tab();
    expect(cancelButton()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirmInput()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(cancelButton()).toHaveFocus();
  });

  test("only the topmost dialog reacts to Escape", async () => {
    const { props } = setup(preview3());
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
    expect(applyButton()).toBeDisabled();
    fireEvent.click(cancelButton());
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  test("a failed preview shows the error and offers to ask again; there is nothing to apply", () => {
    const { props } = setup(null, { error: { kind: "preview", message: "권한 없음 (iam:GetPolicy)" } });
    expect(screen.getByText("미리보기를 만들지 못했어요")).toBeInTheDocument();
    expect(screen.getByText("권한 없음 (iam:GetPolicy)")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 다시 받기" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  test("when IAM changed after the preview, the backend's refusal asks for a fresh preview", () => {
    const { props } = setup(preview3(), { error: { kind: "apply", message: PLAN_DRIFTED }, stale: true });
    expect(within(screen.getByRole("alert")).getByText(PLAN_DRIFTED)).toBeInTheDocument();
    expect(screen.getByText("적용하지 못했어요")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 다시 받기" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("errors sit next to the buttons, outside the scrolling body, so a long preview cannot hide them", () => {
    setup(preview3(), { error: { kind: "apply", message: "실패했어요" }, stale: true });
    const alert = screen.getByText("실패했어요").closest('[role="alert"]') as HTMLElement;
    expect(alert.closest(".cp-body")).toBeNull();
    expect(screen.getByText("바뀌었을 수 있어서", { exact: false }).closest(".cp-body")).toBeNull();
  });

  test("after a failed apply the focus moves to 미리보기 다시 받기 instead of being lost with the locked buttons", () => {
    const { rerender } = setup(preview3(), { phase: "applying" });
    expect(cancelButton()).toBeDisabled();
    rerender(pendingOf(preview3(), { phase: "ready", error: { kind: "apply", message: "실패" }, stale: true }));
    expect(screen.getByRole("button", { name: "미리보기 다시 받기" })).toHaveFocus();
  });

  test("while applying, the confirm field and the buttons are locked and Escape does nothing", async () => {
    const { props } = setup(confirmPreview(), { phase: "applying" });
    expect(confirmInput()).toBeDisabled();
    expect(screen.getByRole("button", { name: "적용 중…" })).toBeDisabled();
    expect(cancelButton()).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});

describe("a batch that stopped halfway", () => {
  const stop = (extra: Partial<BatchResult> = {}) =>
    batchResult({
      batchId: "batch-7",
      logIds: ["l-1"],
      failed: { index: 1, summary: "ci-bot에 ReadOnlyAccess를 붙여요", message: "권한 없음 (iam:AttachUserPolicy)" },
      ...extra,
    });
  const detachBob: IamChange = { op: "detachPolicy", target: bob.arn, policyArn: readOnlyPolicy.arn };
  const undoButton = (n = 1) => screen.getByRole("button", { name: `적용된 ${n}개 되돌리기` });
  const stopped = (result: BatchResult = stop()) => setup(preview3(), { phase: "result", result });

  test("says how many of the changes were applied, which one stopped the batch and why", () => {
    stopped();
    expect(screen.getByRole("alert")).toHaveTextContent("3개 중 1개를 적용하고 2번째에서 멈췄어요: ci-bot에 ReadOnlyAccess를 붙여요: 권한 없음 (iam:AttachUserPolicy)");
    expect(screen.getByRole("dialog", { name: "변경 3개 미리보기" })).toBeInTheDocument();
  });

  test("offers to undo what was applied or to close; there is nothing left to confirm or apply", () => {
    stopped();
    expect(undoButton()).toBeEnabled();
    expect(screen.getByRole("button", { name: "닫기" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^적용( 중…)?$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "취소" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "변경 목록" })).not.toBeInTheDocument();
  });

  test("the close button, Escape and a first focus all point at 닫기", async () => {
    const { props } = stopped();
    expect(screen.getByRole("button", { name: "닫기" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });

  test("the focus lands on 닫기 when the result replaces the locked buttons of an apply in progress", () => {
    const { rerender } = setup(preview3(), { phase: "applying" });
    rerender(pendingOf(preview3(), { phase: "result", result: stop() }));
    expect(screen.getByRole("button", { name: "닫기" })).toHaveFocus();
  });

  test("the undo button asks for the inverse of the batch and starts it with the ids of the records it undoes", async () => {
    m.undoBatch.mockResolvedValue({ changes: [detachBob], undoOf: ["l-1"] });
    const { props } = stopped();
    fireEvent.click(undoButton());
    await waitFor(() => expect(props.onStart).toHaveBeenCalledTimes(1));
    expect(m.undoBatch).toHaveBeenCalledTimes(1);
    expect(m.undoBatch).toHaveBeenCalledWith("batch-7");
    expect(props.onStart).toHaveBeenCalledWith([detachBob], { undoOf: ["l-1"] });
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  test("while the inverse is being prepared the button is locked, so a double click asks once", async () => {
    const slow = deferred<UndoBatch>();
    m.undoBatch.mockReturnValue(slow.promise);
    const { props } = stopped();
    fireEvent.click(undoButton());
    expect(screen.getByRole("button", { name: "준비 중…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "준비 중…" }));
    expect(m.undoBatch).toHaveBeenCalledTimes(1);
    await act(async () => slow.resolve({ changes: [detachBob], undoOf: ["l-1"] }));
    expect(props.onStart).toHaveBeenCalledTimes(1);
  });

  test("two presses before the screen has redrawn ask once as well", async () => {
    const slow = deferred<UndoBatch>();
    m.undoBatch.mockReturnValue(slow.promise);
    stopped();
    const button = undoButton();
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(m.undoBatch).toHaveBeenCalledTimes(1);
    await act(async () => slow.resolve({ changes: [detachBob], undoOf: ["l-1"] }));
  });

  test("a failing undo shows the error, starts nothing and lets the button be pressed again", async () => {
    m.undoBatch.mockRejectedValueOnce({ kind: "other", message: "되돌릴 변경이 없어요" });
    const { props } = stopped();
    fireEvent.click(undoButton());
    expect(await screen.findByText("되돌릴 변경이 없어요")).toBeInTheDocument();
    expect(props.onStart).not.toHaveBeenCalled();
    expect(undoButton()).toBeEnabled();

    m.undoBatch.mockResolvedValueOnce({ changes: [detachBob], undoOf: ["l-1"] });
    fireEvent.click(undoButton());
    await waitFor(() => expect(props.onStart).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("되돌릴 변경이 없어요")).not.toBeInTheDocument();
  });

  test("closing the dialog while the inverse is being prepared does not start it afterwards", async () => {
    const slow = deferred<UndoBatch>();
    m.undoBatch.mockReturnValue(slow.promise);
    const { props, unmount } = stopped();
    fireEvent.click(undoButton());
    unmount();
    await act(async () => slow.resolve({ changes: [detachBob], undoOf: ["l-1"] }));
    expect(props.onStart).not.toHaveBeenCalled();
  });

  test("with nothing applied there is nothing to undo and no undo button", () => {
    stopped(stop({ logIds: [], failed: { index: 0, summary: "bob에 ReadOnlyAccess를 붙여요", message: "권한 없음 (iam:AttachUserPolicy)" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("3개 중 0개를 적용하고 1번째에서 멈췄어요: bob에 ReadOnlyAccess를 붙여요: 권한 없음 (iam:AttachUserPolicy)");
    expect(screen.queryByRole("button", { name: /되돌리기/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "닫기" })).toBeInTheDocument();
  });

  test("when the log stopped saving, the sentence counts what ran and the button only what can be undone", () => {
    // 두 번째 변경은 적용됐지만 기록되지 않았다. 되돌릴 수 있는 것은 기록된 첫 번째뿐이다
    stopped(stop({ logIds: ["l-1"], failed: { index: 2, summary: "alice에서 ReadOnlyAccess를 떼요", message: "변경 기록을 저장하지 못해서 멈췄어요" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("3개 중 2개를 적용하고 3번째에서 멈췄어요: alice에서 ReadOnlyAccess를 떼요: 변경 기록을 저장하지 못해서 멈췄어요");
    expect(undoButton(1)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "적용된 2개 되돌리기" })).not.toBeInTheDocument();
  });

  test("when nothing was logged at all, even a change that ran cannot be undone from here", () => {
    stopped(stop({ logIds: [], failed: { index: 1, summary: "ci-bot에 ReadOnlyAccess를 붙여요", message: "변경 기록을 저장하지 못해서 멈췄어요" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("3개 중 1개를 적용하고 2번째에서 멈췄어요");
    expect(screen.queryByRole("button", { name: /되돌리기/ })).not.toBeInTheDocument();
  });

  test("the notes from the backend are shown with the result", () => {
    stopped(stop({ notes: ["변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요"] }));
    expect(screen.getByText("변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요")).toBeInTheDocument();
  });

  test("without notes there is no note box", () => {
    stopped();
    expect(screen.queryByTestId("cp-warnings")).not.toBeInTheDocument();
  });
});
