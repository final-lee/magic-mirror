import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { desktop } from "../api/desktop";
import { pgApi } from "./api";
import { createCarol, pgTarget, sampleOverview, samplePreview } from "./fixtures";
import { PasswordResult } from "./PasswordResult";
import { PgChangeDialog } from "./PgChangeDialog";
import { usePgChange } from "./usePgChange";

vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));
vi.mock("./api", () => ({ pgApi: { preview: vi.fn(), apply: vi.fn(), overview: vi.fn(), database: vi.fn(), role: vi.fn(), changeLog: vi.fn() } }));

const NEW_PASSWORD = "Xk3pQ9mZtR7vNb2WcH5yJd4a";
const copy = vi.mocked(desktop.copy);
const m = vi.mocked(pgApi);

beforeEach(() => {
  vi.clearAllMocks();
  copy.mockResolvedValue(undefined);
});

describe("PasswordResult", () => {
  const show = (extra: Partial<React.ComponentProps<typeof PasswordResult>> = {}) => {
    const onClose = vi.fn();
    const utils = render(<PasswordResult password={NEW_PASSWORD} onClose={onClose} {...extra} />);
    return { onClose, ...utils };
  };

  test("shows the title, the password in a read-only field, the note and the two buttons", () => {
    show();
    expect(screen.getByRole("heading", { name: "새 비밀번호" })).toBeInTheDocument();
    const field = screen.getByLabelText("새 비밀번호");
    expect(field).toHaveValue(NEW_PASSWORD);
    expect(field).toHaveAttribute("readonly");
    expect(field).toHaveAttribute("type", "text");
    expect(screen.getByText("이 창을 닫으면 다시 볼 수 없어요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "복사" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "닫기" })).toBeInTheDocument();
  });

  test("names the change the password belongs to, when it is told", () => {
    show({ summary: "비밀번호 재설정: alice" });
    expect(screen.getByText("비밀번호 재설정: alice")).toBeInTheDocument();
  });

  test("복사 copies the password through the clipboard and then says 복사했어요", async () => {
    show();
    expect(screen.queryByText("복사했어요")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "복사" }));
    });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith(NEW_PASSWORD);
    expect(screen.getByText("복사했어요")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("복사했어요");
  });

  test("nothing says 복사했어요 until the clipboard has taken it", async () => {
    let finish!: () => void;
    copy.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    show();
    fireEvent.click(screen.getByRole("button", { name: "복사" }));
    expect(screen.queryByText("복사했어요")).not.toBeInTheDocument();
    await act(async () => finish());
    expect(screen.getByText("복사했어요")).toBeInTheDocument();
  });

  test("a clipboard that refuses is not reported as copied, and the password can still be taken from the field", async () => {
    copy.mockRejectedValueOnce(new Error("clipboard unavailable"));
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "복사" }));
    });
    expect(screen.queryByText("복사했어요")).not.toBeInTheDocument();
    expect(screen.getByText("복사하지 못했어요")).toBeInTheDocument();
    expect(screen.getByLabelText("새 비밀번호")).toHaveValue(NEW_PASSWORD);
  });

  test("a second try after a refusal can succeed", async () => {
    copy.mockRejectedValueOnce(new Error("busy"));
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "복사" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "복사" }));
    });
    expect(screen.getByText("복사했어요")).toBeInTheDocument();
    expect(screen.queryByText("복사하지 못했어요")).not.toBeInTheDocument();
  });

  test("닫기 closes", () => {
    const { onClose } = show();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("the focus starts on 복사, and clicking into the field selects the whole password", async () => {
    show();
    expect(screen.getByRole("button", { name: "복사" })).toHaveFocus();
    const field = screen.getByLabelText("새 비밀번호") as HTMLInputElement;
    await userEvent.click(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(NEW_PASSWORD.length);
  });

  test("closing a copied result still closes: copying changes nothing about the note", async () => {
    const { onClose } = show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "복사" }));
    });
    expect(screen.getByText("이 창을 닫으면 다시 볼 수 없어요")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// 흐름 전체: 적용 → 비밀번호 단계 → 복사 → 닫기. 닫으면 화면, 흐름의 상태, 쿼리 캐시 어디에도 비밀번호가 없다.
describe("the password through the whole flow", () => {
  let latest: ReturnType<typeof usePgChange>;
  let client: QueryClient;

  function Harness() {
    const flow = usePgChange(pgTarget);
    latest = flow;
    return (
      <>
        <button onClick={() => flow.start(createCarol)}>시작</button>
        {flow.pending && <PgChangeDialog pending={flow.pending} onApply={flow.apply} onRetry={flow.retryPreview} onCancel={flow.cancel} />}
        <output aria-label="알림">{flow.notices.map((n) => `${n.summary}${n.notes.join("")}`).join("|")}</output>
      </>
    );
  }

  function openPasswordPhase() {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "시작" }));
  }

  /** 비밀번호가 화면, 흐름의 상태와 안내, 쿼리 캐시, 변경 캐시 어디에 있는가 */
  const whereIsIt = () => ({
    dom: document.body.textContent?.includes(NEW_PASSWORD) || screen.queryByDisplayValue(NEW_PASSWORD) !== null,
    state: JSON.stringify({ pending: latest.pending, notices: latest.notices }).includes(NEW_PASSWORD),
    queries: JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data)).includes(NEW_PASSWORD),
    mutations: JSON.stringify(client.getMutationCache().getAll().map((x) => x.state)).includes(NEW_PASSWORD),
  });

  beforeEach(() => {
    m.preview.mockImplementation(async (_t, change) => samplePreview({ change, summary: "역할 만들기: carol", sql: [`CREATE ROLE "carol" LOGIN PASSWORD '••••••••'`], warnings: [] }));
    m.apply.mockResolvedValue({ logId: "log-10", summary: "역할 만들기: carol", password: NEW_PASSWORD });
    m.overview.mockResolvedValue(sampleOverview());
    m.database.mockResolvedValue(undefined as never);
    m.changeLog.mockResolvedValue([]);
  });

  async function reachPasswordPhase() {
    openPasswordPhase();
    fireEvent.click(await screen.findByRole("button", { name: "적용" }));
    await screen.findByRole("heading", { name: "새 비밀번호" });
  }

  test("before the apply, no password exists anywhere", async () => {
    openPasswordPhase();
    await screen.findByRole("button", { name: "적용" });
    expect(whereIsIt()).toEqual({ dom: false, state: false, queries: false, mutations: false });
  });

  test("applying a change that makes a password swaps the preview for the new password", async () => {
    await reachPasswordPhase();
    expect(screen.getByDisplayValue(NEW_PASSWORD)).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "적용" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "실행할 SQL" })).not.toBeInTheDocument();
    expect(latest.pending?.phase).toBe("password");
  });

  test("while it is shown, only the screen and the pending state have it: the notice and the caches do not", async () => {
    await reachPasswordPhase();
    await waitFor(() => expect(m.overview).toHaveBeenCalled());
    expect(screen.getByLabelText("알림")).toHaveTextContent("역할 만들기: carol");
    expect(whereIsIt()).toEqual({ dom: true, state: true, queries: false, mutations: false });
    // 알림에는 없다: 상태 안에서도 pending에만 있다
    expect(JSON.stringify(latest.notices)).not.toContain(NEW_PASSWORD);
  });

  test("copying puts it on the clipboard and says so, and the password stays shown", async () => {
    await reachPasswordPhase();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "복사" }));
    });
    expect(copy).toHaveBeenCalledWith(NEW_PASSWORD);
    expect(screen.getByText("복사했어요")).toBeInTheDocument();
    expect(screen.getByDisplayValue(NEW_PASSWORD)).toBeInTheDocument();
  });

  test("after 닫기 the password is gone from the page, from the hook state and from the query cache", async () => {
    await reachPasswordPhase();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(latest.pending).toBeNull();
    expect(whereIsIt()).toEqual({ dom: false, state: false, queries: false, mutations: false });
    await act(async () => {}); // 적용 뒤에 돌던 다시 읽기가 끝난 뒤에도
    expect(whereIsIt()).toEqual({ dom: false, state: false, queries: false, mutations: false });
  });

  test("Escape closes it the same way", async () => {
    await reachPasswordPhase();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(whereIsIt()).toEqual({ dom: false, state: false, queries: false, mutations: false });
  });

  test("the next change starts clean: nothing of the old password is in its dialog", async () => {
    await reachPasswordPhase();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "시작" }));
    await screen.findByRole("button", { name: "적용" });
    expect(whereIsIt().dom).toBe(false);
    expect(screen.queryByText("복사했어요")).not.toBeInTheDocument();
  });
});
