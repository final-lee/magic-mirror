import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { iamApi } from "./api";
import { ChangeLog } from "./ChangeLog";
import { ACCOUNT, activateBobKey, attachReadOnlyToBob, bob, deactivateBobKey, logEntry, readOnlyPolicy } from "./fixtures";
import { formatDateTime } from "./format";
import type { ChangeLogEntry, IamChange, UndoBatch } from "./types";

vi.mock("./api", () => ({ iamApi: { changeLog: vi.fn(), undoChange: vi.fn(), undoBatch: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(iamApi);

const reactivate: IamChange = activateBobKey;
const attached = logEntry({
  id: "log-2",
  at: "2026-10-25T12:00:00Z",
  change: attachReadOnlyToBob,
  summary: "bob에 ReadOnlyAccess를 붙였어요",
  inverse: { op: "detachPolicy", target: attachReadOnlyToBob.op === "attachPolicy" ? attachReadOnlyToBob.target : "", policyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess" },
});

function setup(entries: ChangeLogEntry[], extra: Partial<React.ComponentProps<typeof ChangeLog>> = {}) {
  m.changeLog.mockResolvedValue(entries);
  const props = { onStart: vi.fn(), onStartBatch: vi.fn() };
  const utils = renderWithClient(<ChangeLog profile="prod" accountId={ACCOUNT} {...props} {...extra} />);
  return { props, ...utils };
}
const rows = () => within(screen.getByRole("table", { name: "변경 기록" })).getAllByRole("row").slice(1);
const undoButton = (row: HTMLElement) => within(row).getByRole("button", { name: "되돌리기" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("list", () => {
  test("shows time, profile and account, summary and result, in the order the backend sent", async () => {
    setup([logEntry(), attached]);
    await screen.findByRole("table", { name: "변경 기록" });
    expect(rows()).toHaveLength(2);
    const first = within(rows()[0]);
    expect(first.getByText(/2026-10-26/)).toBeInTheDocument();
    expect(first.getByText("prod")).toBeInTheDocument();
    expect(first.getByText(ACCOUNT)).toBeInTheDocument();
    expect(first.getByText("bob의 액세스 키 AKIAIOSFODNN7EXAMPLE를 비활성화했어요")).toBeInTheDocument();
    expect(first.getByText("성공")).toHaveClass("allowed");
    expect(within(rows()[1]).getByText("bob에 ReadOnlyAccess를 붙였어요")).toBeInTheDocument();
  });

  test("a failed change shows the error and is marked as failed", async () => {
    setup([logEntry({ ok: false, error: "권한 없음 (iam:UpdateAccessKey)", inverse: null })]);
    await screen.findByRole("table", { name: "변경 기록" });
    const row = within(rows()[0]);
    expect(row.getByText("실패")).toHaveClass("denied");
    expect(row.getByText("권한 없음 (iam:UpdateAccessKey)")).toBeInTheDocument();
    expect(row.queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
    expect(row.queryByText("되돌릴 수 없어요")).not.toBeInTheDocument();
  });

  test("marks entries that were undone and entries that are themselves an undo", async () => {
    setup([logEntry({ id: "log-3", undoOf: "log-1", inverse: deactivateBobKey }), logEntry({ undone: true })]);
    await screen.findByRole("table", { name: "변경 기록" });
    expect(within(rows()[0]).getByText("되돌리기 기록")).toBeInTheDocument();
    expect(within(rows()[1]).getByText("되돌림")).toBeInTheDocument();
    expect(within(rows()[1]).queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
  });

  test("shows a loading message, an empty message, and the error with a retry", async () => {
    let resolve!: (v: ChangeLogEntry[]) => void;
    m.changeLog.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { unmount } = renderWithClient(<ChangeLog profile="prod" accountId={ACCOUNT} onStart={vi.fn()} onStartBatch={vi.fn()} />);
    expect(screen.getByText("변경 기록을 불러오는 중…")).toBeInTheDocument();
    resolve([]);
    expect(await screen.findByText("변경 기록이 없어요")).toBeInTheDocument();
    unmount();

    m.changeLog.mockRejectedValueOnce({ kind: "network", message: "timeout" });
    m.changeLog.mockResolvedValueOnce([logEntry()]);
    renderWithClient(<ChangeLog profile="prod" accountId={ACCOUNT} onStart={vi.fn()} onStartBatch={vi.fn()} />);
    expect(await screen.findByText("네트워크 오류: timeout")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("table", { name: "변경 기록" })).toBeInTheDocument();
  });
});

describe("undo", () => {
  test("offers 되돌리기 only for a successful, not yet undone change that has an inverse", async () => {
    setup([
      logEntry({ id: "a" }),
      logEntry({ id: "b", undone: true }),
      logEntry({ id: "c", ok: false, error: "실패", inverse: null }),
      logEntry({ id: "d", inverse: null, summary: "키를 삭제했어요" }),
    ]);
    await screen.findByRole("table", { name: "변경 기록" });
    expect(within(rows()[0]).getByRole("button", { name: "되돌리기" })).toBeEnabled();
    expect(within(rows()[1]).queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
    expect(within(rows()[2]).queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
    expect(within(rows()[3]).queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
    expect(within(rows()[3]).getByText("되돌릴 수 없어요")).toBeInTheDocument();
  });

  test("asks the backend for the inverse and starts the change flow with the entry id as undoOf", async () => {
    m.undoChange.mockResolvedValue(reactivate);
    const { props } = setup([logEntry()]);
    await screen.findByRole("table", { name: "변경 기록" });
    fireEvent.click(undoButton(rows()[0]));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledTimes(1));
    expect(m.undoChange).toHaveBeenCalledWith("log-1");
    expect(props.onStart).toHaveBeenCalledWith(reactivate, { undoOf: "log-1" });
  });

  test("while the inverse is being prepared the button is locked, so a double click asks once", async () => {
    let resolve!: (v: IamChange) => void;
    m.undoChange.mockReturnValue(new Promise((r) => (resolve = r)));
    const { props } = setup([logEntry()]);
    await screen.findByRole("table", { name: "변경 기록" });
    fireEvent.click(undoButton(rows()[0]));
    expect(screen.getByRole("button", { name: "준비 중…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "준비 중…" }));
    expect(m.undoChange).toHaveBeenCalledTimes(1);
    resolve(reactivate);
    await waitFor(() => expect(props.onStart).toHaveBeenCalledTimes(1));
    expect(undoButton(rows()[0])).toBeEnabled();
  });

  test("a failing undo shows the error on that row and nothing is started", async () => {
    m.undoChange.mockRejectedValue({ kind: "other", message: "이미 되돌린 기록이에요" });
    const { props } = setup([logEntry()]);
    await screen.findByRole("table", { name: "변경 기록" });
    fireEvent.click(undoButton(rows()[0]));
    expect(await within(rows()[0]).findByText("이미 되돌린 기록이에요")).toBeInTheDocument();
    expect(props.onStart).not.toHaveBeenCalled();
    expect(undoButton(rows()[0])).toBeEnabled();
  });

  test("a change made in another account cannot be undone from here, and the reason is shown", async () => {
    m.undoChange.mockResolvedValue(reactivate);
    const { props } = setup([logEntry({ accountId: "999988887777", profile: "other" })]);
    await screen.findByRole("table", { name: "변경 기록" });
    const button = undoButton(rows()[0]);
    expect(button).toBeDisabled();
    expect(within(rows()[0]).getByText("다른 계정(999988887777)에서 한 변경이라 그 계정으로 열어야 되돌릴 수 있어요")).toBeInTheDocument();
    fireEvent.click(button);
    expect(m.undoChange).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
  });
});

describe("batches", () => {
  const detachBob: IamChange = { op: "detachPolicy", target: bob.arn, policyArn: readOnlyPolicy.arn };
  /** 묶음 b-1로 적용한 변경 하나의 기록 */
  const member = (id: string, extra: Partial<ChangeLogEntry> = {}) =>
    logEntry({ id, batchId: "b-1", change: attachReadOnlyToBob, summary: `${id}: bob에 ReadOnlyAccess를 붙였어요`, calls: ["iam:AttachUserPolicy"], inverse: detachBob, ...extra });
  const single = (id: string, at: string) => logEntry({ id, at, summary: `${id} 단독 변경` });
  const headerText = (n: number, at: string) => `묶음 · 변경 ${n}개 · ${formatDateTime(at)}`;
  const headerRow = (text: string | RegExp) => screen.getByText(text).closest("tr") as HTMLElement;
  const batchButton = (head: HTMLElement) => within(head).getByRole("button", { name: "묶음 되돌리기" });
  const rowTexts = () => rows().map((r) => r.textContent ?? "");
  const AT = (hhmm: string) => `2026-10-26T${hhmm}:00Z`;

  test("puts the entries of one batch under a header with their number and the time, and leaves single entries outside it", async () => {
    setup([single("s-1", AT("12:05")), member("m-2", { at: AT("12:03") }), member("m-1", { at: AT("12:01") }), single("s-0", AT("11:00"))]);
    await screen.findByRole("table", { name: "변경 기록" });
    const texts = rowTexts();
    expect(texts).toHaveLength(5);
    expect(texts[0]).toContain("s-1 단독 변경");
    expect(texts[1]).toContain(headerText(2, AT("12:03"))); // 묶음에서 가장 최근 기록의 시각
    expect(texts[2]).toContain("m-2");
    expect(texts[3]).toContain("m-1");
    expect(texts[4]).toContain("s-0 단독 변경");
    expect(batchButton(rows()[1])).toBeEnabled();
    // 단독 변경에는 머리도 [묶음 되돌리기]도 없다
    expect(within(rows()[0]).queryByRole("button", { name: "묶음 되돌리기" })).not.toBeInTheDocument();
    expect(within(rows()[4]).queryByRole("button", { name: "묶음 되돌리기" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "묶음 되돌리기" })).toHaveLength(1);
  });

  test("brings the entries of a batch together even when other entries were logged in between", async () => {
    setup([member("m-3", { at: AT("12:09") }), single("s-1", AT("12:08")), member("m-2", { at: AT("12:07") }), member("m-1", { at: AT("12:06") })]);
    await screen.findByRole("table", { name: "변경 기록" });
    const texts = rowTexts();
    expect(texts).toHaveLength(5);
    expect(texts[0]).toContain(headerText(3, AT("12:09")));
    expect(texts[1]).toContain("m-3");
    expect(texts[2]).toContain("m-2");
    expect(texts[3]).toContain("m-1");
    expect(texts[4]).toContain("s-1 단독 변경");
  });

  test("two batches get a header each, and each button undoes its own batch", async () => {
    m.undoBatch.mockResolvedValue({ changes: [detachBob], undoOf: ["n-1"] });
    const { props } = setup([
      member("m-2", { batchId: "b-1", at: AT("12:09") }),
      member("n-2", { batchId: "b-2", at: AT("12:08") }),
      member("n-1", { batchId: "b-2", at: AT("12:07") }),
      member("m-1", { batchId: "b-1", at: AT("12:06") }),
    ]);
    await screen.findByRole("table", { name: "변경 기록" });
    expect(screen.getAllByRole("button", { name: "묶음 되돌리기" })).toHaveLength(2);
    fireEvent.click(batchButton(headerRow(headerText(2, AT("12:08")))));
    await waitFor(() => expect(props.onStartBatch).toHaveBeenCalledTimes(1));
    expect(m.undoBatch).toHaveBeenCalledWith("b-2");
  });

  test("a batch with one entry still has its header", async () => {
    setup([member("m-1", { at: AT("12:01") })]);
    await screen.findByRole("table", { name: "변경 기록" });
    expect(screen.getByText(headerText(1, AT("12:01")))).toBeInTheDocument();
  });

  test("[묶음 되돌리기] asks for the inverse of the batch and starts the batch flow with the ids of the records it undoes", async () => {
    const undo: UndoBatch = { changes: [detachBob, { ...detachBob, target: `${bob.arn}x` }], undoOf: ["m-2", "m-1"] };
    m.undoBatch.mockResolvedValue(undo);
    const { props } = setup([member("m-2"), member("m-1")]);
    await screen.findByRole("table", { name: "변경 기록" });
    fireEvent.click(screen.getByRole("button", { name: "묶음 되돌리기" }));
    await waitFor(() => expect(props.onStartBatch).toHaveBeenCalledTimes(1));
    expect(m.undoBatch).toHaveBeenCalledTimes(1);
    expect(m.undoBatch).toHaveBeenCalledWith("b-1");
    expect(props.onStartBatch).toHaveBeenCalledWith(undo.changes, { undoOf: undo.undoOf });
    expect(props.onStart).not.toHaveBeenCalled();
    expect(m.undoChange).not.toHaveBeenCalled();
  });

  test("while the inverse is being prepared the button is locked, so a double click asks once", async () => {
    let resolve!: (v: UndoBatch) => void;
    m.undoBatch.mockReturnValue(new Promise((r) => (resolve = r)));
    const { props } = setup([member("m-2"), member("m-1")]);
    await screen.findByRole("table", { name: "변경 기록" });
    fireEvent.click(screen.getByRole("button", { name: "묶음 되돌리기" }));
    expect(screen.getByRole("button", { name: "준비 중…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "준비 중…" }));
    expect(m.undoBatch).toHaveBeenCalledTimes(1);
    resolve({ changes: [detachBob], undoOf: ["m-1"] });
    await waitFor(() => expect(props.onStartBatch).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "묶음 되돌리기" })).toBeEnabled();
  });

  test("while the inverse of a batch is being prepared, pressing another [되돌리기] asks for nothing more", async () => {
    m.undoBatch.mockReturnValue(new Promise(() => {}));
    setup([member("m-2"), member("m-1")]);
    await screen.findByRole("table", { name: "변경 기록" });
    fireEvent.click(screen.getByRole("button", { name: "묶음 되돌리기" }));
    fireEvent.click(undoButton(rows()[1]));
    expect(m.undoChange).not.toHaveBeenCalled();
    expect(m.undoBatch).toHaveBeenCalledTimes(1);
  });

  test("a failing undo shows the error under the header, starts nothing, and the button works again", async () => {
    m.undoBatch.mockRejectedValue({ kind: "other", message: "되돌릴 기록과 변경의 수가 맞지 않아요" });
    const { props } = setup([member("m-2"), member("m-1")]);
    await screen.findByRole("table", { name: "변경 기록" });
    fireEvent.click(screen.getByRole("button", { name: "묶음 되돌리기" }));
    const head = headerRow(/^묶음 · 변경 2개/);
    expect(await within(head).findByText("되돌릴 기록과 변경의 수가 맞지 않아요")).toBeInTheDocument();
    expect(props.onStartBatch).not.toHaveBeenCalled();
    expect(batchButton(head)).toBeEnabled();
    // 다시 누르면 앞의 오류는 지워진다
    m.undoBatch.mockResolvedValue({ changes: [detachBob], undoOf: ["m-1"] });
    fireEvent.click(batchButton(head));
    await waitFor(() => expect(props.onStartBatch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("되돌릴 기록과 변경의 수가 맞지 않아요")).not.toBeInTheDocument();
  });

  test("when nothing in the batch can be undone any more, the button is off and says why", async () => {
    const { props } = setup([
      member("m-3", { undone: true }),
      member("m-2", { ok: false, error: "권한 없음 (iam:AttachUserPolicy)" }), // 역변경이 남아 있어도 실패한 기록은 되돌릴 것이 아니다
      member("m-1", { inverse: null, summary: "m-1: 키를 삭제했어요" }),
    ]);
    await screen.findByRole("table", { name: "변경 기록" });
    const head = headerRow(/^묶음 · 변경 3개/);
    expect(batchButton(head)).toBeDisabled();
    expect(within(head).getByText("되돌릴 변경이 없어요")).toBeInTheDocument();
    fireEvent.click(batchButton(head));
    expect(m.undoBatch).not.toHaveBeenCalled();
    expect(props.onStartBatch).not.toHaveBeenCalled();
  });

  test("a batch made in another account cannot be undone from here, and the reason is the one single entries give", async () => {
    const other = { accountId: "999988887777", profile: "other" };
    const { props } = setup([member("m-2", other), member("m-1", other)]);
    await screen.findByRole("table", { name: "변경 기록" });
    const head = headerRow(/^묶음 · 변경 2개/);
    expect(batchButton(head)).toBeDisabled();
    expect(within(head).getByText("다른 계정(999988887777)에서 한 변경이라 그 계정으로 열어야 되돌릴 수 있어요")).toBeInTheDocument();
    fireEvent.click(batchButton(head));
    expect(m.undoBatch).not.toHaveBeenCalled();
    expect(props.onStartBatch).not.toHaveBeenCalled();
  });

  test("a single record from another account is enough to keep the batch from being undone here", async () => {
    setup([member("m-2"), member("m-1", { accountId: "999988887777", profile: "other" })]);
    await screen.findByRole("table", { name: "변경 기록" });
    const head = headerRow(/^묶음 · 변경 2개/);
    expect(batchButton(head)).toBeDisabled();
    expect(within(head).getByText("다른 계정(999988887777)에서 한 변경이라 그 계정으로 열어야 되돌릴 수 있어요")).toBeInTheDocument();
  });

  test("when nothing is left to undo, that is the reason given, whichever account the batch was made in", async () => {
    const other = { accountId: "999988887777", profile: "other", undone: true };
    setup([member("m-2", other), member("m-1", other)]);
    await screen.findByRole("table", { name: "변경 기록" });
    const head = headerRow(/^묶음 · 변경 2개/);
    expect(within(head).getByText("되돌릴 변경이 없어요")).toBeInTheDocument();
    expect(within(head).queryByText(/다른 계정/)).not.toBeInTheDocument();
  });

  test("a batch that was only partly undone can still be undone for the rest", async () => {
    setup([member("m-2", { undone: true }), member("m-1")]);
    await screen.findByRole("table", { name: "변경 기록" });
    const head = headerRow(/^묶음 · 변경 2개/);
    expect(batchButton(head)).toBeEnabled();
    expect(within(head).queryByText("되돌릴 변경이 없어요")).not.toBeInTheDocument();
  });

  test("the entries inside a batch keep their own [되돌리기], which starts the single flow", async () => {
    m.undoChange.mockResolvedValue(detachBob);
    const { props } = setup([member("m-2", { at: AT("12:03") }), member("m-1", { at: AT("12:01") })]);
    await screen.findByRole("table", { name: "변경 기록" });
    fireEvent.click(undoButton(rows()[1])); // rows()[0]은 묶음 머리, 그다음이 첫 기록
    await waitFor(() => expect(props.onStart).toHaveBeenCalledTimes(1));
    expect(m.undoChange).toHaveBeenCalledWith("m-2");
    expect(props.onStart).toHaveBeenCalledWith(detachBob, { undoOf: "m-2" });
    expect(props.onStartBatch).not.toHaveBeenCalled();
  });
});
