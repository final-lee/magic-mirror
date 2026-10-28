import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { formatDateTime } from "../iam/format";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { ChangeLog } from "./ChangeLog";
import {
  LOGIN_USER,
  createAppAudit,
  dropAppAudit,
  grantAuditRead,
  pgTarget,
  removeBobFromWriters,
  revokeAuditRead,
  sampleChangeLog,
  sampleLogEntry,
  sampleTargetInfo,
} from "./fixtures";
import type { PgChangeLogEntry, PgUndo } from "./types";

vi.mock("./api", () => ({ pgApi: { changeLog: vi.fn(), undo: vi.fn(), undoBatch: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);
const ARN = sampleTargetInfo().arn;
const OTHER_ARN = "arn:aws:rds:ap-northeast-2:123456789012:cluster:reports-aurora";

function setup(entries: PgChangeLogEntry[], extra: Partial<React.ComponentProps<typeof ChangeLog>> = {}) {
  m.changeLog.mockResolvedValue(entries);
  const props = { onStart: vi.fn(), onStartBatch: vi.fn() };
  const utils = renderWithClient(<ChangeLog target={pgTarget} targetArn={ARN} {...props} {...extra} />);
  return { props, ...utils };
}
const table = () => screen.findByRole("table", { name: "변경 기록" });
const rows = () => within(screen.getByRole("table", { name: "변경 기록" })).getAllByRole("row").slice(1);
const undoButton = (row: HTMLElement) => within(row).getByRole("button", { name: "되돌리기" });

const undoOf = (...ids: string[]): PgUndo => ({ database: "orders", changes: [revokeAuditRead], undoOf: ids });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("list", () => {
  test("shows time, DB user and database, summary and result, in the order the backend sent", async () => {
    setup([sampleLogEntry({ at: "2026-10-29T12:30:00Z" }), sampleLogEntry({ id: "log-0", at: "2026-10-28T12:30:00Z", summary: "그룹에 넣기: bob → app_write", database: "analytics" })]);
    await table();
    expect(rows()).toHaveLength(2);
    const first = within(rows()[0]);
    expect(first.getByText(/2026-10-29/)).toBeInTheDocument();
    expect(first.getByText(LOGIN_USER)).toBeInTheDocument();
    expect(first.getByText("orders")).toBeInTheDocument();
    expect(first.getByText("권한 주기: app_read · audit 스키마의 모든 테이블 SELECT")).toBeInTheDocument();
    expect(first.getByText("성공")).toHaveClass("allowed");
    const second = within(rows()[1]);
    expect(second.getByText("그룹에 넣기: bob → app_write")).toBeInTheDocument();
    expect(second.getByText("analytics")).toBeInTheDocument();
  });

  test("the headers say what each column holds", async () => {
    setup([sampleLogEntry()]);
    await table();
    const heads = within(screen.getByRole("table", { name: "변경 기록" })).getAllByRole("columnheader");
    expect(heads.map((h) => h.textContent)).toEqual(["시각", "DB 사용자 · 데이터베이스", "내용", "결과", "조치"]);
  });

  test("shows only this target's entries, by the ARN", async () => {
    setup([
      sampleLogEntry({ id: "mine", summary: "이 대상의 변경" }),
      sampleLogEntry({ id: "theirs", summary: "다른 대상의 변경", targetArn: OTHER_ARN }),
      sampleLogEntry({ id: "mine-2", summary: "이 대상의 다른 변경" }),
    ]);
    await table();
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining("이 대상의 변경"), expect.stringContaining("이 대상의 다른 변경")]);
    expect(screen.queryByText("다른 대상의 변경")).not.toBeInTheDocument();
  });

  test("a log that only has other targets' entries is empty here", async () => {
    setup([sampleLogEntry({ targetArn: OTHER_ARN })]);
    expect(await screen.findByText("변경 기록이 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "변경 기록" })).not.toBeInTheDocument();
  });

  test("a failed change shows the error and is marked as failed", async () => {
    setup([sampleLogEntry({ ok: false, error: "적용하지 못했어요: permission denied for table events", inverse: null })]);
    await table();
    const row = within(rows()[0]);
    expect(row.getByText("실패")).toHaveClass("denied");
    expect(row.getByText("적용하지 못했어요: permission denied for table events")).toBeInTheDocument();
    expect(row.queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
    expect(row.queryByText("되돌릴 수 없어요")).not.toBeInTheDocument();
  });

  test("marks entries that were undone and entries that are themselves an undo", async () => {
    setup([sampleLogEntry({ id: "log-3", undoOf: "log-1", inverse: [grantAuditRead] }), sampleLogEntry({ undone: true })]);
    await table();
    expect(within(rows()[0]).getByText("되돌리기 기록")).toBeInTheDocument();
    expect(within(rows()[1]).getByText("되돌렸어요")).toBeInTheDocument();
    expect(within(rows()[1]).queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
    expect(within(rows()[0]).queryByText("되돌렸어요")).not.toBeInTheDocument();
  });

  test("shows a loading message and an empty message", async () => {
    let resolve!: (v: PgChangeLogEntry[]) => void;
    m.changeLog.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderWithClient(<ChangeLog target={pgTarget} targetArn={ARN} onStart={vi.fn()} onStartBatch={vi.fn()} />);
    expect(screen.getByText("변경 기록을 불러오는 중…")).toBeInTheDocument();
    resolve([]);
    expect(await screen.findByText("변경 기록이 없어요")).toBeInTheDocument();
  });

  test("a failed read shows the error through PgError, and 다시 시도 reads the log again", async () => {
    m.changeLog.mockRejectedValueOnce({ kind: "network", message: "timeout" });
    m.changeLog.mockResolvedValueOnce([sampleLogEntry()]);
    renderWithClient(<ChangeLog target={pgTarget} targetArn={ARN} onStart={vi.fn()} onStartBatch={vi.fn()} />);
    expect(await screen.findByText("네트워크 오류: timeout")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await table()).toBeInTheDocument();
    expect(m.changeLog).toHaveBeenCalledTimes(2);
  });

  test("the sample log shows every kind of row the screen has", async () => {
    setup(sampleChangeLog());
    await table();
    const texts = rows().map((r) => r.textContent ?? "");
    expect(texts).toHaveLength(7); // 단독 4, 묶음 머리 1, 묶음 안 2
    expect(screen.getByText(/^묶음 · 변경 2개 · /)).toBeInTheDocument();
  });
});

describe("undo", () => {
  test("offers 되돌리기 only for a successful, not yet undone change that has an inverse", async () => {
    setup([
      sampleLogEntry({ id: "a" }),
      sampleLogEntry({ id: "b", undone: true }),
      sampleLogEntry({ id: "c", ok: false, error: "실패", inverse: null }),
      sampleLogEntry({ id: "d", inverse: null, summary: "비밀번호 재설정: alice" }),
      sampleLogEntry({ id: "e", inverse: [], summary: "속성 바꾸기: alice" }),
    ]);
    await table();
    expect(undoButton(rows()[0])).toBeEnabled();
    expect(within(rows()[1]).queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
    expect(within(rows()[2]).queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
    expect(within(rows()[3]).queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
    expect(within(rows()[3]).getByText("되돌릴 수 없어요")).toBeInTheDocument();
  });

  test("an empty inverse cannot be undone either", async () => {
    setup([sampleLogEntry({ inverse: [] })]);
    await table();
    expect(within(rows()[0]).queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
    expect(within(rows()[0]).getByText("되돌릴 수 없어요")).toBeInTheDocument();
  });

  test("a change with one inverse opens the single flow with the entry id as undoOf", async () => {
    m.undo.mockResolvedValue(undoOf("log-1"));
    const { props } = setup([sampleLogEntry()]);
    await table();
    fireEvent.click(undoButton(rows()[0]));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledTimes(1));
    expect(m.undo).toHaveBeenCalledWith("log-1");
    expect(props.onStart).toHaveBeenCalledWith(revokeAuditRead, { undoOf: "log-1" });
    expect(props.onStartBatch).not.toHaveBeenCalled();
  });

  test("a change that takes several changes to undo opens the batch flow in the database of the undo", async () => {
    const undo: PgUndo = { database: "analytics", changes: [revokeAuditRead, dropAppAudit], undoOf: ["log-3"] };
    m.undo.mockResolvedValue(undo);
    const { props } = setup([sampleLogEntry({ id: "log-3", change: createAppAudit, inverse: [revokeAuditRead, dropAppAudit] })]);
    await table();
    fireEvent.click(undoButton(rows()[0]));
    await waitFor(() => expect(props.onStartBatch).toHaveBeenCalledTimes(1));
    expect(m.undo).toHaveBeenCalledWith("log-3");
    expect(props.onStartBatch).toHaveBeenCalledWith("analytics", [revokeAuditRead, dropAppAudit], { undoOf: ["log-3"] });
    expect(props.onStart).not.toHaveBeenCalled();
  });

  test("while the inverse is being prepared the button is locked, so a double click asks once", async () => {
    let resolve!: (v: PgUndo) => void;
    m.undo.mockReturnValue(new Promise((r) => (resolve = r)));
    const { props } = setup([sampleLogEntry()]);
    await table();
    fireEvent.click(undoButton(rows()[0]));
    expect(screen.getByRole("button", { name: "준비 중…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "준비 중…" }));
    expect(m.undo).toHaveBeenCalledTimes(1);
    resolve(undoOf("log-1"));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledTimes(1));
    expect(undoButton(rows()[0])).toBeEnabled();
  });

  test("a failing undo shows the error on that row through PgError, starts nothing, and the button works again", async () => {
    m.undo.mockRejectedValue({ kind: "other", message: "이미 되돌린 변경이에요" });
    const { props } = setup([sampleLogEntry()]);
    await table();
    fireEvent.click(undoButton(rows()[0]));
    const message = await within(rows()[0]).findByText("이미 되돌린 변경이에요");
    expect(message.closest(".error-banner")).not.toBeNull();
    expect(props.onStart).not.toHaveBeenCalled();
    expect(props.onStartBatch).not.toHaveBeenCalled();
    expect(undoButton(rows()[0])).toBeEnabled();
  });

  test("pressing 되돌리기 again clears the old error, and 다시 시도 on the error asks again", async () => {
    m.undo.mockRejectedValueOnce({ kind: "other", message: "변경 기록을 찾을 수 없어요" });
    m.undo.mockResolvedValueOnce(undoOf("log-1"));
    const { props } = setup([sampleLogEntry()]);
    await table();
    fireEvent.click(undoButton(rows()[0]));
    const message = await within(rows()[0]).findByText("변경 기록을 찾을 수 없어요");
    fireEvent.click(within(message.closest(".error-banner") as HTMLElement).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledTimes(1));
    expect(m.undo).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("변경 기록을 찾을 수 없어요")).not.toBeInTheDocument();
  });
});

describe("batches", () => {
  const member = (id: string, extra: Partial<PgChangeLogEntry> = {}) =>
    sampleLogEntry({ id, batchId: "b-1", summary: `${id}: 권한 주기`, inverse: [revokeAuditRead], ...extra });
  const single = (id: string, at: string) => sampleLogEntry({ id, at, summary: `${id} 단독 변경` });
  const headerText = (n: number, at: string) => `묶음 · 변경 ${n}개 · ${formatDateTime(at)}`;
  const headerRow = (text: string | RegExp) => screen.getByText(text).closest("tr") as HTMLElement;
  const batchButton = (head: HTMLElement) => within(head).getByRole("button", { name: "묶음 되돌리기" });
  const rowTexts = () => rows().map((r) => r.textContent ?? "");
  const AT = (hhmm: string) => `2026-10-29T${hhmm}:00Z`;

  test("puts the entries of one batch under a header with their number and the time, and leaves single entries outside it", async () => {
    setup([single("s-1", AT("12:05")), member("m-2", { at: AT("12:03") }), member("m-1", { at: AT("12:01") }), single("s-0", AT("11:00"))]);
    await table();
    const texts = rowTexts();
    expect(texts).toHaveLength(5);
    expect(texts[0]).toContain("s-1 단독 변경");
    expect(texts[1]).toContain(headerText(2, AT("12:03"))); // 묶음에서 가장 최근 기록의 시각
    expect(texts[2]).toContain("m-2");
    expect(texts[3]).toContain("m-1");
    expect(texts[4]).toContain("s-0 단독 변경");
    expect(batchButton(rows()[1])).toBeEnabled();
    expect(within(rows()[0]).queryByRole("button", { name: "묶음 되돌리기" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "묶음 되돌리기" })).toHaveLength(1);
  });

  test("brings the entries of a batch together even when other entries were logged in between", async () => {
    setup([member("m-3", { at: AT("12:09") }), single("s-1", AT("12:08")), member("m-2", { at: AT("12:07") }), member("m-1", { at: AT("12:06") })]);
    await table();
    const texts = rowTexts();
    expect(texts).toHaveLength(5);
    expect(texts[0]).toContain(headerText(3, AT("12:09")));
    expect(texts.slice(1, 4).map((t) => t.match(/m-\d/)?.[0])).toEqual(["m-3", "m-2", "m-1"]);
    expect(texts[4]).toContain("s-1 단독 변경");
  });

  test("two batches get a header each, and each button undoes its own batch", async () => {
    m.undoBatch.mockResolvedValue(undoOf("n-1"));
    const { props } = setup([
      member("m-2", { batchId: "b-1", at: AT("12:09") }),
      member("n-2", { batchId: "b-2", at: AT("12:08") }),
      member("n-1", { batchId: "b-2", at: AT("12:07") }),
      member("m-1", { batchId: "b-1", at: AT("12:06") }),
    ]);
    await table();
    expect(screen.getAllByRole("button", { name: "묶음 되돌리기" })).toHaveLength(2);
    fireEvent.click(batchButton(headerRow(headerText(2, AT("12:08")))));
    await waitFor(() => expect(props.onStartBatch).toHaveBeenCalledTimes(1));
    expect(m.undoBatch).toHaveBeenCalledWith("b-2");
  });

  test("a batch with one entry still has its header", async () => {
    setup([member("m-1", { at: AT("12:01") })]);
    await table();
    expect(screen.getByText(headerText(1, AT("12:01")))).toBeInTheDocument();
  });

  test("[묶음 되돌리기] asks for the inverse of the batch and starts the batch flow with the database and the ids of the records it undoes", async () => {
    const undo: PgUndo = { database: "orders", changes: [removeBobFromWriters, revokeAuditRead], undoOf: ["m-2", "m-1"] };
    m.undoBatch.mockResolvedValue(undo);
    const { props } = setup([member("m-2"), member("m-1")]);
    await table();
    fireEvent.click(screen.getByRole("button", { name: "묶음 되돌리기" }));
    await waitFor(() => expect(props.onStartBatch).toHaveBeenCalledTimes(1));
    expect(m.undoBatch).toHaveBeenCalledTimes(1);
    expect(m.undoBatch).toHaveBeenCalledWith("b-1");
    expect(props.onStartBatch).toHaveBeenCalledWith("orders", undo.changes, { undoOf: ["m-2", "m-1"] });
    expect(props.onStart).not.toHaveBeenCalled();
    expect(m.undo).not.toHaveBeenCalled();
  });

  test("an undo of a whole batch that comes to one change still goes through the batch flow", async () => {
    m.undoBatch.mockResolvedValue(undoOf("m-1"));
    const { props } = setup([member("m-1")]);
    await table();
    fireEvent.click(screen.getByRole("button", { name: "묶음 되돌리기" }));
    await waitFor(() => expect(props.onStartBatch).toHaveBeenCalledTimes(1));
    expect(props.onStart).not.toHaveBeenCalled();
  });

  test("while the inverse is being prepared the button is locked, so a double click asks once", async () => {
    let resolve!: (v: PgUndo) => void;
    m.undoBatch.mockReturnValue(new Promise((r) => (resolve = r)));
    const { props } = setup([member("m-2"), member("m-1")]);
    await table();
    fireEvent.click(screen.getByRole("button", { name: "묶음 되돌리기" }));
    expect(screen.getByRole("button", { name: "준비 중…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "준비 중…" }));
    expect(m.undoBatch).toHaveBeenCalledTimes(1);
    resolve(undoOf("m-1"));
    await waitFor(() => expect(props.onStartBatch).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "묶음 되돌리기" })).toBeEnabled();
  });

  test("while the inverse of a batch is being prepared, pressing another [되돌리기] asks for nothing more", async () => {
    m.undoBatch.mockReturnValue(new Promise(() => {}));
    setup([member("m-2"), member("m-1")]);
    await table();
    fireEvent.click(screen.getByRole("button", { name: "묶음 되돌리기" }));
    fireEvent.click(undoButton(rows()[1]));
    expect(m.undo).not.toHaveBeenCalled();
    expect(m.undoBatch).toHaveBeenCalledTimes(1);
  });

  test("a failing undo shows the error under the header through PgError, starts nothing, and the button works again", async () => {
    m.undoBatch.mockRejectedValue({ kind: "other", message: "되돌릴 수 없는 변경이에요" });
    const { props } = setup([member("m-2"), member("m-1")]);
    await table();
    fireEvent.click(screen.getByRole("button", { name: "묶음 되돌리기" }));
    const head = headerRow(/^묶음 · 변경 2개/);
    const message = await within(head).findByText("되돌릴 수 없는 변경이에요");
    expect(message.closest(".error-banner")).not.toBeNull();
    expect(props.onStartBatch).not.toHaveBeenCalled();
    expect(batchButton(head)).toBeEnabled();
    // 다시 누르면 앞의 오류는 지워진다
    m.undoBatch.mockResolvedValue(undoOf("m-1"));
    fireEvent.click(batchButton(head));
    await waitFor(() => expect(props.onStartBatch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("되돌릴 수 없는 변경이에요")).not.toBeInTheDocument();
  });

  test("when nothing in the batch can be undone any more, the button is off and says why", async () => {
    const { props } = setup([
      member("m-3", { undone: true }),
      member("m-2", { ok: false, error: "적용하지 못했어요: permission denied" }), // 역변경이 남아 있어도 실패한 기록은 되돌릴 것이 아니다
      member("m-1", { inverse: null, summary: "m-1: 비밀번호 재설정" }),
    ]);
    await table();
    const head = headerRow(/^묶음 · 변경 3개/);
    expect(batchButton(head)).toBeDisabled();
    expect(within(head).getByText("되돌릴 변경이 없어요")).toBeInTheDocument();
    fireEvent.click(batchButton(head));
    expect(m.undoBatch).not.toHaveBeenCalled();
    expect(props.onStartBatch).not.toHaveBeenCalled();
  });

  test("a batch that was only partly undone can still be undone for the rest", async () => {
    setup([member("m-2", { undone: true }), member("m-1")]);
    await table();
    const head = headerRow(/^묶음 · 변경 2개/);
    expect(batchButton(head)).toBeEnabled();
    expect(within(head).queryByText("되돌릴 변경이 없어요")).not.toBeInTheDocument();
  });

  test("the entries inside a batch keep their own [되돌리기], which starts the single flow", async () => {
    m.undo.mockResolvedValue(undoOf("m-2"));
    const { props } = setup([member("m-2", { at: AT("12:03") }), member("m-1", { at: AT("12:01") })]);
    await table();
    fireEvent.click(undoButton(rows()[1])); // rows()[0]은 묶음 머리, 그다음이 첫 기록
    await waitFor(() => expect(props.onStart).toHaveBeenCalledTimes(1));
    expect(m.undo).toHaveBeenCalledWith("m-2");
    expect(props.onStart).toHaveBeenCalledWith(revokeAuditRead, { undoOf: "m-2" });
    expect(props.onStartBatch).not.toHaveBeenCalled();
  });

  test("a batch member of another target is not part of this batch's header", async () => {
    setup([member("m-2", { targetArn: OTHER_ARN }), member("m-1")]);
    await table();
    expect(screen.getByText(/^묶음 · 변경 1개 · /)).toBeInTheDocument();
    expect(screen.queryByText(/m-2/)).not.toBeInTheDocument();
  });
});
