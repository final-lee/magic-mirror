import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { addBobToWriters, createCarol, defaultAuditRead, grantAuditRead, pgTarget, samplePreview } from "./fixtures";
import { PgChangeDialog } from "./PgChangeDialog";
import type { PgPreview } from "./types";
import type { PendingPgChange } from "./usePgChange";

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

const NEW_PASSWORD = "Xk3pQ9mZtR7vNb2WcH5yJd4a";
const SUMMARY = "권한 주기: app_read · audit 스키마의 모든 테이블 SELECT";

function pendingOf(preview: PgPreview | null, extra: Partial<PendingPgChange> = {}): PendingPgChange {
  return {
    target: pgTarget,
    change: preview?.change ?? grantAuditRead,
    undoOf: null,
    rev: 1,
    phase: "ready",
    preview,
    error: null,
    stale: false,
    password: null,
    ...extra,
  };
}

function setup(preview: PgPreview | null, extra: Partial<PendingPgChange> = {}, props: { onAddDefaults?: (c: PgPreview["change"][]) => void } = {}) {
  const handlers = { onApply: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn() };
  const utils = render(<PgChangeDialog pending={pendingOf(preview, extra)} {...handlers} {...props} />);
  const rerender = (next: PendingPgChange) => utils.rerender(<PgChangeDialog pending={next} {...handlers} {...props} />);
  return { props: handlers, ...utils, rerender };
}

const clean = (extra: Partial<PgPreview> = {}) => samplePreview({ warnings: [], ...extra });
const applyButton = () => screen.getByRole("button", { name: /^적용/ });
const cancelButton = () => screen.getByRole("button", { name: "취소" });
const confirmInput = (name: string) => screen.getByLabelText(`확인하려면 ${name}를 입력하세요`);
const confirmPreview = (extra: Partial<PgPreview> = {}) =>
  samplePreview({ warnings: [{ level: "confirm", message: "모든 역할(PUBLIC)에 권한을 줘요", add: [] }], confirmText: "app_read", ...extra });

describe("content", () => {
  test("the title is the summary of the change", () => {
    setup(samplePreview());
    const dialog = screen.getByRole("dialog", { name: SUMMARY });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("heading", { name: SUMMARY })).toBeInTheDocument();
  });

  test("names the DB user the change runs as, right under the title", () => {
    setup(samplePreview({ loginUser: "ops_admin" }));
    const heading = screen.getByRole("heading", { name: SUMMARY });
    const user = screen.getByText("적용할 DB 사용자: ops_admin");
    expect(heading.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("dialog").querySelector("h3")?.nextElementSibling).toBe(user);
  });

  test("while the preview is loading the title is the summary the app builds itself, and there is no DB user yet", () => {
    setup(null, { phase: "loading", change: addBobToWriters });
    expect(screen.getByRole("dialog", { name: "그룹에 넣기: bob → app_write" })).toBeInTheDocument();
    expect(screen.queryByText(/적용할 DB 사용자/)).not.toBeInTheDocument();
  });

  test("an undo is labelled as one, and still says what it does", () => {
    setup(samplePreview({ summary: "권한 빼기: app_read · audit 스키마의 모든 테이블 SELECT" }), { undoOf: "log-1" });
    expect(screen.getByRole("dialog", { name: "되돌리기 미리보기" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "되돌리기 미리보기" })).toBeInTheDocument();
    expect(screen.getByText("권한 빼기: app_read · audit 스키마의 모든 테이블 SELECT")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: SUMMARY })).not.toBeInTheDocument();
  });

  test("shows the sections in order: warnings, the SQL, the effects, whether it can be undone, the confirm field, the buttons", () => {
    setup(confirmPreview({ warnings: [{ level: "confirm", message: "모든 역할(PUBLIC)에 권한을 줘요", add: [] }] }));
    const marks = [
      screen.getByText("모든 역할(PUBLIC)에 권한을 줘요"),
      screen.getByRole("heading", { name: "실행할 SQL" }),
      screen.getByRole("heading", { name: "영향" }),
      screen.getByText("되돌릴 수 있어요"),
      confirmInput("app_read"),
      cancelButton(),
      applyButton(),
    ];
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i - 1].compareDocumentPosition(marks[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    }
  });

  test("the statements are numbered, in monospace, and the password stays masked", () => {
    setup(samplePreview({ change: createCarol, sql: [`CREATE ROLE "carol" LOGIN PASSWORD '••••••••'`, 'GRANT "app_read" TO "carol"'] }));
    const rows = within(screen.getByRole("list", { name: "실행할 SQL" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("1")).toBeInTheDocument();
    expect(within(rows[1]).getByText("2")).toBeInTheDocument();
    expect(within(rows[0]).getByText(`CREATE ROLE "carol" LOGIN PASSWORD '••••••••'`)).toHaveClass("mono");
  });

  test("says clearly when the change cannot be undone", () => {
    setup(samplePreview({ reversible: false }));
    expect(screen.getByText("되돌릴 수 없어요")).toBeInTheDocument();
    expect(screen.queryByText("되돌릴 수 있어요")).not.toBeInTheDocument();
  });

  test("shows the effects: who gains what, with the 얻는 권한 lines", () => {
    setup(samplePreview());
    const alice = screen.getByTestId("impact-alice");
    expect(within(alice).getByText("audit · 테이블 1개 SELECT")).toBeInTheDocument();
    expect(within(alice).getByText("audit.events")).toBeInTheDocument();
  });
});

describe("기본 권한도 담기", () => {
  test("a warning that carries a default privilege change offers it when the dialog was given somewhere to put it", () => {
    const onAddDefaults = vi.fn();
    setup(samplePreview(), {}, { onAddDefaults });
    fireEvent.click(screen.getByRole("button", { name: "기본 권한도 담기" }));
    expect(onAddDefaults).toHaveBeenCalledTimes(1);
    expect(onAddDefaults).toHaveBeenCalledWith([defaultAuditRead]);
  });

  test("without onAddDefaults the warning is only text", () => {
    setup(samplePreview());
    expect(screen.getByText("새로 만드는 테이블에는 적용되지 않아요")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "기본 권한도 담기" })).not.toBeInTheDocument();
  });

  test("a warning with nothing to add has no button even when the dialog could add", () => {
    setup(samplePreview({ warnings: [{ level: "warn", message: "이미 그 상태라 달라지는 게 없어요", add: [] }] }), {}, { onAddDefaults: vi.fn() });
    expect(screen.queryByRole("button", { name: "기본 권한도 담기" })).not.toBeInTheDocument();
  });

  test("the button does not apply anything or close the dialog by itself", () => {
    const { props } = setup(samplePreview(), {}, { onAddDefaults: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "기본 권한도 담기" }));
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});

describe("warnings", () => {
  test("groups warnings by level: blocking first, then confirm, then warn", () => {
    setup(
      samplePreview({
        warnings: [
          { level: "warn", message: "이 사용자는 rds_iam 구성원이라 비밀번호로는 로그인하지 못해요", add: [] },
          { level: "block", message: "시스템 역할이라 바꿀 수 없어요: rds_superuser", add: [] },
          { level: "confirm", message: "rds_superuser를 주면 대부분의 관리 작업을 할 수 있게 돼요", add: [] },
        ],
        confirmText: "bob",
      }),
    );
    expect(screen.getAllByTestId("cp-warnings").map((g) => g.getAttribute("data-level"))).toEqual(["block", "confirm", "warn"]);
    expect(screen.getByRole("alert")).toHaveTextContent("시스템 역할이라 바꿀 수 없어요: rds_superuser");
  });

  test("a preview without warnings shows no warning area and no confirm field", () => {
    setup(clean());
    expect(screen.queryByTestId("cp-warnings")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("applying", () => {
  test("a clean preview can be applied with one click, in the primary style", () => {
    const { props } = setup(clean());
    expect(applyButton()).toBeEnabled();
    expect(applyButton()).toHaveClass("primary");
    expect(applyButton()).not.toHaveClass("danger");
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledWith("");
  });

  test("a warn warning keeps the apply enabled but turns it into the danger style", () => {
    const { props } = setup(samplePreview());
    expect(applyButton()).toBeEnabled();
    expect(applyButton()).toHaveClass("danger");
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledTimes(1);
  });

  test("a block warning disables the apply, explains why, and ignores clicks", () => {
    const { props } = setup(samplePreview({ warnings: [{ level: "block", message: "시스템 역할이라 바꿀 수 없어요: rds_superuser", add: [] }] }));
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("막힘 경고가 있어서 적용할 수 없어요")).toBeInTheDocument();
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("a block warning stays disabled even with the confirm text typed correctly", () => {
    const { props } = setup(
      samplePreview({
        warnings: [
          { level: "block", message: "막혔어요", add: [] },
          { level: "confirm", message: "확인하세요", add: [] },
        ],
        confirmText: "app_read",
      }),
    );
    fireEvent.change(confirmInput("app_read"), { target: { value: "app_read" } });
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
    const input = confirmInput("app_read");
    for (const wrong of ["a", "App_read", "APP_READ", "app_read ", " app_read", "app_readd", "alice"]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(applyButton()).toBeDisabled();
    }
    fireEvent.click(applyButton());
    expect(props.onApply).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "app_read" } });
    expect(applyButton()).toBeEnabled();
    fireEvent.click(applyButton());
    expect(props.onApply).toHaveBeenCalledTimes(1);
    expect(props.onApply).toHaveBeenCalledWith("app_read");
  });

  test("hints when what was typed differs, but not before anything was typed or while a correct start is being typed", () => {
    setup(confirmPreview());
    const hint = () => screen.queryByText("입력한 이름이 달라요");
    expect(hint()).not.toBeInTheDocument();
    fireEvent.change(confirmInput("app_read"), { target: { value: "app" } });
    expect(hint()).not.toBeInTheDocument();
    for (const wrong of ["apx", "App", " a", "app_readd"]) {
      fireEvent.change(confirmInput("app_read"), { target: { value: wrong } });
      expect(hint()).toBeInTheDocument();
    }
    fireEvent.change(confirmInput("app_read"), { target: { value: "app_read" } });
    expect(hint()).not.toBeInTheDocument();
  });

  test("Enter in the field never applies, not even with the right text", () => {
    const { props } = setup(confirmPreview());
    const input = confirmInput("app_read");
    fireEvent.change(input, { target: { value: "app_read" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  test("a confirm text with no confirm warning still has to be typed", () => {
    const { props } = setup(samplePreview({ warnings: [], confirmText: "app_read" }));
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
    fireEvent.change(confirmInput("app_read"), { target: { value: "app_read" } });
    expect(applyButton()).toBeEnabled();
    rerender(pendingOf(confirmPreview(), { rev: 2 }));
    expect(confirmInput("app_read")).toHaveValue("");
    expect(applyButton()).toBeDisabled();
  });

  test("typing the confirm text does not redraw the preview body", () => {
    labelReads.count = 0;
    setup(confirmPreview());
    const drawn = labelReads.count;
    expect(drawn).toBeGreaterThanOrEqual(3); // 영향 줄 셋을 한 번은 그렸다
    for (const value of ["a", "ap", "app_read"]) fireEvent.change(confirmInput("app_read"), { target: { value } });
    expect(applyButton()).toBeEnabled();
    expect(labelReads.count).toBe(drawn);
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
    const { props } = setup(clean());
    await userEvent.keyboard("{Enter}");
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("Tab stays inside the dialog", async () => {
    setup(confirmPreview());
    // 순서: 입력 → 취소 → (적용은 꺼져 있어서 건너뜀) → 다시 입력
    await userEvent.tab();
    expect(confirmInput("app_read")).toHaveFocus();
    await userEvent.tab();
    expect(cancelButton()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirmInput("app_read")).toHaveFocus();
    await userEvent.tab({ shift: true }); // 맨 앞에서 거꾸로 가면 마지막(취소)으로 돈다
    expect(cancelButton()).toHaveFocus();
  });

  test("a dialog inside a hidden tab does not react to Escape, and a hidden dialog does not shadow a visible one", () => {
    const { props } = setup(clean());
    const hiddenCancel = vi.fn();
    const hiddenHost = render(
      <div hidden>
        <PgChangeDialog pending={pendingOf(clean())} onApply={vi.fn()} onRetry={vi.fn()} onCancel={hiddenCancel} />
      </div>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(hiddenCancel).not.toHaveBeenCalled();
    hiddenHost.unmount();
  });

  test("only the topmost dialog reacts to Escape", async () => {
    const { props } = setup(clean());
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
    const { props } = setup(null, { error: { kind: "preview", message: "이 데이터베이스에서는 바꿀 수 없어요: rdsadmin" } });
    expect(screen.getByText("이 데이터베이스에서는 바꿀 수 없어요: rdsadmin")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 다시 받기" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  test("when the database changed after the preview, the refusal asks for a fresh preview", () => {
    const STALE = "미리보기 뒤에 바뀌었어요. 미리보기를 다시 받아 주세요";
    const { props } = setup(samplePreview(), { error: { kind: "apply", message: STALE }, stale: true });
    expect(within(screen.getByRole("alert")).getByText(STALE)).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 다시 받기" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  test("a failed apply keeps the preview, shows the error, and needs a fresh preview before applying again", () => {
    const { props } = setup(samplePreview(), { error: { kind: "apply", message: "적용하지 못했어요: permission denied for table events" }, stale: true });
    expect(screen.getByText("적용하지 못했어요: permission denied for table events")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: SUMMARY })).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText(/상태가 바뀌었을 수 있어서/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 다시 받기" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  test("errors sit next to the buttons, outside the scrolling body, so a long preview cannot hide them", () => {
    setup(samplePreview(), { error: { kind: "apply", message: "실패했어요" }, stale: true });
    const alert = screen.getByText("실패했어요").closest('[role="alert"]') as HTMLElement;
    expect(alert.closest(".cp-body")).toBeNull();
    expect(screen.getByText("바뀌었을 수 있어서", { exact: false }).closest(".cp-body")).toBeNull();
  });

  test("after a failed apply the focus moves to 미리보기 다시 받기 instead of being lost with the locked buttons", () => {
    const { rerender } = setup(samplePreview(), { phase: "applying" });
    expect(cancelButton()).toBeDisabled();
    rerender(pendingOf(samplePreview(), { phase: "ready", error: { kind: "apply", message: "실패" }, stale: true }));
    expect(screen.getByRole("button", { name: "미리보기 다시 받기" })).toHaveFocus();
  });

  test("while applying, the confirm field is locked too", () => {
    setup(confirmPreview(), { phase: "applying" });
    expect(confirmInput("app_read")).toBeDisabled();
  });

  test("while applying, the buttons are locked and Escape does nothing", async () => {
    const { props } = setup(samplePreview(), { phase: "applying" });
    expect(screen.getByRole("button", { name: "적용 중…" })).toBeDisabled();
    expect(cancelButton()).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});

describe("the password phase", () => {
  const withPassword = (extra: Partial<PendingPgChange> = {}) =>
    setup(samplePreview({ change: createCarol, summary: "역할 만들기: carol" }), { phase: "password", change: createCarol, password: NEW_PASSWORD, ...extra });

  test("replaces the preview with the new password: the title, the password, the note and the two buttons", () => {
    withPassword();
    const dialog = screen.getByRole("dialog", { name: "새 비밀번호" });
    expect(within(dialog).getByRole("heading", { name: "새 비밀번호" })).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue(NEW_PASSWORD)).toHaveAttribute("readonly");
    expect(within(dialog).getByText("이 창을 닫으면 다시 볼 수 없어요")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "복사" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "닫기" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "실행할 SQL" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^적용/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "취소" })).not.toBeInTheDocument();
  });

  test("says whose password it is", () => {
    withPassword();
    expect(screen.getByText("역할 만들기: carol")).toBeInTheDocument();
  });

  test("닫기 closes the flow, and so does Escape: there is no way back to the password", async () => {
    const { props } = withPassword();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });

  test("the focus lands on 복사, not on the button that throws the password away", () => {
    withPassword();
    expect(screen.getByRole("button", { name: "복사" })).toHaveFocus();
  });

  test("Tab stays inside the dialog", async () => {
    withPassword();
    expect(screen.getByRole("button", { name: "복사" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "닫기" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByDisplayValue(NEW_PASSWORD)).toHaveFocus();
  });

  test("no other phase puts a password in the page", () => {
    const { container } = setup(samplePreview(), { phase: "ready", password: null });
    expect(container.innerHTML).not.toContain(NEW_PASSWORD);
    expect(screen.queryByRole("heading", { name: "새 비밀번호" })).not.toBeInTheDocument();
  });

  test("a preview of a change that will make a password shows the mask, never a password", () => {
    const { container } = setup(samplePreview({ change: createCarol, sql: [`CREATE ROLE "carol" LOGIN PASSWORD '••••••••'`] }));
    expect(screen.getByText(`CREATE ROLE "carol" LOGIN PASSWORD '••••••••'`)).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(NEW_PASSWORD);
  });
});

test("an add-defaults handler is not asked for anything while the password is shown", () => {
  const onAddDefaults = vi.fn();
  setup(samplePreview(), { phase: "password", password: NEW_PASSWORD }, { onAddDefaults });
  expect(screen.queryByRole("button", { name: "기본 권한도 담기" })).not.toBeInTheDocument();
  expect(onAddDefaults).not.toHaveBeenCalled();
});
