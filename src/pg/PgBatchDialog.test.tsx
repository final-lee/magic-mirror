import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { addBobToWriters, defaultAuditRead, grantAuditRead, pgTarget, sampleBatchPreview } from "./fixtures";
import { PgBatchDialog } from "./PgBatchDialog";
import type { PgBatchPreview } from "./types";
import type { PendingPgBatch } from "./usePgBatch";

// 영향 줄을 그릴 때마다 객체 종류 이름을 읽는다. 읽은 횟수로 미리보기 본문을 다시 그렸는지 본다(값은 그대로 돌려준다)
const labelReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("./labels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./labels")>();
  const OBJECT_KIND_LABEL = new Proxy(actual.OBJECT_KIND_LABEL, {
    get(target, key, receiver) {
      labelReads.count++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { ...actual, OBJECT_KIND_LABEL };
});

const BATCH_CONFIRM = "변경 2개 적용";
const CHANGES = [grantAuditRead, addBobToWriters];

function pendingOf(preview: PgBatchPreview | null, extra: Partial<PendingPgBatch> = {}): PendingPgBatch {
  return { target: pgTarget, database: "orders", changes: CHANGES, undoOf: null, rev: 1, phase: "ready", preview, error: null, stale: false, ...extra };
}

function setup(preview: PgBatchPreview | null, extra: Partial<PendingPgBatch> = {}, props: { onAddDefaults?: (c: PgBatchPreview["items"][number]["change"][]) => void } = {}) {
  const handlers = { onApply: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn() };
  const utils = render(<PgBatchDialog pending={pendingOf(preview, extra)} {...handlers} {...props} />);
  const rerender = (next: PendingPgBatch) => utils.rerender(<PgBatchDialog pending={next} {...handlers} {...props} />);
  return { props: handlers, ...utils, rerender };
}

const clean = (extra: Partial<PgBatchPreview> = {}) => {
  const base = sampleBatchPreview();
  return sampleBatchPreview({ items: base.items.map((i) => ({ ...i, warnings: [] })), warnings: [], ...extra });
};
const confirmBatch = (extra: Partial<PgBatchPreview> = {}) =>
  clean({ warnings: [{ level: "confirm", message: "모든 역할(PUBLIC)에 권한을 줘요", add: [] }], confirmText: BATCH_CONFIRM, ...extra });
const applyButton = () => screen.getByRole("button", { name: /^적용/ });
const cancelButton = () => screen.getByRole("button", { name: "취소" });
const confirmInput = () => screen.getByLabelText(`확인하려면 ${BATCH_CONFIRM}을 입력하세요`);

describe("content", () => {
  test("the title counts the changes, and the DB user is named right under it", () => {
    setup(sampleBatchPreview({ loginUser: "ops_admin" }));
    const dialog = screen.getByRole("dialog", { name: "변경 2개" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("heading", { name: "변경 2개" })).toBeInTheDocument();
    expect(dialog.querySelector("h3")?.nextElementSibling).toBe(screen.getByText("적용할 DB 사용자: ops_admin"));
  });

  test("while loading the title counts the changes it was started with", () => {
    setup(null, { phase: "loading", changes: [grantAuditRead, addBobToWriters, defaultAuditRead] });
    expect(screen.getByRole("dialog", { name: "변경 3개" })).toBeInTheDocument();
    expect(screen.getByText("미리보기를 불러오는 중이에요…")).toBeInTheDocument();
    expect(screen.queryByText(/적용할 DB 사용자/)).not.toBeInTheDocument();
  });

  test("an undo is labelled as one", () => {
    setup(sampleBatchPreview(), { undoOf: ["b-1-2", "b-1-1"] });
    expect(screen.getByRole("dialog", { name: "되돌리기 미리보기" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "변경 2개" })).not.toBeInTheDocument();
  });

  test("lists the changes in run order, numbered, each with its summary", () => {
    setup(sampleBatchPreview());
    const rows = Array.from(screen.getByRole("list", { name: "변경 목록" }).children) as HTMLElement[]; // 경고도 목록 항목이라 한 줄 안에 또 있다
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("1")).toBeInTheDocument();
    expect(within(rows[0]).getByText("권한 주기: app_read · audit 스키마의 모든 테이블 SELECT")).toBeInTheDocument();
    expect(within(rows[1]).getByText("2")).toBeInTheDocument();
    expect(within(rows[1]).getByText("그룹에 넣기: bob → app_write")).toBeInTheDocument();
  });

  test("shows the SQL of the whole batch in run order, numbered, then the effects", () => {
    setup(sampleBatchPreview());
    const rows = within(screen.getByRole("list", { name: "실행할 SQL" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(['1GRANT SELECT ON ALL TABLES IN SCHEMA "audit" TO "app_read"', '2GRANT "app_write" TO "bob"']);
    expect(within(rows[1]).getByText('GRANT "app_write" TO "bob"')).toHaveClass("mono");
    expect(within(screen.getByTestId("role-bob")).getByText("들어가는 그룹: app_write")).toBeInTheDocument();
    expect(within(screen.getByTestId("impact-alice")).getByText("audit · 테이블 1개 SELECT")).toBeInTheDocument();
  });

  test("shows the sections in order: the batch's warnings, the changes, the SQL, the effects, whether it can be undone, the confirm field, the buttons", () => {
    setup(confirmBatch({ warnings: [{ level: "confirm", message: "묶음 전체에 거는 확인", add: [] }] }));
    const marks = [
      screen.getByText("묶음 전체에 거는 확인"),
      screen.getByRole("list", { name: "변경 목록" }),
      screen.getByRole("heading", { name: "실행할 SQL" }),
      screen.getByRole("heading", { name: "영향" }),
      screen.getByText("되돌릴 수 있어요"),
      confirmInput(),
      cancelButton(),
      applyButton(),
    ];
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i - 1].compareDocumentPosition(marks[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    }
  });

  test("says clearly when the batch cannot be undone", () => {
    setup(sampleBatchPreview({ reversible: false }));
    expect(screen.getByText("되돌릴 수 없어요")).toBeInTheDocument();
  });
});

describe("warnings", () => {
  test("a change's own warning is shown under that change", () => {
    setup(sampleBatchPreview());
    const rows = Array.from(screen.getByRole("list", { name: "변경 목록" }).children) as HTMLElement[];
    expect(within(rows[0]).getByText("새로 만드는 테이블에는 적용되지 않아요")).toBeInTheDocument();
    expect(within(rows[1]).queryByTestId("cp-warnings")).not.toBeInTheDocument();
  });

  test("the warnings of the whole batch come before the list of changes", () => {
    setup(sampleBatchPreview({ warnings: [{ level: "warn", message: "묶음에 거는 주의", add: [] }] }));
    const warning = screen.getByText("묶음에 거는 주의");
    expect(warning.compareDocumentPosition(screen.getByRole("list", { name: "변경 목록" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("기본 권한도 담기 is offered from a change's warning, or from the batch's, only when the dialog can add", () => {
    const onAddDefaults = vi.fn();
    const { unmount } = setup(sampleBatchPreview(), {}, { onAddDefaults });
    fireEvent.click(screen.getByRole("button", { name: "기본 권한도 담기" }));
    expect(onAddDefaults).toHaveBeenCalledWith([defaultAuditRead]);
    unmount();

    const again = vi.fn();
    setup(sampleBatchPreview({ warnings: [{ level: "warn", message: "새로 만드는 테이블에는 적용되지 않아요", add: [defaultAuditRead] }] }), {}, { onAddDefaults: again });
    const batchLevel = within(screen.getAllByTestId("cp-warnings")[0]);
    fireEvent.click(batchLevel.getByRole("button", { name: "기본 권한도 담기" }));
    expect(again).toHaveBeenCalledWith([defaultAuditRead]);
  });

  test("without onAddDefaults there is no button", () => {
    setup(sampleBatchPreview());
    expect(screen.queryByRole("button", { name: "기본 권한도 담기" })).not.toBeInTheDocument();
  });
});

describe("applying", () => {
  test("a clean batch can be applied with one click, in the primary style", () => {
    const { props } = setup(clean());
    expect(applyButton()).toBeEnabled();
    expect(applyButton()).toHaveClass("primary");
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledWith("");
  });

  test("a warn warning in one change turns the apply into the danger style but keeps it enabled", () => {
    const { props } = setup(sampleBatchPreview());
    expect(applyButton()).toBeEnabled();
    expect(applyButton()).toHaveClass("danger");
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledTimes(1);
  });

  test("a block in any one change disables the apply and explains why", () => {
    const base = clean();
    const { props } = setup({ ...base, items: [base.items[0], { ...base.items[1], warnings: [{ level: "block", message: "이 시스템 역할에는 구성원을 넣거나 뺄 수 없어요: pg_monitor", add: [] }] }] });
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("막힘 경고가 있어서 적용할 수 없어요")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("이 시스템 역할에는 구성원을 넣거나 뺄 수 없어요: pg_monitor");
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("a block of the batch itself disables the apply even with the text typed", () => {
    const { props } = setup(confirmBatch({ warnings: [{ level: "block", message: "한 번에 50개까지 적용할 수 있어요", add: [] }] }));
    fireEvent.change(confirmInput(), { target: { value: BATCH_CONFIRM } });
    expect(applyButton()).toBeDisabled();
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();
  });
});

describe("type to confirm", () => {
  test("asks for 변경 N개 적용 and keeps the apply disabled until it matches exactly", () => {
    const { props } = setup(confirmBatch());
    expect(applyButton()).toBeDisabled();
    for (const wrong of ["변경 2개", "변경 2개 적용 ", " 변경 2개 적용", "변경 3개 적용"]) {
      fireEvent.change(confirmInput(), { target: { value: wrong } });
      expect(applyButton()).toBeDisabled();
    }
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();
    fireEvent.change(confirmInput(), { target: { value: BATCH_CONFIRM } });
    expect(applyButton()).toBeEnabled();
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledWith(BATCH_CONFIRM);
  });

  test("the hint says the text differs, not the name", () => {
    setup(confirmBatch());
    fireEvent.change(confirmInput(), { target: { value: "변경 9" } });
    expect(screen.getByText("입력한 문구가 달라요")).toBeInTheDocument();
    expect(screen.queryByText("입력한 이름이 달라요")).not.toBeInTheDocument();
  });

  test("a confirm warning inside one change, with no text to type, cannot be applied", () => {
    const base = clean({ confirmText: null });
    const { props } = setup({ ...base, items: [{ ...base.items[0], warnings: [{ level: "confirm", message: "확인하세요", add: [] }] }, base.items[1]] });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("확인 문구를 받지 못해서 적용할 수 없어요")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("Enter in the field never applies", () => {
    const { props } = setup(confirmBatch());
    fireEvent.change(confirmInput(), { target: { value: BATCH_CONFIRM } });
    fireEvent.keyDown(confirmInput(), { key: "Enter" });
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("what was typed is dropped when a fresh preview arrives", () => {
    const { rerender } = setup(confirmBatch());
    fireEvent.change(confirmInput(), { target: { value: BATCH_CONFIRM } });
    expect(applyButton()).toBeEnabled();
    rerender(pendingOf(confirmBatch(), { rev: 2 }));
    expect(confirmInput()).toHaveValue("");
    expect(applyButton()).toBeDisabled();
  });

  test("typing the confirm text does not redraw the preview body", () => {
    labelReads.count = 0;
    setup(confirmBatch());
    const drawn = labelReads.count;
    expect(drawn).toBeGreaterThanOrEqual(3);
    for (const value of ["변", "변경", BATCH_CONFIRM]) fireEvent.change(confirmInput(), { target: { value } });
    expect(applyButton()).toBeEnabled();
    expect(labelReads.count).toBe(drawn);
  });
});

describe("keyboard and focus", () => {
  test("the focus starts on 취소, never on the apply, and Escape cancels", async () => {
    const { props } = setup(confirmBatch());
    expect(cancelButton()).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  test("Enter on the focused 취소 cancels instead of applying", async () => {
    const { props } = setup(clean());
    await userEvent.keyboard("{Enter}");
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("Tab stays inside the dialog", async () => {
    setup(confirmBatch());
    await userEvent.tab();
    expect(confirmInput()).toHaveFocus();
    await userEvent.tab();
    expect(cancelButton()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirmInput()).toHaveFocus();
  });
});

describe("loading, errors and progress", () => {
  test("while the preview loads, only cancel works", () => {
    const { props } = setup(null, { phase: "loading" });
    expect(applyButton()).toBeDisabled();
    fireEvent.click(cancelButton());
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  test("a failed preview shows the error and offers to ask again", () => {
    const { props } = setup(null, { error: { kind: "preview", message: "이 데이터베이스에서는 바꿀 수 없어요: rdsadmin" } });
    expect(screen.getByText("이 데이터베이스에서는 바꿀 수 없어요: rdsadmin")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 다시 받기" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  test("a failed apply keeps the preview, shows the error, and needs a fresh preview", () => {
    const { props } = setup(sampleBatchPreview(), { error: { kind: "apply", message: "적용하지 못했어요: permission denied for table events" }, stale: true });
    expect(screen.getByText("적용하지 못했어요: permission denied for table events")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "변경 목록" })).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 다시 받기" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  test("after a failed apply the focus moves to 미리보기 다시 받기", () => {
    const { rerender } = setup(sampleBatchPreview(), { phase: "applying" });
    expect(cancelButton()).toBeDisabled();
    rerender(pendingOf(sampleBatchPreview(), { phase: "ready", error: { kind: "apply", message: "실패" }, stale: true }));
    expect(screen.getByRole("button", { name: "미리보기 다시 받기" })).toHaveFocus();
  });

  test("while applying, the buttons and the confirm field are locked and Escape does nothing", async () => {
    const { props } = setup(confirmBatch(), { phase: "applying" });
    expect(screen.getByRole("button", { name: "적용 중…" })).toBeDisabled();
    expect(cancelButton()).toBeDisabled();
    expect(confirmInput()).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});
