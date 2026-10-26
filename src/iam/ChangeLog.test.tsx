import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { iamApi } from "./api";
import { ChangeLog } from "./ChangeLog";
import { ACCOUNT, activateBobKey, attachReadOnlyToBob, deactivateBobKey, logEntry } from "./fixtures";
import type { ChangeLogEntry, IamChange } from "./types";

vi.mock("./api", () => ({ iamApi: { changeLog: vi.fn(), undoChange: vi.fn() } }));
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
  const props = { onStart: vi.fn() };
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
    const { unmount } = renderWithClient(<ChangeLog profile="prod" accountId={ACCOUNT} onStart={vi.fn()} />);
    expect(screen.getByText("변경 기록을 불러오는 중…")).toBeInTheDocument();
    resolve([]);
    expect(await screen.findByText("변경 기록이 없어요")).toBeInTheDocument();
    unmount();

    m.changeLog.mockRejectedValueOnce({ kind: "network", message: "timeout" });
    m.changeLog.mockResolvedValueOnce([logEntry()]);
    renderWithClient(<ChangeLog profile="prod" accountId={ACCOUNT} onStart={vi.fn()} />);
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
